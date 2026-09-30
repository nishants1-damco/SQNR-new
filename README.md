# Spatial Capture Platform

The re-platformed Spatial Capture: a TanStack web app, a NestJS/Fastify API and a NestJS worker, on PostgreSQL (PostGIS + pgvector), Redis and Azure Blob Storage. The design and phased roadmap are in [docs/architecture/scaling-migration-plan.md](docs/architecture/scaling-migration-plan.md).

**Status: phase 1 (data and auth).** The database schema is ported from Supabase, and the API runs with sign-up, sign-in, sessions, email verification and password reset. Scans, uploads and analysis arrive in phases 2–3; see [What's next](#whats-next).

## Layout

```
apps/
  api/                   NestJS 11 on Fastify: auth, health, OpenAPI            @spatial/api
packages/
  config/                validated env for api/worker + local-stack defaults    @spatial/config
  contracts/             zod wire schemas shared by every app                   @spatial/contracts
  db/                    SQL migrations, migrator, Drizzle schema, test DBs     @spatial/db
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
pnpm dev             # API on http://localhost:3000, docs at http://localhost:3000/docs
```

Without a signing key the API makes a new one on every start, which signs everyone out on restart. For a stable key, copy `apps/api/.env.example` to `apps/api/.env` and add the output of `pnpm --filter @spatial/api keys:generate`.

## Everyday commands

```sh
pnpm check              # lint + typecheck + unit tests + build, all packages (Turborepo)
pnpm test               # unit tests only (no Docker needed)
pnpm test:integration   # packages/db and apps/api against the local stack
pnpm db:status          # applied and pending migrations
pnpm format             # Prettier
```

## The API

Every route needs a bearer access token unless it's marked `@Public()`. Errors always use the envelope `{ code, message, details? }` from `@spatial/contracts`.

| Route                                   | Access         | What it does                                                                                                                                     |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /v1/auth/sign-up`                 | public         | Creates the account and signs in (201). Sends a verification email; verifying is not required to sign in, as with the Supabase setup it replaces |
| `POST /v1/auth/sign-in`                 | public         | Email + password. Accounts imported from Supabase keep working (bcrypt, re-hashed to Argon2id on sign-in)                                        |
| `POST /v1/auth/refresh`                 | refresh cookie | New access token; rotates the refresh cookie. Replaying an old refresh token ends that session everywhere                                        |
| `POST /v1/auth/sign-out`                | refresh cookie | Ends the session and clears the cookie                                                                                                           |
| `POST /v1/auth/verify-email`            | public         | Redeems the emailed verification link                                                                                                            |
| `POST /v1/auth/verify-email/resend`     | token          | Sends a new verification email                                                                                                                   |
| `POST /v1/auth/password-reset`          | public         | Always 202, so it can't reveal which emails have accounts                                                                                        |
| `POST /v1/auth/password-reset/confirm`  | public         | Sets the new password and signs out every session                                                                                                |
| `GET /v1/me`                            | token          | The signed-in user                                                                                                                               |
| `GET /.well-known/jwks.json`            | public         | Public keys for verifying access tokens                                                                                                          |
| `GET /health/live`, `GET /health/ready` | public         | Liveness; readiness checks Postgres and Redis                                                                                                    |

Sessions: a 15-minute EdDSA access token in the response body (keep it in memory), plus a 30-day refresh token in an `HttpOnly; SameSite=Strict` cookie scoped to `/v1/auth`. Refresh tokens rotate on every use, so a client must not refresh twice in parallel (single-flight); a parallel second refresh looks like a replayed token and ends the session.

Auth endpoints are rate limited in Redis per IP and per account, and fail closed (503) if Redis is down.

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

Phase 2 (migration plan §17): the storage module with direct-to-Blob SAS uploads, the scans, uploads, consent, flags, geocode and export endpoints, the outbox relay with the `blob-gc` and `media` jobs, and the quota module. Each new resource route gets a tenant-isolation case in `test/route-policy.ts`.
