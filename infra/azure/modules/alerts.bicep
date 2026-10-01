// Alerts for the SLOs and failure modes in plan §16.1–16.2. Log alerts query
// Application Insights (the Log Analytics tables AppRequests and AppMetrics);
// metric alerts watch Postgres and the queue Redis.
param prefix string
param location string
param tags object
param alertEmail string
param insightsId string
param postgresId string
param redisQueueId string
param dailyBudgetUsd int

resource team 'Microsoft.Insights/actionGroups@2023-01-01' = {
  name: '${prefix}-oncall'
  location: 'global'
  tags: tags
  properties: {
    groupShortName: 'spatial'
    enabled: true
    emailReceivers: [{ name: 'oncall', emailAddress: alertEmail, useCommonAlertSchema: true }]
  }
}

var logAlerts = [
  {
    name: 'api-availability'
    description: 'API 5xx ratio above 0.1% over an hour (availability SLO 99.9%)'
    severity: 1
    window: 'PT1H'
    frequency: 'PT15M'
    query: 'AppRequests | where Name !startswith "GET /health" | summarize total = count(), failed = countif(toint(ResultCode) >= 500) | where total > 100 and todouble(failed) / total > 0.001'
  }
  {
    name: 'api-get-latency'
    description: 'GET p95 above 300 ms for 15 minutes (latency SLO)'
    severity: 2
    window: 'PT15M'
    frequency: 'PT5M'
    query: 'AppRequests | where Name startswith "GET " and Name !startswith "GET /health" and Name !has "/events" | summarize p95 = percentile(DurationMs, 95), n = count() | where n > 50 and p95 > 300'
  }
  {
    name: 'analysis-queue-wait'
    description: 'Analyses waiting more than 10 minutes for a worker'
    severity: 1
    window: 'PT15M'
    frequency: 'PT5M'
    query: 'AppMetrics | where Name == "spatial.analysis.queue_wait" | summarize wait = max(Max) | where wait > 600'
  }
  {
    name: 'analysis-failure-rate'
    description: 'More than 5% of analyses failing over an hour'
    severity: 1
    window: 'PT1H'
    frequency: 'PT15M'
    query: 'AppMetrics | where Name == "spatial.analysis.runs" | extend outcome = tostring(Properties.outcome) | summarize failed = sumif(Sum, outcome == "failed"), total = sumif(Sum, outcome in ("succeeded", "failed")) | where total >= 20 and failed / total > 0.05'
  }
  {
    name: 'llm-rate-limited'
    description: 'Claude answering 429 repeatedly: raise the Anthropic limits or lower LLM_*_LIMIT'
    severity: 2
    window: 'PT15M'
    frequency: 'PT5M'
    query: 'AppMetrics | where Name == "spatial.llm.rate_limited" | summarize n = sum(Sum) | where n > 20'
  }
  {
    name: 'llm-daily-spend'
    description: 'Model spend over the last 24 hours above the daily budget'
    severity: 1
    window: 'P1D'
    frequency: 'PT1H'
    query: 'AppMetrics | where Name == "spatial.llm.cost" | summarize usd = sum(Sum) | where usd > ${dailyBudgetUsd}'
  }
]

resource log 'Microsoft.Insights/scheduledQueryRules@2023-03-15-preview' = [
  for alert in logAlerts: {
    name: '${prefix}-${alert.name}'
    location: location
    tags: tags
    properties: {
      displayName: '${prefix}: ${alert.name}'
      description: alert.description
      severity: alert.severity
      enabled: true
      scopes: [insightsId]
      evaluationFrequency: alert.frequency
      windowSize: alert.window
      criteria: {
        allOf: [
          {
            query: alert.query
            timeAggregation: 'Count'
            operator: 'GreaterThan'
            threshold: 0
            failingPeriods: { numberOfEvaluationPeriods: 1, minFailingPeriodsToAlert: 1 }
          }
        ]
      }
      actions: { actionGroups: [team.id] }
    }
  }
]

var metricAlerts = [
  { name: 'postgres-cpu', scope: postgresId, metric: 'cpu_percent', threshold: 80, description: 'Postgres CPU above 80%' }
  { name: 'postgres-connections', scope: postgresId, metric: 'active_connections', threshold: 400, description: 'Postgres connections near the limit' }
  { name: 'redis-queue-memory', scope: redisQueueId, metric: 'usedmemorypercentage', threshold: 80, description: 'Queue Redis memory above 80% (noeviction: writes fail when full)' }
]

resource metric 'Microsoft.Insights/metricAlerts@2018-03-01' = [
  for alert in metricAlerts: {
    name: '${prefix}-${alert.name}'
    location: 'global'
    tags: tags
    properties: {
      description: alert.description
      severity: 2
      enabled: true
      scopes: [alert.scope]
      evaluationFrequency: 'PT5M'
      windowSize: 'PT15M'
      criteria: {
        'odata.type': 'Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria'
        allOf: [
          {
            name: alert.metric
            metricName: alert.metric
            operator: 'GreaterThan'
            threshold: alert.threshold
            timeAggregation: 'Average'
            criterionType: 'StaticThresholdCriterion'
          }
        ]
      }
      actions: [{ actionGroupId: team.id }]
    }
  }
]
