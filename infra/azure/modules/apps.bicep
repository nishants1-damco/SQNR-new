// Azure Container Apps (plan §15): the API (min 2 replicas, HTTP scaling),
// the worker (KEDA scaling on the BullMQ wait list), and the migration job.
// The environment's managed OpenTelemetry agent receives the apps' OTLP data
// (it sets OTEL_EXPORTER_OTLP_ENDPOINT in each container) and forwards traces
// and metrics to Application Insights.
param prefix string
param location string
param tags object
param production bool
param deployEnv string
param imageTag string
param registryServer string
param appsSubnetId string
param logsCustomerId string
@secure()
param logsSharedKey string
@secure()
param insightsConnectionString string
param apiIdentityId string
param apiClientId string
param workerIdentityId string
param workerClientId string
param vaultUri string
param blobEndpoint string
param webOrigins array
param appBaseUrl string
param mailFrom string
param redisQueueHost string
param llm object
param limits object
@description('Front Door profile id: the API refuses requests without it in X-Azure-FDID.')
param frontDoorId string

resource env 'Microsoft.App/managedEnvironments@2024-10-02-preview' = {
  name: '${prefix}-env'
  location: location
  tags: tags
  properties: {
    vnetConfiguration: { infrastructureSubnetId: appsSubnetId, internal: false }
    zoneRedundant: production
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: { customerId: logsCustomerId, sharedKey: logsSharedKey }
    }
    appInsightsConfiguration: { connectionString: insightsConnectionString }
    openTelemetryConfiguration: {
      tracesConfiguration: { destinations: ['appInsights'] }
      logsConfiguration: { destinations: ['appInsights'] }
      metricsConfiguration: { destinations: [] }
    }
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}

// Secrets live in Key Vault; each app reads them with its own identity.
func kvSecret(vault string, name string, identity string) object => {
  name: name
  keyVaultUrl: '${vault}secrets/${name}'
  identity: identity
}

var common = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'DEPLOY_ENV', value: deployEnv }
  { name: 'APP_VERSION', value: imageTag }
  { name: 'LOG_LEVEL', value: 'info' }
  { name: 'QUEUE_PREFIX', value: 'spatial' }
  { name: 'BLOB_ACCOUNT_URL', value: blobEndpoint }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'REDIS_QUEUE_URL', secretRef: 'redis-queue-url' }
  { name: 'ANTHROPIC_MODEL', value: llm.model }
]

resource api 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-api'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${apiIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'http'
        allowInsecure: false
      }
      registries: [{ server: registryServer, identity: apiIdentityId }]
      secrets: [
        kvSecret(vaultUri, 'database-url', apiIdentityId)
        kvSecret(vaultUri, 'database-replica-url', apiIdentityId)
        kvSecret(vaultUri, 'redis-queue-url', apiIdentityId)
        kvSecret(vaultUri, 'redis-cache-url', apiIdentityId)
        kvSecret(vaultUri, 'jwt-private-key', apiIdentityId)
        kvSecret(vaultUri, 'jwt-key-id', apiIdentityId)
        kvSecret(vaultUri, 'smtp-url', apiIdentityId)
      ]
    }
    template: {
      containers: [
        {
          name: 'api'
          image: '${registryServer}/spatial-api:${imageTag}'
          resources: { cpu: json('1.0'), memory: '2Gi' }
          env: concat(common, [
            { name: 'PORT', value: '3000' }
            // Front Door appends the client's address to X-Forwarded-For, then
            // the Container Apps ingress appends Front Door's: trust those two.
            { name: 'TRUST_PROXY', value: '2' }
            { name: 'FRONT_DOOR_ID', value: frontDoorId }
            // Tracing every request cost ~20% of API throughput in load tests.
            { name: 'OTEL_TRACES_SAMPLER', value: 'parentbased_traceidratio' }
            { name: 'OTEL_TRACES_SAMPLER_ARG', value: production ? '0.1' : '1.0' }
            { name: 'AZURE_CLIENT_ID', value: apiClientId }
            { name: 'DATABASE_REPLICA_URL', secretRef: 'database-replica-url' }
            { name: 'REDIS_CACHE_URL', secretRef: 'redis-cache-url' }
            { name: 'JWT_PRIVATE_KEY', secretRef: 'jwt-private-key' }
            { name: 'JWT_KEY_ID', secretRef: 'jwt-key-id' }
            { name: 'SMTP_URL', secretRef: 'smtp-url' }
            { name: 'MAIL_FROM', value: mailFrom }
            { name: 'WEB_ORIGINS', value: join(webOrigins, ',') }
            { name: 'APP_BASE_URL', value: appBaseUrl }
            { name: 'AI_DAILY_BUDGET_USD_PER_USER', value: string(limits.perUserDailyUsd) }
            { name: 'AI_DAILY_BUDGET_USD_GLOBAL', value: string(limits.globalDailyUsd) }
            { name: 'ANALYSIS_MAX_QUEUED', value: string(limits.maxQueued) }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 3000 }
              periodSeconds: 10
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 3000 }
              periodSeconds: 5
              failureThreshold: 3
            }
          ]
        }
      ]
      scale: {
        minReplicas: production ? 2 : 1
        maxReplicas: production ? 20 : 4
        rules: [{ name: 'http', http: { metadata: { concurrentRequests: '80' } } }]
      }
    }
  }
}

