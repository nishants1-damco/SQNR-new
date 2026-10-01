// Blob Storage (plan §12, §15): ZRS, no anonymous or shared-key access (the
// API signs user-delegation SAS with its identity), CORS for browser uploads,
// soft delete, and lifecycle rules. Frames are kept for the life of the scan
// (D9) and move to Cool after 30 days and Cold after 180; never Archive, since
// re-analysis and the space page need them online. Exports go after 7 days.
param prefix string
param location string
param tags object
param webOrigins array
param apiPrincipalId string
param workerPrincipalId string
param endpointsSubnetId string
param blobZoneId string

var roles = {
  blobDataContributor: 'ba92f5b4-2d11-453d-a403-e96b0029c9fe'
  blobDelegator: 'db58b8e5-c6ad-4a2a-8342-4190687cbf4a'
}

resource account 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: take('${replace(prefix, '-', '')}st${uniqueString(resourceGroup().id)}', 24)
  location: location
  tags: tags
  kind: 'StorageV2'
  sku: { name: 'Standard_ZRS' }
  properties: {
    accessTier: 'Hot'
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
    // Browsers PUT and GET frames through SAS URLs, so the blob endpoint stays
    // reachable; the apps use the private endpoint.
    publicNetworkAccess: 'Enabled'
  }
}

resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    deleteRetentionPolicy: { enabled: true, days: 7 }
    containerDeleteRetentionPolicy: { enabled: true, days: 7 }
    cors: {
      corsRules: [
        {
          allowedOrigins: webOrigins
          allowedMethods: ['GET', 'HEAD', 'PUT']
          allowedHeaders: ['content-type', 'x-ms-blob-type', 'x-ms-version', 'x-ms-date']
          exposedHeaders: ['etag']
          maxAgeInSeconds: 3600
        }
      ]
    }
  }
}

resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [
  for name in ['scans', 'exports', 'catalog-images']: {
    parent: blobs
    name: name
    properties: { publicAccess: 'None' }
  }
]

resource lifecycle 'Microsoft.Storage/storageAccounts/managementPolicies@2023-05-01' = {
  parent: account
  name: 'default'
  properties: {
    policy: {
      rules: [
        {
          name: 'frames-cool-then-cold'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['scans/'] }
            actions: {
              baseBlob: {
                tierToCool: { daysAfterModificationGreaterThan: 30 }
                tierToCold: { daysAfterModificationGreaterThan: 180 }
              }
            }
          }
        }
        {
          name: 'exports-expire'
          enabled: true
          type: 'Lifecycle'
          definition: {
            filters: { blobTypes: ['blockBlob'], prefixMatch: ['exports/'] }
            actions: { baseBlob: { delete: { daysAfterModificationGreaterThan: 7 } } }
          }
        }
      ]
    }
  }
}

module endpoint 'private-endpoint.bicep' = {
  name: 'blob-endpoint'
  params: {
    name: '${prefix}-blob-pe'
    location: location
    tags: tags
    subnetId: endpointsSubnetId
    targetId: account.id
    groupId: 'blob'
    zoneId: blobZoneId
  }
}

// The API reads, writes and signs user-delegation SAS; the worker reads and
// writes (thumbnails, EXIF stripping, deletes).
resource apiData 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, apiPrincipalId, roles.blobDataContributor)
  scope: account
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor)
  }
}

resource apiDelegator 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, apiPrincipalId, roles.blobDelegator)
  scope: account
  properties: {
    principalId: apiPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDelegator)
  }
}

resource workerData 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(account.id, workerPrincipalId, roles.blobDataContributor)
  scope: account
  properties: {
    principalId: workerPrincipalId
    principalType: 'ServicePrincipal'
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', roles.blobDataContributor)
  }
}

output accountName string = account.name
output blobEndpoint string = account.properties.primaryEndpoints.blob
