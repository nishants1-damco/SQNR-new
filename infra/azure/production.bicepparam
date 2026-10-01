using 'main.bicep'

param environmentName = 'production'
param prefix = 'sqnr-prd'
param imageTag = readEnvironmentVariable('IMAGE_TAG', 'latest')
param webOrigins = ['https://app.sqnr.example']
param appBaseUrl = 'https://app.sqnr.example'
param mailFrom = 'SQNR <no-reply@sqnr.example>'
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', 'oncall@sqnr.example')
param deployApps = bool(readEnvironmentVariable('DEPLOY_APPS', 'true'))
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')
param appRwPassword = readEnvironmentVariable('APP_RW_PASSWORD')
param appMigratorPassword = readEnvironmentVariable('APP_MIGRATOR_PASSWORD')
// Plan §9.7.6, public-launch stage: set rpm/itpm/otpm to 85% of the granted
// Anthropic limits once they're known.
param llm = {
  model: 'claude-opus-5-5'
  fallbackModel: 'claude-sonnet-5'
  permits: 64
  rpm: 0
  itpm: 0
  otpm: 0
}
param limits = {
  perUserDailyUsd: 25
  globalDailyUsd: 12000
  maxQueued: 500
}
param dailyBudgetUsd = 9600
