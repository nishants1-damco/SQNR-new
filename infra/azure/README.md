# Azure infrastructure

Bicep for one environment per resource group (plan §15): `staging.bicepparam` and `production.bicepparam`. Decision D10 (Bicep vs Terraform) was taken as Bicep: Azure-native, no state backend, compiled by the Azure CLI.

```
main.bicep                  composes the modules; writes derived connection strings to Key Vault
modules/monitoring.bicep    Log Analytics + Application Insights
modules/network.bicep       VNet (apps, postgres, endpoints subnets) + private DNS zones
modules/security.bicep      managed identities (api, worker), Key Vault, container registry
modules/storage.bicep       Blob Storage: ZRS, CORS, soft delete, lifecycle (frames Cool 30 d / Cold 180 d)
modules/postgres.bicep      Flexible Server 16, PgBouncer, extensions, PITR; HA + read replica in production
modules/redis.bicep         queue Redis (noeviction; Premium + AOF in production) and cache Redis (LRU)
modules/apps.bicep          Container Apps: API, worker (KEDA on the analysis queue), migration job
modules/frontdoor.bicep     the Front Door profile, deployed first so the API gets its id
modules/edge.bicep          Front Door endpoint, routes + WAF, Static Web App for the web app (SQNR-web)
modules/alerts.bicep        SLO and failure alerts (plan §16.1–16.2)
bootstrap.sql               one-time database roles and extensions
```

Check it compiles: `az bicep build --file infra/azure/main.bicep` (CI does this too).

## What runs where

| Piece      | Service                                                                                     | Scaling                                                      |
| ---------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| API        | Container App `…-api`, external ingress behind Front Door                                   | 2–20 replicas (production), 80 concurrent requests each      |
| Worker     | Container App `…-worker`, no ingress                                                        | 1–40 replicas on the length of `spatial:analysis-cloud:wait` |
| Migrations | Container Apps job `…-migrate` (API image, `node node_modules/@spatial/db/dist/migrate.js`) | run by the deploy workflow                                   |
| Web app    | Static Web App `…-web` (deployed from SQNR-web)                                             | static                                                       |
| Traces     | Container Apps' OpenTelemetry agent → Application Insights                                  |                                                              |
| Metrics    | the apps' Azure Monitor exporter (`APPLICATIONINSIGHTS_CONNECTION_STRING`)                  |                                                              |

The apps read every secret from Key Vault with their managed identity. Blob Storage has shared-key access disabled: the API signs user-delegation SAS URLs with its identity (Storage Blob Delegator), and the worker writes with Storage Blob Data Contributor.

## First deployment

1. Create the resource group and a federated credential for GitHub Actions (OIDC), with Contributor and User Access Administrator on the resource group (the templates create role assignments).
2. Deploy the base without the apps, since the apps need secrets that don't exist yet:

   ```sh
   export POSTGRES_ADMIN_PASSWORD=… APP_RW_PASSWORD=… APP_MIGRATOR_PASSWORD=… DEPLOY_APPS=false
   az deployment group create -g sqnr-staging -f infra/azure/main.bicep -p infra/azure/staging.bicepparam
   ```

3. Put the secrets only an operator has in Key Vault (`az keyvault secret set --vault-name <vault> --name <name> --value …`); the vault has no public access, so run this from inside the VNet or open it temporarily:

   | Secret              | Value                                                                             |
   | ------------------- | --------------------------------------------------------------------------------- |
   | `jwt-private-key`   | Ed25519 PKCS#8 PEM (`docker run --rm spatial-api node dist/cli/generate-keys.js`) |
   | `jwt-key-id`        | the key id printed with it                                                        |
   | `smtp-url`          | Azure Communication Services SMTP URL                                             |
   | `anthropic-api-key` | the Claude API key (D11)                                                          |

   The database and Redis connection strings are written by `main.bicep` itself.

4. Bootstrap the database (roles and extensions), from a machine that can reach the private server: `psql … -f infra/azure/bootstrap.sql` (see the header of that file).
5. Run the deploy workflow (or step 2 again without `DEPLOY_APPS=false`). It builds and pushes the images, runs the migrations and rolls out the apps. Point the web app's custom domain at the Front Door endpoint and deploy SQNR-web to the Static Web App.

## Every deployment

`.github/workflows/deploy.yml`: after CI passes on `main`, deploy to staging; production waits for approval on its GitHub environment. Each environment: build and push `spatial-api` and `spatial-worker` tagged with the commit SHA → run the migration job with the new image → `az deployment group create` (rolls the apps to the new images) → smoke test through Front Door. Migrations must stay backward compatible (expand, then contract): the old revision serves traffic while they run.

## Known gaps

- **API ingress is public**, because Container Apps can't restrict ingress to the Front Door service tag. The API refuses requests without its Front Door profile id in `X-Azure-FDID` (`FRONT_DOOR_ID`, from `modules/frontdoor.bicep`, which deploys before the apps). Health probes are the exception. An internal environment with Front Door Premium Private Link would also hide the address.
- **Thumbnails tier with the frames.** The lifecycle rule matches the `scans/` container; thumbnails live beside their frames, so they move to Cool after 30 days too (the plan wanted them kept in Hot). Moving them to their own container would fix it.
- **Alert thresholds are starting points** until real traffic exists (plan §3's numbers are assumptions).
- The templates compile and pass the linter; they have not been deployed to a subscription yet.
