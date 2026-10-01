// Private networking (plan §15): Container Apps run in their own subnet;
// Postgres gets a delegated subnet; Redis, Storage and Key Vault are reached
// through private endpoints. Browsers still upload to the Blob endpoint
// directly, so Storage keeps its public endpoint too (SAS only, no anonymous
// or shared-key access).
param prefix string
param location string
param tags object

resource vnet 'Microsoft.Network/virtualNetworks@2024-05-01' = {
  name: '${prefix}-vnet'
  location: location
  tags: tags
  properties: {
    addressSpace: { addressPrefixes: ['10.40.0.0/16'] }
    subnets: [
      {
        name: 'apps'
        properties: {
          addressPrefix: '10.40.0.0/23'
          delegations: [
            {
              name: 'containerapps'
              properties: { serviceName: 'Microsoft.App/environments' }
            }
          ]
        }
      }
      {
        name: 'postgres'
        properties: {
          addressPrefix: '10.40.2.0/24'
          delegations: [
            {
              name: 'postgres'
              properties: { serviceName: 'Microsoft.DBforPostgreSQL/flexibleServers' }
            }
          ]
        }
      }
      {
        name: 'endpoints'
        properties: { addressPrefix: '10.40.3.0/24' }
      }
    ]
  }
}

var zoneNames = [
  'privatelink.postgres.database.azure.com'
  'privatelink.redis.cache.windows.net'
  'privatelink.blob.${environment().suffixes.storage}'
  'privatelink.vaultcore.azure.net'
]

resource zones 'Microsoft.Network/privateDnsZones@2024-06-01' = [
  for zone in zoneNames: {
    name: zone
    location: 'global'
    tags: tags
  }
]

resource links 'Microsoft.Network/privateDnsZones/virtualNetworkLinks@2024-06-01' = [
  for (zone, i) in zoneNames: {
    parent: zones[i]
    name: '${prefix}-link'
    location: 'global'
    properties: {
      virtualNetwork: { id: vnet.id }
      registrationEnabled: false
    }
  }
]

output vnetId string = vnet.id
output appsSubnetId string = vnet.properties.subnets[0].id
output postgresSubnetId string = vnet.properties.subnets[1].id
output endpointsSubnetId string = vnet.properties.subnets[2].id
output postgresZoneId string = zones[0].id
output redisZoneId string = zones[1].id
output blobZoneId string = zones[2].id
output vaultZoneId string = zones[3].id
