// Spatial Capture on Azure (plan §15): one resource group per environment.
//   az deployment group create -g <rg> -f infra/azure/main.bicep -p infra/azure/staging.bicepparam
// See infra/azure/README.md for the first deployment (secrets, database bootstrap).
targetScope = 'resourceGroup'

@allowed(['staging', 'production'])
param environmentName string
param location string = resourceGroup().location
@description('Static Web Apps is offered in fewer regions than the rest.')
param webLocation string = 'westeurope'
@description('Short name prefix for resources, e.g. sqnr-stg.')
param prefix string
@description('Image tag built by CI (the git SHA).')
param imageTag string
@description('Origins the web app is served from, e.g. https://app.example.com.')
param webOrigins array
param appBaseUrl string
param mailFrom string
param alertEmail string
@description('False on the very first deployment, before the secrets the apps need exist in Key Vault.')
param deployApps bool = true

@secure()
param postgresAdminPassword string
@secure()
param appRwPassword string
@secure()
param appMigratorPassword string

@description('Claude settings; limits at 85% of what Anthropic granted (plan §9.7.6).')
param llm object = {
  model: 'claude-opus-5-5'
  fallbackModel: 'claude-sonnet-5'
  permits: 16
  rpm: 0
  itpm: 0
  otpm: 0
}
param limits object = {
  perUserDailyUsd: 25
  globalDailyUsd: 0
  maxQueued: 500
}
@description('Alert when a day of model spend passes this (USD).')
param dailyBudgetUsd int = 1000

var production = environmentName == 'production'
var tags = { app: 'spatial-capture', environment: environmentName }

module monitoring 'modules/monitoring.bicep' = {
  name: 'monitoring'
  params: { prefix: prefix, location: location, tags: tags }
}

module network 'modules/network.bicep' = {
  name: 'network'
  params: { prefix: prefix, location: location, tags: tags }
}

module security 'modules/security.bicep' = {
  name: 'security'
  params: {
    prefix: prefix
    location: location
    tags: tags
    endpointsSubnetId: network.outputs.endpointsSubnetId
    vaultZoneId: network.outputs.vaultZoneId
  }
}

module storage 'modules/storage.bicep' = {
  name: 'storage'
  params: {
    prefix: prefix
    location: location
    tags: tags
    webOrigins: webOrigins
    apiPrincipalId: security.outputs.apiPrincipalId
    workerPrincipalId: security.outputs.workerPrincipalId
    endpointsSubnetId: network.outputs.endpointsSubnetId
    blobZoneId: network.outputs.blobZoneId
  }
}

module postgres 'modules/postgres.bicep' = {
  name: 'postgres'
  params: {
    prefix: prefix
    location: location
    tags: tags
    production: production
    subnetId: network.outputs.postgresSubnetId
    privateDnsZoneId: network.outputs.postgresZoneId
    administratorPassword: postgresAdminPassword
  }
}

module redis 'modules/redis.bicep' = {
  name: 'redis'
  params: {
    prefix: prefix
    location: location
    tags: tags
    production: production
    endpointsSubnetId: network.outputs.endpointsSubnetId
    redisZoneId: network.outputs.redisZoneId
  }
}

// Connection secrets derived from what this template creates. The rest
// (jwt-private-key, jwt-key-id, smtp-url, anthropic-api-key) are set once by
// an operator; see README.md.
module secrets 'modules/secrets.bicep' = {
  name: 'secrets'
  params: {
    vaultName: security.outputs.vaultName
    values: {
      'database-url': 'postgres://app_rw:${uriComponent(appRwPassword)}@${postgres.outputs.host}:6432/spatial?sslmode=require'
      'database-replica-url': 'postgres://app_rw:${uriComponent(appRwPassword)}@${postgres.outputs.replicaHost}:6432/spatial?sslmode=require'
      // Migrations need a session, so they bypass PgBouncer (plan §8.4).
      'database-migrator-url': 'postgres://app_migrator:${uriComponent(appMigratorPassword)}@${postgres.outputs.host}:5432/spatial?sslmode=require'
      'redis-queue-url': redis.outputs.queueUrl
      'redis-cache-url': redis.outputs.cacheUrl
      'redis-queue-key': redis.outputs.queueKey
    }
  }
}

module frontDoor 'modules/frontdoor.bicep' = {
  name: 'frontdoor'
  params: {
    prefix: prefix
    tags: tags
    production: production
  }
}

module apps 'modules/apps.bicep' = if (deployApps) {
  name: 'apps'
  params: {
    prefix: prefix
    location: location
    tags: tags
    production: production
    deployEnv: environmentName
    imageTag: imageTag
    registryServer: security.outputs.registryServer
    appsSubnetId: network.outputs.appsSubnetId
    logsCustomerId: monitoring.outputs.logsCustomerId
    logsSharedKey: monitoring.outputs.logsSharedKey
    insightsConnectionString: monitoring.outputs.insightsConnectionString
    apiIdentityId: security.outputs.apiIdentityId
    apiClientId: security.outputs.apiClientId
    workerIdentityId: security.outputs.workerIdentityId
    workerClientId: security.outputs.workerClientId
    vaultUri: security.outputs.vaultUri
    blobEndpoint: storage.outputs.blobEndpoint
    webOrigins: webOrigins
    appBaseUrl: appBaseUrl
    mailFrom: mailFrom
    redisQueueHost: redis.outputs.queueHost
    llm: llm
    limits: limits
    frontDoorId: frontDoor.outputs.frontDoorId
  }
  dependsOn: [secrets]
}

module edge 'modules/edge.bicep' = if (deployApps) {
  name: 'edge'
  params: {
    prefix: prefix
    tags: tags
    production: production
    apiFqdn: apps!.outputs.apiFqdn
    webLocation: webLocation
    profileName: frontDoor.outputs.name
  }
}

module alerts 'modules/alerts.bicep' = {
  name: 'alerts'
  params: {
    prefix: prefix
    location: location
    tags: tags
    alertEmail: alertEmail
    insightsId: monitoring.outputs.insightsId
    postgresId: postgres.outputs.serverId
    redisQueueId: redis.outputs.queueId
    dailyBudgetUsd: dailyBudgetUsd
  }
}

output registryServer string = security.outputs.registryServer
output vaultName string = security.outputs.vaultName
output apiName string = deployApps ? apps!.outputs.apiName : ''
output workerName string = deployApps ? apps!.outputs.workerName : ''
output migrateJobName string = deployApps ? apps!.outputs.migrateJobName : ''
output edgeHost string = deployApps ? edge!.outputs.edgeHost : ''
output webName string = deployApps ? edge!.outputs.webName : ''
output blobEndpoint string = storage.outputs.blobEndpoint
output postgresHost string = postgres.outputs.host
