// Azure Cache for Redis (plan §9.2): two instances.
//   queue: BullMQ, the LLM gate and progress events. noeviction, and in
//          production Premium with AOF persistence, since losing keys loses jobs.
//   cache: rate limits, quotas, geocoding and read-your-writes markers. LRU.
param prefix string
param location string
param tags object
param production bool
param endpointsSubnetId string
param redisZoneId string

resource queue 'Microsoft.Cache/redis@2024-03-01' = {
  name: '${prefix}-redis-queue'
  location: location
  tags: tags
  properties: {
    sku: production
      ? { name: 'Premium', family: 'P', capacity: 1 }
      : { name: 'Standard', family: 'C', capacity: 1 }
    minimumTlsVersion: '1.2'
    enableNonSslPort: false
    publicNetworkAccess: 'Disabled'
    redisConfiguration: union(
      { 'maxmemory-policy': 'noeviction' },
      production ? { 'aof-backup-enabled': 'true' } : {}
    )
  }
  zones: production ? ['1', '2'] : null
}

resource cache 'Microsoft.Cache/redis@2024-03-01' = {
  name: '${prefix}-redis-cache'
  location: location
  tags: tags
  properties: {
    sku: { name: 'Standard', family: 'C', capacity: production ? 2 : 1 }
    minimumTlsVersion: '1.2'
    enableNonSslPort: false
    publicNetworkAccess: 'Disabled'
    redisConfiguration: { 'maxmemory-policy': 'allkeys-lru' }
  }
}

module queueEndpoint 'private-endpoint.bicep' = {
  name: 'redis-queue-endpoint'
  params: {
    name: '${prefix}-redis-queue-pe'
    location: location
    tags: tags
    subnetId: endpointsSubnetId
    targetId: queue.id
    groupId: 'redisCache'
    zoneId: redisZoneId
  }
}

module cacheEndpoint 'private-endpoint.bicep' = {
  name: 'redis-cache-endpoint'
  params: {
    name: '${prefix}-redis-cache-pe'
    location: location
    tags: tags
    subnetId: endpointsSubnetId
    targetId: cache.id
    groupId: 'redisCache'
    zoneId: redisZoneId
  }
}

// rediss:// URLs with the access key, stored in Key Vault by main.bicep.
#disable-next-line outputs-should-not-contain-secrets
output queueUrl string = 'rediss://:${uriComponent(queue.listKeys().primaryKey)}@${queue.properties.hostName}:${queue.properties.sslPort}'
#disable-next-line outputs-should-not-contain-secrets
output cacheUrl string = 'rediss://:${uriComponent(cache.listKeys().primaryKey)}@${cache.properties.hostName}:${cache.properties.sslPort}'
output queueHost string = queue.properties.hostName
#disable-next-line outputs-should-not-contain-secrets
output queueKey string = queue.listKeys().primaryKey
output queueId string = queue.id
output cacheId string = cache.id