resource worker 'Microsoft.App/containerApps@2024-03-01' = {
  name: '${prefix}-worker'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${workerIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      activeRevisionsMode: 'Single'
      registries: [{ server: registryServer, identity: workerIdentityId }]
      secrets: [
        kvSecret(vaultUri, 'database-url', workerIdentityId)
        kvSecret(vaultUri, 'redis-queue-url', workerIdentityId)
        kvSecret(vaultUri, 'redis-queue-key', workerIdentityId)
        kvSecret(vaultUri, 'anthropic-api-key', workerIdentityId)
      ]
    }
    template: {
      containers: [
        {
          name: 'worker'
          image: '${registryServer}/spatial-worker:${imageTag}'
          // The pipeline decodes JPEGs and holds large prompts in memory.
          resources: { cpu: json('2.0'), memory: '4Gi' }
          env: concat(common, [
            { name: 'HEALTH_PORT', value: '3100' }
            { name: 'AZURE_CLIENT_ID', value: workerClientId }
            { name: 'ANTHROPIC_API_KEY', secretRef: 'anthropic-api-key' }
            { name: 'ANTHROPIC_FALLBACK_MODEL', value: llm.fallbackModel }
            { name: 'LLM_PERMITS_CLAUDE', value: string(llm.permits) }
            { name: 'LLM_RPM_LIMIT', value: string(llm.rpm) }
            { name: 'LLM_ITPM_LIMIT', value: string(llm.itpm) }
            { name: 'LLM_OTPM_LIMIT', value: string(llm.otpm) }
            { name: 'ANALYSIS_CLOUD_CONCURRENCY', value: '3' }
          ])
          probes: [
            {
              type: 'Liveness'
              httpGet: { path: '/health/live', port: 3100 }
              periodSeconds: 15
            }
            {
              type: 'Readiness'
              httpGet: { path: '/health/ready', port: 3100 }
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: 1
        maxReplicas: production ? 40 : 4
        rules: [
          {
            // Scale on analyses waiting for a worker (BullMQ's wait list).
            name: 'analysis-queue'
            custom: {
              type: 'redis'
              metadata: {
                address: '${redisQueueHost}:6380'
                listName: 'spatial:analysis-cloud:wait'
                listLength: '2'
                enableTLS: 'true'
              }
              auth: [{ secretRef: 'redis-queue-key', triggerParameter: 'password' }]
            }
          }
        ]
      }
    }
  }
}

// Migrations run as a separate job with the schema-owner role, before the
// new revision takes traffic (plan §15). Triggered by the deploy workflow.
resource migrate 'Microsoft.App/jobs@2024-03-01' = {
  name: '${prefix}-migrate'
  location: location
  tags: tags
  identity: { type: 'UserAssigned', userAssignedIdentities: { '${apiIdentityId}': {} } }
  properties: {
    environmentId: env.id
    workloadProfileName: 'Consumption'
    configuration: {
      triggerType: 'Manual'
      replicaTimeout: 1800
      replicaRetryLimit: 0
      manualTriggerConfig: { parallelism: 1, replicaCompletionCount: 1 }
      registries: [{ server: registryServer, identity: apiIdentityId }]
      secrets: [kvSecret(vaultUri, 'database-migrator-url', apiIdentityId)]
    }
    template: {
      containers: [
        {
          name: 'migrate'
          image: '${registryServer}/spatial-api:${imageTag}'
          command: ['node', 'node_modules/@spatial/db/dist/migrate.js']
          resources: { cpu: json('0.5'), memory: '1Gi' }
          env: [
            { name: 'NODE_ENV', value: 'production' }
            { name: 'DATABASE_MIGRATOR_URL', secretRef: 'database-migrator-url' }
          ]
        }
      ]
    }
  }
}

output apiFqdn string = api.properties.configuration.ingress.fqdn
output apiName string = api.name
output workerName string = worker.name
output migrateJobName string = migrate.name
output environmentId string = env.id
