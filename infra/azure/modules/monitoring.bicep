// Log Analytics and Application Insights (plan §15, §16.1). Container Apps'
// managed OpenTelemetry agent forwards the apps' OTLP traces and metrics here.
param prefix string
param location string
param tags object

resource logs 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: '${prefix}-logs'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource insights 'Microsoft.Insights/components@2020-02-02' = {
  name: '${prefix}-insights'
  location: location
  tags: tags
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: logs.id
    IngestionMode: 'LogAnalytics'
  }
}

output logsId string = logs.id
output logsCustomerId string = logs.properties.customerId
#disable-next-line outputs-should-not-contain-secrets
output logsSharedKey string = logs.listKeys().primarySharedKey
output insightsId string = insights.id
output insightsConnectionString string = insights.properties.ConnectionString
