// PostgreSQL Flexible Server (plan §8, §15): Postgres 16 with the extensions
// the schema needs, the built-in PgBouncer (port 6432, transaction mode), 35
// days of point-in-time restore, private access only, and in production
// zone-redundant HA plus one read replica.
//
// The roles the apps use (app_migrator, app_rw) and the extensions are
// created once by infra/azure/bootstrap.sql (see infra/azure/README.md).
param prefix string
param location string
param tags object
param production bool
param subnetId string
param privateDnsZoneId string
@secure()
param administratorPassword string

var sku = production
  ? { name: 'Standard_D4ds_v5', tier: 'GeneralPurpose' }
  : { name: 'Standard_D2ds_v5', tier: 'GeneralPurpose' }

resource server 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = {
  name: '${prefix}-pg'
  location: location
  tags: tags
  sku: sku
  properties: {
    version: '16'
    administratorLogin: 'spatialadmin'
    administratorLoginPassword: administratorPassword
    storage: { storageSizeGB: production ? 256 : 64, autoGrow: 'Enabled' }
    backup: {
      backupRetentionDays: production ? 35 : 7
      geoRedundantBackup: production ? 'Enabled' : 'Disabled'
    }
    highAvailability: { mode: production ? 'ZoneRedundant' : 'Disabled' }
    network: {
      delegatedSubnetResourceId: subnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
  }
}

resource extensions 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'azure.extensions'
  properties: { value: 'POSTGIS,VECTOR,CITEXT,PG_TRGM', source: 'user-override' }
}

resource pgbouncer 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'pgbouncer.enabled'
  properties: { value: 'true', source: 'user-override' }
  dependsOn: [extensions]
}

resource poolMode 'Microsoft.DBforPostgreSQL/flexibleServers/configurations@2024-08-01' = {
  parent: server
  name: 'pgbouncer.pool_mode'
  properties: { value: 'transaction', source: 'user-override' }
  dependsOn: [pgbouncer]
}

resource database 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = {
  parent: server
  name: 'spatial'
  properties: { charset: 'UTF8', collation: 'en_US.utf8' }
}

resource replica 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (production) {
  name: '${prefix}-pg-replica'
  location: location
  tags: tags
  sku: sku
  properties: {
    createMode: 'Replica'
    sourceServerResourceId: server.id
    network: {
      delegatedSubnetResourceId: subnetId
      privateDnsZoneArmResourceId: privateDnsZoneId
      publicNetworkAccess: 'Disabled'
    }
  }
  dependsOn: [database, poolMode]
}

output host string = server.properties.fullyQualifiedDomainName
output replicaHost string = production ? replica!.properties.fullyQualifiedDomainName : server.properties.fullyQualifiedDomainName
output serverId string = server.id
