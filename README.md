# Spatial Capture Platform

The re-platformed Spatial Capture: a TanStack web app, a NestJS/Fastify API and a NestJS worker, on PostgreSQL (PostGIS + pgvector), Redis and Azure Blob Storage. The design and phased roadmap are in [docs/architecture/scaling-migration-plan.md](docs/architecture/scaling-migration-plan.md).

**Status: phase 2 (core API and storage).** Auth, spaces (scans), direct-to-Blob frame uploads, exports, geocoding, consent and feature flags run in the API; the worker relays the outbox and runs the blob-cleanup, media and maintenance jobs. Analysis (the AI reconstruction pipeline) arrives in phase 3; see [What's next](#whats-next).

## Layout

```
apps/
  api/                   NestJS 11 on Fastify: auth, spaces, uploads, exports   @spatial/api
  worker/                NestJS app context: outbox relay + BullMQ jobs         @spatial/worker
packages/
  config/                validated env for api/worker + local-stack defaults    @spatial/config
  contracts/             zod wire schemas shared by every app                   @spatial/contracts
  db/                    SQL migrations, migrator, Drizzle schema, outbox       @spatial/db
  storage/               BlobStore on Azure Blob Storage / Azurite              @spatial/storage
  domain/                pure geometry, solvers, reconciliation                 @spatial/domain/<module>
  tsconfig/              shared TypeScript settings (strict)
  eslint-config/         shared ESLint flat configs
tools/dev-infra/         init and end-to-end check of the local stack
infra/docker/            Docker Compose: Postgres, PgBouncer, Redis, Azurite, Mailpit, Ollama
docs/                    migration plan, porting ledger
```

`@spatial/domain` has no barrel file; import each module by subpath, e.g. `import { shellFromRanges } from "@spatial/domain/wall-ranges"`. It must stay free of I/O and runtime-specific globals so web, api and worker can all use it; its lint config enforces that.

What came from the original app, and what is still waiting, is tracked in [docs/porting-ledger.md](docs/porting-ledger.md).

## Prerequisites

- Node.js 24 (see `.nvmrc`; 22 also works)
- pnpm 12.8.1, pinned in `package.json`. The simplest way is `corepack enable pnpm`, after which `pnpm` resolves to the pinned version
- Docker Desktop (or another Docker engine with Compose v2), for the local stack

## Getting started

```sh
pnpm install
pnpm infra:up        # local stack (see below)
pnpm db:migrate      # apply migrations to the development database
pnpm db:seed         # a verified dev user: dev@spatial.local / spatial-dev-password
pnpm dev             # API on http://localhost:3000 (docs at /docs) and the worker
```

`pnpm dev:api` and `pnpm dev:worker` start them one at a time.

Without a signing key the API makes a new one on every start, which signs everyone out on restart. For a stable key, copy `apps/api/.env.example` to `apps/api/.env` and add the output of `pnpm --filter @spatial/api keys:generate`.

## Everyday commands

```sh
pnpm check              # lint + typecheck + unit tests + build, all packages (Turborepo)
pnpm test               # unit tests only (no Docker needed)
pnpm test:integration   # db, storage, api and worker against the local stack
pnpm db:status          # applied and pending migrations
pnpm format             # Prettier
```

## The API

Every route needs a bearer access token unless it's marked `@Public()`. Errors always use the envelope `{ code, message, details? }` from `@spatial/contracts`.

| Route                                            | Access         | What it does                                                                                                                                     |
| ------------------------------------------------ | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/sign-up`                          | public         | Creates the account and signs in (201). Sends a verification email; verifying is not required to sign in, as with the Supabase setup it replaces |
| `POST /v1/auth/sign-in`                          | public         | Email + password. Accounts imported from Supabase keep working (bcrypt, re-hashed to Argon2id on sign-in)                                        |
| `POST /v1/auth/refresh`                          | refresh cookie | New access token; rotates the refresh cookie. Replaying an old refresh token ends that session everywhere                                        |
| `POST /v1/auth/sign-out`                         | refresh cookie | Ends the session and clears the cookie                                                                                                           |
| `POST /v1/auth/verify-email`                     | public         | Redeems the emailed verification link                                                                                                            |
| `POST /v1/auth/verify-email/resend`              | token          | Sends a new verification email                                                                                                                   |
| `POST /v1/auth/password-reset`                   | public         | Always 202, so it can't reveal which emails have accounts                                                                                        |
| `POST /v1/auth/password-reset/confirm`           | public         | Sets the new password and signs out every session                                                                                                |
| `GET /v1/me`                                     | token          | The signed-in user                                                                                                                               |
| `GET /.well-known/jwks.json`                     | public         | Public keys for verifying access tokens                                                                                                          |
| `GET /health/live`, `GET /health/ready`          | public         | Liveness; readiness checks Postgres and Redis                                                                                                    |
| `GET /v1/scans`                                  | token          | The caller's spaces: `q` (name, summary, address), `status`, `sort` (`newest`, `oldest`, `name`, `area`), cursor pages, totals, thumbnails       |
| `POST /v1/scans`                                 | token          | Creates a draft space with its capture data. Repeating a `captureId` returns the same space (200)                                                |
| `GET /v1/scans/:id`                              | token          | The space with its objects, portals, surfaces and frames (with read URLs)                                                                        |
| `PATCH /v1/scans/:id`                            | token          | Name, notes, and capture-owned `analysis_notes` keys (merged; server-written keys are kept)                                                      |
| `DELETE /v1/scans/:id`                           | token          | Deletes the space and everything tied to it; its files are removed by the worker. Consent records are kept                                       |
| `DELETE /v1/scans/:id/photos/:photoId`           | token          | Removes one frame and records why in `analysis_notes.frame_removals`                                                                             |
| `POST /v1/scans/:id/uploads`                     | token          | Signs one create-only upload URL per file (frames, one depth file)                                                                               |
| `POST /v1/scans/:id/uploads/:sessionId/complete` | token          | Checks each uploaded blob, records the frames (optionally replacing reshot viewpoints) and the depth file                                        |
| `POST /v1/scans/photo-urls`                      | token          | Read URLs for the caller's own blobs; anything else is reported missing                                                                          |
| `GET /v1/scans/:id/export`                       | token          | GeoJSON, PostGIS rows, the layer bundle, IMDF and OpenUSD; `?format=` for one                                                                    |
| `POST /v1/scans/:id/address`                     | token          | Reverse-geocodes the GPS fix and stores the street address                                                                                       |
| `GET /v1/geocode?address=`                       | token          | Coordinates for a typed address                                                                                                                  |
| `POST /v1/consents`                              | token          | Records capture consent, once per capture session                                                                                                |
| `GET /v1/flags`                                  | token          | The caller's feature flags (per-user overrides win over global defaults)                                                                         |

Rows keep their database column names (snake_case) and the JSON shape Supabase returned (numbers, ISO timestamps, GeoJSON geometry), so the web app's components port over unchanged.

Sessions: a 15-minute EdDSA access token in the response body (keep it in memory), plus a 30-day refresh token in an `HttpOnly; SameSite=Strict` cookie scoped to `/v1/auth`. Refresh tokens rotate on every use, so a client must not refresh twice in parallel (single-flight); a parallel second refresh looks like a replayed token and ends the session.

Auth endpoints are rate limited in Redis per IP and per account, and fail closed (503) if Redis is down.

## Uploads

Image bytes never pass through the API (plan §5.2):

1. `POST /v1/scans/:id/uploads` with the files' kinds, types and sizes. The API returns one URL per file, valid 15 minutes, that can only **create** that one blob: it can't overwrite, read, or touch any other key.
2. The browser `PUT`s each file straight to Blob Storage with the returned headers.
3. `POST /v1/scans/:id/uploads/:sessionId/complete` with each frame's heading, pitch and sensor payload. The API checks every blob exists with the declared type and an allowed size, then records the frames in one transaction. For a reshoot, `replaceStations` removes the older frames of those viewpoints.

The worker then checks each frame's bytes, strips EXIF (GPS) from JPEGs in place, and writes a 320 px thumbnail. Upload sessions nobody completes are swept, with their blobs, after an hour.

## Worker

`apps/worker` runs without an HTTP API (a small health endpoint on `HEALTH_PORT`, default 3100). Side effects are written to the `outbox` table in the same transaction as the change that causes them; the worker relays them to BullMQ (claiming rows with `FOR UPDATE SKIP LOCKED`, so replicas can share the work) and runs:

| Queue         | Jobs                                                                                          |
| ------------- | --------------------------------------------------------------------------------------------- |
| `blob-gc`     | Delete blob keys, or a whole folder after a space is deleted                                  |
| `media`       | Check a new frame's bytes, strip EXIF, write its thumbnail; remove uploads that aren't images |
| `maintenance` | Every 10 minutes (once across all replicas): sweep abandoned upload sessions                  |

Jobs retry with exponential backoff and are idempotent, so a retry or a duplicate is harmless.

## Database

Migrations are plain SQL in `packages/db/migrations`, applied in order by our own migrator (`pnpm db:migrate`), each in a transaction and recorded with a checksum. Editing an applied migration is an error; add a new one. Migrations must be backward compatible (expand, then contract), because old and new API replicas run side by side during a deploy. Extensions are created by infrastructure, not migrations.

The Drizzle schema in `packages/db/src/schema` is for typed queries only. The SQL is the source of truth; a drift test fails if the two disagree.

Integration tests call `createTestDatabase()` from `@spatial/db/testing`, which creates a throwaway database, bootstraps it like `spatial`, migrates it, and drops it afterwards.

## Tenant isolation

`apps/api/test/route-policy.ts` classifies every route as public, self-scoped or tenant-scoped. `test/tenant-isolation.int.test.ts` fails if any registered route is missing from that file, checks that every non-public route rejects missing and forged tokens, and, for each tenant-scoped route, that another user gets 404 while the owner succeeds. New endpoints must be added there (plan §10.3).

## Local stack

```sh
pnpm infra:up       # start the stack, wait for health checks, create Azurite containers + CORS
pnpm infra:check    # exercise every service the way the app will use it
pnpm infra:down     # stop (data kept)
pnpm infra:reset    # stop and delete all data volumes
```

| Service                              | Host port                                   | What it's for                                                                                                               | Local credentials                                                                                                                              |
| ------------------------------------ | ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Postgres 16 + PostGIS 3.5 + pgvector | 5432                                        | Database; extensions `postgis`, `vector`, `citext`, `pg_trgm` are created on first start                                    | db `spatial`; `app_migrator` / `app_migrator_dev` (DDL, connect directly); `app_rw` / `app_rw_dev` (apps); `postgres` / `postgres` (superuser) |
| PgBouncer (transaction mode)         | 6432                                        | Connection pooling, as in production                                                                                        | `app_rw` / `app_rw_dev`                                                                                                                        |
| Redis 7.4                            | 6379                                        | BullMQ queues, rate limits, cache; runs with `noeviction` and AOF                                                           | none                                                                                                                                           |
| Azurite (Blob)                       | 10000                                       | Azure Blob Storage emulator; containers `scans`, `exports`, `catalog-images`                                                | Azurite's standard dev account (`devstoreaccount1`)                                                                                            |
| Mailpit                              | 1025 SMTP, [8025 UI](http://localhost:8025) | Catches every email the auth module sends, so sign-up and password-reset links can be clicked locally and read by E2E tests | none                                                                                                                                           |
| Ollama (optional)                    | 11434                                       | Local Qwen2.5-VL for development only (D12)                                                                                 | none                                                                                                                                           |

All credentials are local-only development values. To change host ports (for example when another Postgres already uses 5432), copy `infra/docker/.env.example` to `infra/docker/.env`; Compose, `tools/dev-infra`, the migrator, the tests and the API all read it.

`pnpm infra:check` verifies more than connectivity:

- the extensions exist, and PostGIS and pgvector queries work
- `app_rw` has no DDL rights
- a named prepared statement works through PgBouncer in transaction mode
- Redis has the queue-safe settings
- a browser-style upload to a create-only SAS URL succeeds
- an email sent over SMTP arrives in Mailpit

### Local vision model (optional)

```sh
pnpm infra:llm           # start the Ollama container
pnpm infra:llm:models    # pull Qwen2.5-VL and build the context-size variants from infra/docker/ollama/
```

If Ollama is already installed and running on your machine, port 11434 is taken. Either keep using the native Ollama (the infra check detects it, and the app only needs `LLM_LOCAL_BASE_URL=http://localhost:11434/v1`), or set `OLLAMA_PORT` in `infra/docker/.env`.

## Troubleshooting

- **Nest logs or builds behave strangely:** the Console Ninja VS Code extension patches `node_modules/@nestjs/core` to hook its logging. Delete `node_modules` and run `pnpm install` to get clean packages.
- **Azurite rejects the API version:** the Azure SDK can be newer than the latest Azurite release, so Compose starts Azurite with `--skipApiVersionCheck`.
- **Tests or builds crash with "heap out of memory" or "spawn UNKNOWN":** the machine is out of memory (check free virtual memory, not just RAM). Run tests in one process: `pnpm exec vitest run --pool=forks --poolOptions.forks.singleFork`.

## CI

`.github/workflows/ci.yml` runs two jobs on every push to `main` and every pull request:

1. **Checks:** `pnpm format:check`, then lint, typecheck, unit tests and build.
2. **Integration:** builds, starts the Compose stack, runs `pnpm infra:check`, migrates the dev database, runs `pnpm test:integration`, prints service logs on failure, and tears the stack down.

## What's next

Phase 3 (migration plan §17): `packages/pipeline` with the reconstruction pipeline and prompts moved from the original app, the `analysis` endpoint and queue with checkpointed stages, progress over SSE, the privacy purge, Claude Opus 5.5 with refusal fallbacks and rate limiting, and the eval harness in CI.
