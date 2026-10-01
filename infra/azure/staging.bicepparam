using 'main.bicep'

param environmentName = 'staging'
param prefix = 'sqnr-stg'
param imageTag = readEnvironmentVariable('IMAGE_TAG', 'latest')
param webOrigins = ['https://staging.sqnr.example']
param appBaseUrl = 'https://staging.sqnr.example'
param mailFrom = 'SQNR <no-reply@staging.sqnr.example>'
param alertEmail = readEnvironmentVariable('ALERT_EMAIL', 'oncall@sqnr.example')
param deployApps = bool(readEnvironmentVariable('DEPLOY_APPS', 'true'))
param postgresAdminPassword = readEnvironmentVariable('POSTGRES_ADMIN_PASSWORD')
param appRwPassword = readEnvironmentVariable('APP_RW_PASSWORD')
param appMigratorPassword = readEnvironmentVariable('APP_MIGRATOR_PASSWORD')
// Load tests run here with the stub model (tests/load/README.md), so the
// spend guards stay on but loose.
param limits = {
  perUserDailyUsd: 25
  globalDailyUsd: 200
  maxQueued: 500
}
param dailyBudgetUsd = 200
