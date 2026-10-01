// The Front Door profile on its own, deployed before the apps: the API needs
// the profile's id to refuse traffic that bypasses it (X-Azure-FDID). Its
// endpoint, routes and WAF are in edge.bicep, which needs the API's address.
param prefix string
param tags object
param production bool

resource profile 'Microsoft.Cdn/profiles@2024-02-01' = {
  name: '${prefix}-fd'
  location: 'global'
  tags: tags
  sku: { name: production ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor' }
  properties: {
    // Long enough for the analysis event stream between heartbeats.
    originResponseTimeoutSeconds: 240
  }
}

output name string = profile.name
output frontDoorId string = profile.properties.frontDoorId
