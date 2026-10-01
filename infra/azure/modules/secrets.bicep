// Connection secrets main.bicep derives from what it creates (database and
// Redis URLs), written to Key Vault for the apps to read.
param vaultName string
@secure()
param values object

resource vault 'Microsoft.KeyVault/vaults@2023-07-01' existing = {
  name: vaultName
}

var names = [
  'database-url'
  'database-replica-url'
  'database-migrator-url'
  'redis-queue-url'
  'redis-cache-url'
  'redis-queue-key'
]

resource secrets 'Microsoft.KeyVault/vaults/secrets@2023-07-01' = [
  for name in names: {
    parent: vault
    name: name
    properties: { value: values[name] }
  }
]
