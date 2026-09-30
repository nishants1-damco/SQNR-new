# Spatial Capture Platform

The re-platformed Spatial Capture: a TanStack web app, a NestJS/Fastify API and a NestJS worker, on PostgreSQL (PostGIS + pgvector), Redis and Azure Blob Storage. The design and phased roadmap are in [docs/architecture/scaling-migration-plan.md](docs/architecture/scaling-migration-plan.md).

**Status: phase 0 (foundations).** The monorepo, shared packages, local Docker stack and CI exist. The apps arrive in later phases; see [What's next](#whats-next).

## Layout

```
apps/                    web, api, worker (phases 1–4; empty for now)
packages/
  contracts/             zod wire schemas shared by every app        @spatial/contracts
  domain/                pure geometry, solvers, reconciliation      @spatial/domain/<module>
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

## Everyday commands

```sh
pnpm install
pnpm check          # lint + typecheck + test + build, all packages (Turborepo)
pnpm test           # tests only
pnpm format         # Prettier
```

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

All credentials are local-only development values. To change host ports, copy `infra/docker/.env.example` to `infra/docker/.env`; the Compose file and `tools/dev-infra` both read it.

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

## CI

`.github/workflows/ci.yml` runs two jobs on every push to `main` and every pull request:

1. **Checks:** `pnpm format:check`, then lint, typecheck, test and build.
2. **Local stack:** builds and starts the Compose stack, runs `pnpm infra:check`, prints service logs on failure, and tears the stack down.

## What's next

Phase 1 (migration plan §17): `packages/db` with the schema ported from the Supabase migrations, the NestJS `apps/api` skeleton (config, database, Redis, health, logging, OpenAPI), the in-house `AuthModule`, and the tenant-isolation test harness.
