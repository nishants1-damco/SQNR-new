// The edge (plan §15): Azure Front Door with a WAF in front of the web app
// (Static Web Apps) and the API. `/v1/*` and `/.well-known/*` go to the API,
// uncached; everything else to the web app. Production uses the Premium tier
// for the managed WAF rule sets; staging uses Standard with the custom rules.
param prefix string
param tags object
param production bool
param apiFqdn string
param webLocation string
param profileName string

resource web 'Microsoft.Web/staticSites@2023-12-01' = {
  name: '${prefix}-web'
  location: webLocation
  tags: tags
  sku: { name: 'Standard', tier: 'Standard' }
  properties: {}
}

var tier = production ? 'Premium_AzureFrontDoor' : 'Standard_AzureFrontDoor'

resource waf 'Microsoft.Network/FrontDoorWebApplicationFirewallPolicies@2024-02-01' = {
  name: '${replace(prefix, '-', '')}waf'
  location: 'global'
  tags: tags
  sku: { name: tier }
  properties: {
    policySettings: { enabledState: 'Enabled', mode: 'Prevention' }
    customRules: {
      rules: [
        {
          // Coarse flood protection per client IP; the API's own limits are finer.
          name: 'PerIpFlood'
          priority: 10
          ruleType: 'RateLimitRule'
          rateLimitDurationInMinutes: 1
          rateLimitThreshold: 1200
          action: 'Block'
          matchConditions: [
            {
              matchVariable: 'RequestUri'
              operator: 'RegEx'
              matchValue: ['.*']
            }
          ]
        }
      ]
    }
    managedRules: production
      ? {
          managedRuleSets: [
            {
              ruleSetType: 'Microsoft_DefaultRuleSet'
              ruleSetVersion: '2.1'
              ruleSetAction: 'Block'
            }
            { ruleSetType: 'Microsoft_BotManagerRuleSet', ruleSetVersion: '1.1' }
          ]
        }
      : { managedRuleSets: [] }
  }
}

// Created by frontdoor.bicep.
resource profile 'Microsoft.Cdn/profiles@2024-02-01' existing = {
  name: profileName
}

resource endpoint 'Microsoft.Cdn/profiles/afdEndpoints@2024-02-01' = {
  parent: profile
  name: '${prefix}-edge'
  location: 'global'
  properties: { enabledState: 'Enabled' }
}

resource apiOrigins 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: 'api'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 }
    healthProbeSettings: {
      probePath: '/health/ready'
      probeProtocol: 'Https'
      probeRequestType: 'GET'
      probeIntervalInSeconds: 30
    }
  }
}

resource apiOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: apiOrigins
  name: 'container-app'
  properties: {
    hostName: apiFqdn
    originHostHeader: apiFqdn
    httpsPort: 443
    priority: 1
    weight: 1000
    enforceCertificateNameCheck: true
  }
}

resource webOrigins 'Microsoft.Cdn/profiles/originGroups@2024-02-01' = {
  parent: profile
  name: 'web'
  properties: {
    loadBalancingSettings: { sampleSize: 4, successfulSamplesRequired: 3 }
  }
}

resource webOrigin 'Microsoft.Cdn/profiles/originGroups/origins@2024-02-01' = {
  parent: webOrigins
  name: 'static-web-app'
  properties: {
    hostName: web.properties.defaultHostname
    originHostHeader: web.properties.defaultHostname
    httpsPort: 443
    priority: 1
    weight: 1000
    enforceCertificateNameCheck: true
  }
}

resource apiRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'api'
  properties: {
    originGroup: { id: apiOrigins.id }
    patternsToMatch: ['/v1/*', '/.well-known/*']
    supportedProtocols: ['Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
  }
  dependsOn: [apiOrigin]
}

resource webRoute 'Microsoft.Cdn/profiles/afdEndpoints/routes@2024-02-01' = {
  parent: endpoint
  name: 'web'
  properties: {
    originGroup: { id: webOrigins.id }
    patternsToMatch: ['/*']
    supportedProtocols: ['Http', 'Https']
    httpsRedirect: 'Enabled'
    forwardingProtocol: 'HttpsOnly'
    linkToDefaultDomain: 'Enabled'
    cacheConfiguration: {
      queryStringCachingBehavior: 'IgnoreQueryString'
      compressionSettings: {
        isCompressionEnabled: true
        contentTypesToCompress: ['text/html', 'application/javascript', 'text/css', 'application/json']
      }
    }
  }
  dependsOn: [webOrigin, apiRoute]
}

resource security 'Microsoft.Cdn/profiles/securityPolicies@2024-02-01' = {
  parent: profile
  name: 'waf'
  properties: {
    parameters: {
      type: 'WebApplicationFirewall'
      wafPolicy: { id: waf.id }
      associations: [{ domains: [{ id: endpoint.id }], patternsToMatch: ['/*'] }]
    }
  }
}

output edgeHost string = endpoint.properties.hostName
output webName string = web.name
output webDefaultHost string = web.properties.defaultHostname
output frontDoorId string = profile.properties.frontDoorId
