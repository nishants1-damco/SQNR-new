// Managed identities for the API and worker, Key Vault for secrets and the
// container registry (plan §15, §16.3). No account keys in the apps: they
// read secrets with their identity and pull images with AcrPull.
param prefix string
param location string
param tags object
param endpointsSubnetId string
param vaultZoneId string

var roles = {
  keyVaultSecretsUser: '4633458b-17de-408a-b874-0445c86b69e6'
  acrPull: '7f951dda-4ed3-4680-a7ca-43fe172d538d'
}

resource apiIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-api-id'
  location: location
  tags: tags
}

resource workerIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${prefix}-worker-id'
  location: location
  tags: tags
}

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' = {
  // Key Vault names are global and at most 24 characters.
  name: take('${replace(prefix, '-', '')}kv${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  properties: {
    tenantId: tenant().tenantId
    sku: { family: 'A', name: 'standard' }
    enableRbacAuthorization: true
    enableSoftDelete: true
    softDeleteRetentionInDays: 30
    enablePurgeProtection: true
    publicNetworkAccess: 'Disabled'
  }
}

module vaultEndpoint 'private-endpoint.bicep' = {
  name: 'vault-endpoint'
  params: {
    name: '${prefix}-kv-pe'
    location: location
    tags: tags
    subnetId: endpointsSubnetId
    targetId: vault.id
    groupId: 'vault'
    zoneId: vaultZoneId
  }
}

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: take('${replace(prefix, '-', '')}acr${uniqueString(resourceGroup().id)}', 50)
  location: location
  tags: tags
  sku: { name: 'Standard' }
  properties: { adminUserEnabled: false }
}

var assignments = [
  { key: 'api-secrets', scope: 'vault', identity: 'api', role: roles.keyVaultSecretsUser }
  { key: 'worker-secrets', scope: 'vault', identity: 'worker', role: roles.keyVaultSecretsUser }
  { key: 'api-pull', scope: 'registry', identity: 'api', role: roles.acrPull }
  { key: 'worker-pull', scope: 'registry', identity: 'worker', role: roles.acrPull }
]

resource vaultRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in filter(assignments, x => x.scope == 'vault'): {
    name: guid(vault.id, a.key)
    scope: vault
    properties: {
      principalId: a.identity == 'api' ? apiIdentity.properties.principalId : workerIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.role)
    }
  }
]

resource registryRoles 'Microsoft.Authorization/roleAssignments@2022-04-01' = [
  for a in filter(assignments, x => x.scope == 'registry'): {
    name: guid(registry.id, a.key)
    scope: registry
    properties: {
      principalId: a.identity == 'api' ? apiIdentity.properties.principalId : workerIdentity.properties.principalId
      principalType: 'ServicePrincipal'
      roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', a.role)
    }
  }
]

output apiIdentityId string = apiIdentity.id
output apiPrincipalId string = apiIdentity.properties.principalId
output apiClientId string = apiIdentity.properties.clientId
output workerIdentityId string = workerIdentity.id
output workerPrincipalId string = workerIdentity.properties.principalId
output workerClientId string = workerIdentity.properties.clientId
output vaultName string = vault.name
output vaultUri string = vault.properties.vaultUri
output registryName string = registry.name
output registryServer string = registry.properties.loginServer
