# Scaling & Platform Migration Plan

**Target:** TanStack (frontend) · NestJS on Fastify (backend) · PostgreSQL · Azure Blob Storage (Azurite locally) · Redis

|              |                                                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Status       | Draft v3 (decisions D1–D14 in §20). Phases 0–2 built; see the repository README                                                    |
| Date         | 2026-09-30                                                                                                                         |
| Scope        | Re-platform Spatial Capture from TanStack Start + Supabase to a separated frontend and backend that can serve ~1M registered users |
| Out of scope | Changing the capture UX, the reconstruction algorithm, or the prompts (they move as-is)                                            |

---

## 1. Summary

Today the app is a TanStack Start (React 19) app with server rendering, built by Nitro for Cloudflare, with Supabase providing Postgres, auth, row-level security (RLS), file storage and pgvector. The browser talks to Supabase directly for most reads and writes, and the single most expensive operation — `analyzeScan`, a ~15-minute multi-pass vision-LLM pipeline — runs inside one HTTP request.

The plan:

1. **Split into three deployables from one monorepo:** a static TanStack Router SPA (`apps/web`), a stateless NestJS/Fastify API (`apps/api`), and a NestJS worker (`apps/worker`) that runs long jobs off a Redis/BullMQ queue.
2. **Move the analysis pipeline out of the request path.** The API validates, claims and enqueues; workers run the pipeline; the browser follows progress over Server-Sent Events (SSE) with a polling fallback.
3. **Move files to Azure Blob Storage** with direct browser-to-blob uploads and downloads through short-lived SAS URLs. The API never proxies image bytes.
4. **Replace Supabase Auth and RLS** with an in-house NestJS auth module (JWT access + rotating refresh tokens) and mandatory ownership checks in the data-access layer, optionally backed by Postgres RLS as defence in depth.
5. **Keep Postgres as the system of record** (PostGIS + pgvector), fronted by PgBouncer, with a read replica for read-heavy endpoints. Redis handles queues, rate limits, caching and pub/sub.
6. **Run Claude Opus 5.5 in production and keep local open-source models** (Qwen2.5-VL via Ollama) as a second provider, chosen per analysis run with separate queues, concurrency limits and deadlines (§9.7).
7. **Migrate incrementally** in phases, each ending in a working system, and finish with a data migration and cutover from Supabase.

The framework change is not what makes the app scale; items 2, 3 and 5 are. They are sequenced early for that reason.

---

## 2. Goals and non-goals

### Goals

- G1. Serve ~1M registered users with a stateless API that scales horizontally.
- G2. Run analysis as durable, retryable, observable background jobs with a global cap on concurrent LLM calls.
- G3. Keep image bytes off the API: direct-to-blob uploads/downloads.
- G4. Fully local development with Docker (Postgres, Redis, Azurite, Mailpit, optional Ollama) and no cloud account.
- G5. Enforce tenant isolation in the backend with automated tests that prove it.
- G6. Keep behaviour parity: every current feature, route and export keeps working.
- G7. Measure cost and latency per scan so capacity can be planned against the LLM budget.

### Non-goals

- Rewriting the reconstruction pipeline, prompts or geometry solvers (they move as-is into a package).
- Server rendering of app pages. The app sits behind login and depends on camera, sensors and microphone; a static SPA is sufficient.
- Multi-region active-active. Single region with zone redundancy is the initial target; the design does not block multi-region later.
- Staying connected to Lovable (see §19, risk R1).

---

## 3. Capacity assumptions

These numbers are **assumptions to validate**, not measurements. Replace them with real analytics before sizing production.

| Parameter                        | Assumption                                 | Notes                                                                                                                |
| -------------------------------- | ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Registered users                 | 1,000,000                                  | Target                                                                                                               |
| Daily active users (DAU)         | 10% → 100,000                              |                                                                                                                      |
| API requests per DAU per day     | ~50                                        | Catalog, space page, polling, uploads bookkeeping                                                                    |
| Average API load                 | ~5M req/day ≈ 60 req/s                     |                                                                                                                      |
| Peak API load                    | ×10 → ~600 req/s                           | Easily handled by a few API replicas                                                                                 |
| Scans per day                    | 2% of DAU → 2,000                          |                                                                                                                      |
| Frames per scan                  | ~30 (4 corners + centre = 32 in auto mode) | From `capture.tsx` instructions                                                                                      |
| Bytes per frame                  | ~400 KB (to measure)                       | JPEG, capped at 20 MB by `upload-validation.ts`                                                                      |
| Storage growth                   | ~12 MB/scan → ~24 GB/day → ~9 TB/year      | Cumulative: frames are kept after analysis (D9), so this adds up year on year. Plus thumbnails, depth files, exports |
| Analysis duration                | ~15 min (cloud), deadline 30 min           | `analysis-deadline.ts`                                                                                               |
| Average concurrent analyses      | 2,000 × 15 min / 1,440 min ≈ 21            |                                                                                                                      |
| Peak concurrent analyses         | ×4 → ~80–100                               |                                                                                                                      |
| LLM calls in flight per analysis | up to 4 (`DETECTION_CONCURRENCY`)          |                                                                                                                      |
| Peak concurrent LLM requests     | ~100–200 typical, ~400 worst case          | **The real ceiling.** Must fit the Opus 5.5 rate limits and budget (§9.7.6)                                          |
| Tokens per scan                  | ~0.8M input, ~100K output (to calibrate)   | §9.7.6                                                                                                               |
| AI cost per scan                 | ~$5.20 at list price, ~$4.10 with caching  | ~$8K–10K/day at 2,000 scans/day before the effort sweep                                                              |

**Conclusion:** the web tier is modest. The binding constraints are (a) LLM provider throughput and cost, (b) long-running work, and (c) storage volume. The architecture is shaped around those.

---

## 4. Current state inventory

### 4.1 Stack

- **Frontend + server:** TanStack Start 1.168 (React 19, TanStack Router file routes, TanStack Query), Vite, Tailwind 4, Radix UI, three.js. Built by Nitro with a Cloudflare target via `@lovable.dev/vite-tanstack-config`.
- **Backend services:** Supabase (Postgres + PostGIS + pgvector, Auth, Storage, RLS).
- **AI:** Anthropic Claude through the official SDK (primary `claude-opus-5-5`, availability fallback `claude-sonnet-5`), optional local Ollama (Qwen2.5-VL), Gemini for catalog embeddings only. The provider is fixed per process by `LLM_PROVIDER`.
- **Other external services:** OpenStreetMap Nominatim for reverse/forward geocoding.

### 4.2 Data model (Postgres, `public` schema)

| Table                                             | Purpose                                                                         | Notes                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `profiles`                                        | Display name per user                                                           | Created by the `handle_new_user` trigger on `auth.users`                                                                                 |
| `scans`                                           | One row per captured space                                                      | Status `draft → processing → ready/failed`; `analysis_notes` jsonb; PostGIS `site_location`, `footprint`; unique `(user_id, capture_id)` |
| `scan_photos`                                     | Frames with pose/sensor payload                                                 | `storage_path` points into the `scans` bucket; PostGIS `camera_pose`                                                                     |
| `scan_objects`, `scan_portals`, `scan_surfaces`   | Reconstruction output                                                           | PostGIS geometry columns                                                                                                                 |
| `scan_layers`, `scan_nav_nodes`, `scan_nav_edges` | L0–L5 layer bundle and navigation graph                                         | PostGIS                                                                                                                                  |
| `scan_analyses`                                   | One row per analysis run: provider, model, prompt version, tokens, cost, status | Metrics source                                                                                                                           |
| `feature_flags`                                   | Global and per-user flags                                                       |                                                                                                                                          |
| `user_rate_limits`                                | Fixed-window counters                                                           | Used by `consume_rate_limit()`                                                                                                           |
| `product_dimensions`                              | Reference product sizes + `vector(768)` embeddings                              | pgvector, `match_product_catalog()`                                                                                                      |
| `capture_consents`                                | Consent audit per capture                                                       |                                                                                                                                          |

SQL functions: `consume_rate_limit`, `match_product_catalog`, `scan_export`, `set_updated_at`, `handle_new_user`.
Extensions: `postgis`, `vector`.
Every user table has an `auth.uid() = user_id` RLS policy; `auth.users` is the FK target for `user_id` columns.

### 4.3 Storage

| Bucket           | Visibility                                   | Path convention                                                                  |
| ---------------- | -------------------------------------------- | -------------------------------------------------------------------------------- |
| `scans`          | Private, RLS on first path segment = user id | `{userId}/{scanId}/frame-{i}.jpg`, `station-{n}-{batch}-{i}.jpg`, `depth-{name}` |
| `catalog-images` | Public                                       | Catalog product images                                                           |

### 4.4 Server functions (14 across 5 files)

| File                      | Functions                                                                 |
| ------------------------- | ------------------------------------------------------------------------- |
| `scan.functions.ts`       | `analyzeScan` (the full pipeline, ~1,500 lines of orchestration)          |
| `space.functions.ts`      | `deleteScan`, `purgePeopleFrames`, `deleteScanPhoto`, `sweepStalledScans` |
| `space-data.functions.ts` | `exportScanData` (WKT rows, layer bundle, IMDF archive, OpenUSD)          |
| `geocode.functions.ts`    | `resolveScanAddress`, `geocodeAddress`                                    |
| `consent.functions.ts`    | `recordCaptureConsent`                                                    |

All use the `requireSupabaseAuth` middleware, which validates the bearer JWT with Supabase and hands the handler an RLS-scoped client.

### 4.5 Browser-side data access (bypasses the server)

| Where                                       | Calls                                                                                                                          |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `routes/auth.tsx`                           | `auth.signUp`, `auth.signInWithPassword`                                                                                       |
| `routes/index.tsx`                          | `scans` list with counts, `storage.createSignedUrls` for thumbnails, `auth.signOut`                                            |
| `routes/space.$id.tsx`                      | `scans`, `scan_objects`, `scan_portals`, `scan_surfaces`, `scan_photos` reads; signed URLs                                     |
| `routes/capture.tsx`                        | `scans` insert/update, `scan_photos` insert/select/delete, `storage.upload`/`remove` for frames and depth files, reshoot flows |
| `lib/analysis-run.ts`                       | Polls `scans.status` every 5 s while an analysis runs                                                                          |
| `lib/feature-flags.ts` / `hooks/useFlag.ts` | `feature_flags` reads                                                                                                          |
| `lib/useAuth.ts`                            | `onAuthStateChange`, `getSession`                                                                                              |

### 4.6 Background work today

- `analyzeScan` runs in the request. Mobile Safari drops the long fetch, so `runAnalysisResilient` falls back to polling.
- The stalled-scan sweep (`sweepStalledScans`) is triggered from the catalog page, not by a scheduler.
- There is no queue, no scheduler and no worker process.

### 4.7 Existing seams worth keeping

- `src/contracts` (zod wire schemas), `src/repos/scan-repo.ts` (repository interface), `src/services/scan-service.ts` (`ensureAnalyzable` idempotency gate) and `src/services/space-deletion.ts` already separate business rules from Supabase. They port directly.
- `src/llm/provider.ts` already abstracts Claude vs Ollama.
- `src/lib/env.server.ts` already validates env with zod.

---

## 5. Target architecture

### 5.1 Components

```
                      ┌──────────────────────────────┐
                      │ Azure Front Door (CDN + WAF) │
                      └──────┬──────────────┬────────┘
                static assets│              │/api/*
                             ▼              ▼
                ┌────────────────┐   ┌──────────────────────────┐
                │ apps/web       │   │ apps/api (NestJS/Fastify)│  N replicas, stateless
                │ TanStack SPA   │   │ auth, scans, uploads,    │
                │ (static files) │   │ exports, SSE, enqueue    │
                └───────┬────────┘   └──┬──────────┬─────────┬──┘
                        │               │          │         │
       SAS PUT/GET      │        ┌──────▼───┐  ┌───▼─────┐   │ enqueue / pub-sub
       (direct)         │        │PgBouncer │  │ Redis   │◄──┘
                        │        └────┬─────┘  │ queue + │
                        ▼             ▼        │ cache   │
               ┌─────────────────┐ ┌─────────┐ └───┬─────┘
               │ Azure Blob      │ │Postgres │     │ BullMQ jobs
               │ (Azurite local) │ │primary +│     ▼
               └────────▲────────┘ │replica  │ ┌──────────────────────────┐
                        │          └────▲────┘ │ apps/worker (NestJS)     │  M replicas,
                        └───────────────┼──────┤ analysis, purge, thumbs, │  scaled on queue depth
                                        └──────┤ maintenance cron         │
                                               └──────────┬───────────────┘
                                                          ▼
                                            Claude / Ollama / Gemini embeddings
```

### 5.2 Key flows

**Upload a capture**

1. `POST /v1/scans` creates the scan row (`status = draft`), idempotent on `capture_id`.
2. `POST /v1/scans/:id/uploads` with a list of frames (index, content type, byte size, sensor payload). The API validates ownership, size and type, and returns one write-only SAS URL per blob (15-minute expiry, single blob, create-only).
3. The browser `PUT`s each frame directly to Blob Storage (4 in parallel, retry with backoff).
4. `POST /v1/scans/:id/uploads/complete` with the uploaded frame list. The API `HEAD`s each blob to verify existence, size and content type, then inserts the `scan_photos` rows in one transaction. A worker later sniffs magic bytes and generates thumbnails.

**Run an analysis**

1. `POST /v1/scans/:id/analysis` → idempotency gate (`ensureAnalyzable`) → per-user quota → conditional claim (`UPDATE scans SET status='processing' … WHERE status <> 'processing' OR deadline passed`) → enqueue BullMQ job with `jobId = analysis:{scanId}:{attempt}` → `202 Accepted { runId }`.
2. A worker picks up the job, acquires LLM concurrency permits, runs the pipeline, checkpoints after each expensive pass, writes results in a transaction, marks the scan `ready` or `failed`.
3. The worker publishes stage changes to Redis (`scan:{id}:events`) and writes the stage into `scans.analysis_notes.stage`.
4. The browser subscribes to `GET /v1/scans/:id/events` (SSE). If SSE drops (mobile background, proxies), it polls `GET /v1/scans/:id/status` every 5 s, as `runAnalysisResilient` does today.

**Read a space**

- `GET /v1/scans/:id` returns the scan with objects, portals, surfaces and photo metadata in one response (replaces 5 parallel browser queries).
- `POST /v1/scans/:id/photo-urls` returns read SAS URLs in batch (replaces `createSignedUrls`). Served from the read replica where possible.

---

## 6. Repository layout

A single monorepo with pnpm workspaces and Turborepo for task caching.

```
spatial-capture/
├─ apps/
│  ├─ web/                 TanStack Router + Query SPA (Vite)
│  ├─ api/                 NestJS + Fastify HTTP API
│  └─ worker/              NestJS application context: BullMQ processors + cron
├─ packages/
│  ├─ contracts/           zod request/response schemas, shared enums, error codes
│  ├─ domain/              pure logic shared by web, api and worker (no I/O)
│  ├─ pipeline/            reconstruction pipeline, prompts, LLM providers (server-only)
│  ├─ db/                  Drizzle schema, migrations, seed, SQL functions
│  ├─ storage/             BlobStore interface + Azure/Azurite implementation
│  ├─ config/              zod-validated env loading shared by api and worker
│  └─ tsconfig/, eslint-config/
├─ infra/
│  ├─ docker/              docker-compose.yml, Postgres image (PostGIS + pgvector)
│  └─ azure/               Bicep or Terraform modules
├─ scripts/                migration and one-off scripts (Supabase export, blob copy, eval)
└─ .github/workflows/
```

Why `apps/worker` is separate from `apps/api` even though both are NestJS: they scale on different signals (HTTP load vs queue depth), have different resource profiles (the pipeline decodes JPEGs and holds large prompts in memory) and different shutdown behaviour (a worker may be mid-way through a 15-minute job). They share modules through `packages/*`.

### 6.1 Where today's code goes

| Current                                                                                                                                                                                                                                                                                                                                                                                         | Target                                                                  | Notes                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `src/routes/*`, `src/components/*`, `src/hooks/*`                                                                                                                                                                                                                                                                                                                                               | `apps/web/src`                                                          | Data access rewritten to the API client                                            |
| Browser-only libs: `acoustics`, `slam`, `capture-draft`, `capture-id`, `frame-quality`, `floor-plan-export`, `pwa-install`, `theme`, `camera-lens`, `capture-perf`                                                                                                                                                                                                                              | `apps/web/src/lib`                                                      | Unchanged                                                                          |
| Pure libs: `analysis-deadline`, `walk-legs`, `wall-ranges`, `graph-solve`, `room-geometry`, `sensor-trust`, `station-health`, `quality-signals`, `reference-sizes`, `sanitize`, `upload-validation`, `frame-selection`, `frame-removals`, `object-reconcile`, `object-scope`, `object-verification`, `inventory-merge`, `shell-check`, `landmarks`, `imdf`, `usd`, `image-crop`, `depth-import` | `packages/domain`                                                       | Must stay I/O-free; add a lint rule that forbids `node:*`, DOM and network imports |
| `scan-analysis.server`, `scan-spatial.server`, `object-verification.server`, `src/llm/*`, `src/prompts/*`                                                                                                                                                                                                                                                                                       | `packages/pipeline`                                                     | Replace every Supabase call with injected repository/BlobStore interfaces          |
| Orchestration inside `analyzeScan`                                                                                                                                                                                                                                                                                                                                                              | `apps/worker` `AnalysisProcessor` + `packages/pipeline` `runAnalysis()` | Split into checkpointed stages (§9.4)                                              |
| `src/contracts`                                                                                                                                                                                                                                                                                                                                                                                 | `packages/contracts`                                                    | Extended to cover every endpoint                                                   |
| `src/repos`, `src/services`                                                                                                                                                                                                                                                                                                                                                                     | `apps/api` / `packages/db` repositories + services                      | Supabase implementation replaced by Drizzle                                        |
| `supabase/migrations/*`                                                                                                                                                                                                                                                                                                                                                                         | `packages/db/migrations`                                                | Ported (§8.2)                                                                      |
| `src/lib/*.functions.ts`                                                                                                                                                                                                                                                                                                                                                                        | NestJS controllers + services                                           | §7.3                                                                               |
| `scripts/*`                                                                                                                                                                                                                                                                                                                                                                                     | `scripts/`                                                              | Rewired to the new config and DB                                                   |

---

## 7. Backend: NestJS on Fastify

### 7.1 Bootstrap

- `NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter({ trustProxy: true, bodyLimit: 1_048_576 }))`. JSON bodies stay small because image bytes never pass through the API.
- Fastify plugins: `@fastify/helmet`, `@fastify/cors` (allowlist of web origins), `@fastify/cookie` (refresh-token cookie), `@fastify/compress`.
- Global: zod validation pipe (`nestjs-zod`) using `packages/contracts`; exception filter mapping domain errors to a stable `{ code, message, details }` shape; request-id interceptor; pino logger (`nestjs-pino`); OpenTelemetry instrumentation.
- URI versioning: every route under `/v1`.
- OpenAPI generated from the zod schemas and served at `/docs` in non-production.
- Graceful shutdown: `app.enableShutdownHooks()`; readiness endpoint turns unhealthy on SIGTERM so the load balancer drains before exit.

### 7.2 Modules

| Module               | Responsibility                                                                                                    |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `ConfigModule`       | zod-validated env (from `packages/config`), fail fast on boot                                                     |
| `DatabaseModule`     | Drizzle over `pg` pools: `primary` and `replica`; transaction helper that also sets `app.user_id` for RLS (§10.3) |
| `RedisModule`        | ioredis connections: `queue` (no eviction) and `cache` (LRU)                                                      |
| `StorageModule`      | `BlobStore` provider: SAS issuing, HEAD, delete, copy; Azurite or Azure by config                                 |
| `QueueModule`        | BullMQ queue registrations (`@nestjs/bullmq`); producers only in the API                                          |
| `AuthModule`         | Sign-up, sign-in, refresh, sign-out, email verification, password reset, JWKS; `JwtAuthGuard` (global)            |
| `UsersModule`        | Profile read/update, account deletion (GDPR), data export                                                         |
| `ScansModule`        | Scan CRUD, list with filters/sort/pagination, detail aggregate, stalled-scan status                               |
| `UploadsModule`      | Upload sessions, SAS issuing, completion verification, photo deletion                                             |
| `AnalysisModule`     | Enqueue analysis and privacy purge, status, SSE events, run history                                               |
| `ExportModule`       | `exportScanData` formats; large exports become jobs that write to Blob and return a download URL                  |
| `GeocodeModule`      | Reverse/forward geocoding behind a provider interface, cached in Redis                                            |
| `CatalogModule`      | Product catalog search (pgvector), catalog images                                                                 |
| `ConsentModule`      | Capture consent audit rows                                                                                        |
| `FeatureFlagsModule` | Flags with Redis cache (60 s TTL) and per-user overrides                                                          |
| `QuotaModule`        | Per-user quotas and global rate limits (§11)                                                                      |
| `HealthModule`       | `/health/live`, `/health/ready` (DB, Redis, Blob checks) via `@nestjs/terminus`                                   |

### 7.3 API surface (mapping from today)

| Today                                    | New endpoint                                                                                         | Notes                                                                                     |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `supabase.auth.signUp`                   | `POST /v1/auth/sign-up`                                                                              | Rate limited per IP and per email                                                         |
| `supabase.auth.signInWithPassword`       | `POST /v1/auth/sign-in`                                                                              | Returns access token; sets refresh cookie                                                 |
| `supabase.auth.signOut`                  | `POST /v1/auth/sign-out`                                                                             | Revokes the refresh-token family                                                          |
| `onAuthStateChange` / `getSession`       | `POST /v1/auth/refresh`, `GET /v1/me`                                                                |                                                                                           |
| —                                        | `POST /v1/auth/verify-email`, `POST /v1/auth/password-reset`, `POST /v1/auth/password-reset/confirm` |                                                                                           |
| Catalog list query (`index.tsx`)         | `GET /v1/scans?cursor=&limit=&q=&status=&sort=`                                                      | Keyset pagination on `(created_at, id)`; includes object/portal counts and thumbnail path |
| `createSignedUrls` for thumbnails        | `POST /v1/scans/photo-urls` `{ paths[] }`                                                            | Batch read SAS; ownership check on each path                                              |
| 5 reads in `space.$id.tsx`               | `GET /v1/scans/:id`                                                                                  | Single aggregate response                                                                 |
| `scans` insert (`capture.tsx`)           | `POST /v1/scans`                                                                                     | Idempotent on `capture_id`                                                                |
| `scans` update (name, notes, depth path) | `PATCH /v1/scans/:id`                                                                                | Whitelisted fields only                                                                   |
| `storage.upload` + `scan_photos` insert  | `POST /v1/scans/:id/uploads` → direct PUT → `POST /v1/scans/:id/uploads/complete`                    | §5.2                                                                                      |
| Depth file upload                        | same upload flow with `kind: "depth"`                                                                |                                                                                           |
| Reshoot: replace frames of one station   | `POST /v1/scans/:id/stations/:station/reshoot` (+ upload flow)                                       | Old frames deleted only after the new set is committed                                    |
| `deleteScanPhoto`                        | `DELETE /v1/scans/:id/photos/:photoId`                                                               | Blob deleted by an outbox job after the row commit                                        |
| `deleteScan`                             | `DELETE /v1/scans/:id`                                                                               | Row cascade + async blob prefix deletion                                                  |
| `analyzeScan`                            | `POST /v1/scans/:id/analysis` → `202`                                                                | §9                                                                                        |
| Polling in `analysis-run.ts`             | `GET /v1/scans/:id/status`, `GET /v1/scans/:id/events` (SSE)                                         |                                                                                           |
| `purgePeopleFrames`                      | `POST /v1/scans/:id/privacy-purge` → `202`                                                           | Job; quota as today                                                                       |
| `sweepStalledScans`                      | Worker cron job                                                                                      | Removed from the browser                                                                  |
| `exportScanData`                         | `GET /v1/scans/:id/export?format=wkt\|layers\|imdf\|usd`                                             | Small: inline; large: `202` + job + download URL                                          |
| `resolveScanAddress`                     | `POST /v1/scans/:id/address`                                                                         |                                                                                           |
| `geocodeAddress`                         | `GET /v1/geocode?q=`                                                                                 | Cached                                                                                    |
| `recordCaptureConsent`                   | `POST /v1/consents`                                                                                  |                                                                                           |
| `feature_flags` read                     | `GET /v1/flags`                                                                                      | Returns the caller's effective flags                                                      |

Conventions: JSON only; error envelope `{ code, message, details? }`; `Idempotency-Key` header accepted on every `POST` that creates something (stored in Redis for 24 h); ETags on `GET /v1/scans/:id` for cheap revalidation.

### 7.4 Data access

- **ORM:** Drizzle (`drizzle-orm`) for typed queries. It keeps SQL visible, supports raw SQL for PostGIS, pgvector, `ON CONFLICT` and the existing SQL functions, and has no separate engine binary.
- **Migrations (as built in phase 1):** SQL-first, not `drizzle-kit`. Plain `.sql` files in `packages/db/migrations`, applied by a small migrator with checksums and an advisory lock. The schema relies on PostGIS types, triggers and SQL functions that `drizzle-kit` can't express, so SQL is the source of truth and an integration test fails if the Drizzle schema drifts from the migrated database.
- **Repositories** own every query. Each user-facing repository method takes `userId` as a required argument and includes it in the `WHERE` clause. Controllers never touch Drizzle directly.
- **Transactions:** analysis result writes (delete old objects/surfaces/portals/layers/nav graph, insert new ones, update scan) happen in one transaction. Today they are separate calls and can leave a half-written scan.
- **Outbox pattern** for side effects after commit (blob deletion, thumbnail generation, emails): write an `outbox` row in the same transaction; a worker relays it to BullMQ. This avoids "row deleted but blob remains" or "job enqueued but transaction rolled back".

---

## 8. Database: PostgreSQL

### 8.1 Engine and extensions

- PostgreSQL 16 with **PostGIS** and **pgvector**.
- Local image: `FROM postgis/postgis:16-3.4` plus the `postgresql-16-pgvector` package (neither official image ships both).
- Production: Azure Database for PostgreSQL – Flexible Server. Both extensions are on its allowlist; enable them via the `azure.extensions` server parameter. Zone-redundant HA, point-in-time restore, one read replica.

### 8.2 Porting the Supabase migrations

Squash the 16 Supabase migrations into a single baseline migration in `packages/db`, then continue with Drizzle migrations. Changes while porting:

| Supabase construct                                             | Replacement                                                                                                                       |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `auth.users` FK target                                         | New `public.users` table (`id uuid pk`, `email citext unique`, `password_hash`, `email_verified_at`, `created_at`, `disabled_at`) |
| `handle_new_user` trigger on `auth.users`                      | Profile row created in the sign-up transaction by `AuthModule`                                                                    |
| `auth.uid() = user_id` RLS policies                            | Removed in phase 1; optionally re-added as `current_setting('app.user_id')::uuid = user_id` policies (§10.3)                      |
| `storage.objects` policies                                     | Removed; enforced by the API when issuing SAS                                                                                     |
| `grant … to authenticated/anon/service_role`                   | Two DB roles: `app_rw` (API and worker) and `app_migrator` (DDL); no direct client access                                         |
| `consume_rate_limit()`                                         | Kept initially; replaced by Redis in phase 5 (§11)                                                                                |
| `match_product_catalog()`, `scan_export()`, `set_updated_at()` | Kept as-is                                                                                                                        |
| `spatial_ref_sys` RLS workaround                               | Dropped (no client access)                                                                                                        |

New tables:

| Table                  | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `users`                | Identity (above)                                                                                          |
| `auth_refresh_tokens`  | `id`, `user_id`, `family_id`, `token_hash`, `expires_at`, `revoked_at`, `replaced_by`, `user_agent`, `ip` |
| `auth_email_tokens`    | Email verification and password reset tokens (hashed, single use, short expiry)                           |
| `upload_sessions`      | Issued SAS batches per scan: expected blobs, expiry, completed flag                                       |
| `outbox`               | Transactional outbox for post-commit side effects                                                         |
| `analysis_checkpoints` | Per-run stage outputs (jsonb) so retries resume instead of re-paying for LLM passes                       |

### 8.3 Indexes to add

- `scans (user_id, created_at desc, id)` for the catalog list with keyset pagination. Today only `(user_id, capture_id)` exists.
- `scans (status, updated_at)` partial index `WHERE status = 'processing'` for the stalled-scan sweep.
- `scan_photos (scan_id, idx)`, `scan_objects (scan_id)`, `scan_portals (scan_id)`, `scan_surfaces (scan_id)`. None exist today, so every space-page read and every re-analysis delete scans these tables by sequential scan as they grow.
- Trigram index on `scans.name` if catalog search stays `ILIKE`-based.
- Keep the existing HNSW index on `product_dimensions.embedding` (`vector_cosine_ops`).

### 8.4 Connections and scaling

- **PgBouncer** in transaction mode in front of the primary (Azure Flexible Server has built-in PgBouncer). API and worker pools are small (e.g. 10 per process); PgBouncer multiplexes them onto ~100 server connections.
- Transaction pooling means no session state across statements: use `SET LOCAL` inside transactions only, and use PgBouncer ≥ 1.21 with protocol-level prepared statement support (or disable prepared statements in the driver).
- **Read replica** for `GET /v1/scans`, `GET /v1/scans/:id` and exports. Writes, and reads immediately after a write by the same user, go to the primary (read-your-writes: route to primary for N seconds after a user's write, tracked in Redis).
- **Growth:** `scan_analyses` and `outbox` grow fastest; partition by month once they pass ~50M rows. `scan_photos` sits at ~30 rows per scan → ~20M rows/year at the assumed load, which is fine unpartitioned with the indexes above.
- `analysis_notes` jsonb is already large; keep bulky debug data in `analysis_checkpoints` or Blob, not on the hot `scans` row.

---

## 9. Background jobs: Redis + BullMQ

### 9.1 Queues

| Queue                      | Producer         | Job                                                                            | Concurrency / limits                                    |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| `analysis-cloud`           | API              | Full reconstruction pipeline on Claude Opus 5.5 (§9.7)                         | Per-worker concurrency 2–4; global LLM semaphore (§9.3) |
| `analysis-local`           | API              | Full reconstruction pipeline on a local open-source model (§9.7); **dev only** | Concurrency = local model slots (usually 1)             |
| `analysis-batch`           | Admin/API        | Non-urgent re-analysis through the Message Batches API (§9.7.5)                | Batch submission size, not a semaphore                  |
| `privacy-purge`            | API              | Re-screen all frames for people, delete matches                                | Shares the LLM semaphore of the run's provider          |
| `media`                    | Outbox relay     | Magic-byte validation, thumbnails, EXIF strip                                  | CPU-bound; higher concurrency                           |
| `blob-gc`                  | Outbox relay     | Delete blobs/prefixes after row deletion                                       | I/O-bound                                               |
| `export`                   | API              | Large IMDF/USD exports to Blob                                                 | Low                                                     |
| `geocode`                  | API              | Reverse geocode after capture                                                  | Respect provider rate limits                            |
| `catalog-embed`            | Admin script/API | (Re)embed product catalog                                                      | Low, admin-only                                         |
| `maintenance` (repeatable) | Worker scheduler | Stalled-scan sweep, orphan blob sweep, expired upload sessions, token cleanup  | Singleton                                               |

Configuration:

- Job ids are deterministic (`analysis:{scanId}:{attempt}`) so double submits collapse into one job. The API picks the queue from the run's provider (§9.7.1); the job payload carries `provider` and `model` so a worker never guesses.
- `attempts: 3` with exponential backoff, **only for retryable errors** (network, 5xx, provider 429/overload). Validation errors, auth errors and "no usable frames" fail immediately. This mirrors the existing `callWithFallback` rule of not retrying rate-limit or API-key errors on another model.
- `removeOnComplete` / `removeOnFail` with age limits so Redis doesn't grow without bound; the durable record lives in `scan_analyses`.
- Stalled-job detection (BullMQ's lock renewal) replaces the browser-driven `sweepStalledScans`; the `maintenance` job still reconciles `scans.status` against `deadline_at` as a safety net.

### 9.2 Redis deployment rules

- **Two logical Redis instances in production:** `redis-queue` with `maxmemory-policy noeviction` and AOF persistence (BullMQ must never have keys evicted), and `redis-cache` with `allkeys-lru`.
- Locally one Redis container is fine with `noeviction`.
- Production: Azure Cache for Redis (Standard or Premium tier for the queue instance, with persistence).

### 9.3 Controlling LLM spend and throughput

- **Global semaphore** in Redis, one per provider (`llm:permits:claude`, sized to the Opus 5.5 rate limit with headroom; `llm:permits:local`, sized to the local model, dev only). Every LLM call in `packages/pipeline` acquires a permit, with a timeout, and releases it in `finally`. `DETECTION_CONCURRENCY` stays as the per-run cap.
- **Token-bucket limiter** per provider/model for requests per minute and tokens per minute, fed by the usage numbers `usage-tracker.server.ts` already records.
- **Priority:** BullMQ priorities let paid or first-time users go ahead of re-analysis requests.
- **Budget guard:** a daily spend counter per user and globally; over budget → the job is delayed and the user sees a clear message.
- **Backpressure:** when queue wait time passes a threshold, `POST /analysis` still accepts but returns an estimated start time; beyond a hard limit it returns `503` with `Retry-After`.

### 9.4 Checkpointed pipeline

Split `analyzeScan` into stages that each persist their output to `analysis_checkpoints` (jsonb or a Blob for large payloads):

1. `load` – frame metadata, sensor payloads, blob keys
2. `inventory` – per-viewpoint detection + landmark spotting
3. `pass1` – reconstruction
4. `graph` – graph solve
5. `catalog` – product-catalog RAG
6. `verify` – zoom-in verification + visual catalog match
7. `pass2` – geometric audit + critique
8. `constraints` – metric scale, walked perimeter, acoustic ranging, clamps, anchors, wall snapping, relationship repair (pure, cheap)
9. `persist` – single transaction writing objects, surfaces, portals, layers, nav graph, frame poses
10. `privacy` – people purge
11. `finalize` – `scan_analyses` metrics, status `ready`

On retry the worker skips stages that already have a checkpoint for the run. This matters because workers are replaced during deploys and scale-in, and a 15-minute job should not restart from zero or pay for LLM passes twice.

### 9.5 Worker lifecycle

- `apps/worker` boots a NestJS application context (no HTTP server except a small health endpoint).
- On SIGTERM: stop taking new jobs (`worker.close()` waits for active jobs), with a termination grace period sized to the longest _stage_, not the whole run. Checkpoints make interrupted runs resumable.
- Image loading uses the `BlobStore` (stream download, decode with `jpeg-js` as today). Limit memory by processing viewpoints in batches.

### 9.6 Progress to the browser

- Worker: `PUBLISH scan:{id}:events {stage, pct, message}` and update `scans.analysis_notes.stage`.
- API: `GET /v1/scans/:id/events` is an SSE stream subscribed to that channel, with heartbeats every 15 s; ownership checked before subscribing.
- Browser: `EventSource`; on error falls back to polling `GET /v1/scans/:id/status`. SSE connections are cheap on Fastify, but an API replica should cap concurrent streams, and Front Door/idle timeouts must allow long-lived responses (heartbeats keep them alive).

### 9.7 Model providers: Claude Opus 5.5 and local open-source models

**Decision (D5):** Claude Opus 5.5 (`claude-opus-5-5`) is the production model. Local open-source vision models served by Ollama (today `qwen2.5vl-3b-48k` and the other `Modelfile.qwen2.5vl-*` variants) stay as a supported provider.

The current code already has most of what this needs:

- `src/llm/provider.ts` switches between `claude` and `ollama` through `LLM_PROVIDER`, and `getAnthropicModel()` in `env.server.ts` already defaults to `claude-opus-5-5`.
- `src/llm/claude.server.ts` calls Claude through the official `@anthropic-ai/sdk` with streaming (`messages.stream().finalMessage()`), native structured outputs (`output_config.format`), an explicit effort level per step, and `max_tokens: 64000`.
- The local path sends the same OpenAI-style messages to Ollama's `/v1/chat/completions` with smaller frame budgets (`LOCAL_MAX_FRAMES = 14`, centre 8, corner 2) and a 3-hour deadline (`LOCAL_ANALYSIS_DEADLINE_MS`).
- Every call is recorded by `usage-tracker.server.ts` (tokens, cache tokens, stop reason, latency) and summed into `scan_analyses`.

What changes in the new platform:

#### 9.7.1 Provider per run, not per process

Today one environment variable fixes the provider for the whole process. In the new platform the provider is chosen **per analysis run** and stored on the run (`scan_analyses.provider`, `model_version`):

- `packages/pipeline` exposes an `LlmProvider` interface (`complete(messages, { schema, effort, step })`) with `ClaudeProvider` and `LocalOpenAICompatProvider` implementations, plus the provider-specific frame budgets. The existing modules move behind it unchanged.
- **Production uses Claude only (D12, decided 2026-09-30).** The local provider is enabled in development and CI; in staging and production the API rejects a `local` run and no worker consumes `analysis-local`.
- In development the provider comes from `LLM_DEFAULT_PROVIDER`, with a per-run override for developers, so switching between Claude and Qwen doesn't need a restart. A run never switches provider midway, because results and deadlines differ.
- Each provider has its own queue (`analysis-cloud`, `analysis-local`), semaphore and deadline.
- The eval harness runs against both providers so quality differences are measured, not assumed.

#### 9.7.2 Claude Opus 5.5 request rules

These are properties of Opus 5.5 the pipeline must respect. The current code already complies with the first four; keep them enforced in `ClaudeProvider` so later changes can't break them.

| Rule                                                                | Why                                                                                                                                                       | Current code                                                                                                         |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Never send `thinking: {type: "disabled"}` or `budget_tokens`        | Thinking is always on in Opus 5.5; both return 400. Omit `thinking` (adaptive)                                                                            | Compliant (field omitted)                                                                                            |
| Set `output_config.effort` explicitly on every call                 | The Opus 5.5 default is `medium`, one level below Opus 5                                                                                                  | Compliant: `high` for inventory, landmarks, reconstruction, critique; `medium` for people screening and verification |
| No forced `tool_choice` (`any` / `tool`), no assistant prefill      | Both return 400; use structured outputs for JSON                                                                                                          | Compliant (structured outputs)                                                                                       |
| Stream long requests and size `max_tokens` for thinking plus output | Thinking counts toward `max_tokens`                                                                                                                       | Compliant (streaming, 64K)                                                                                           |
| Handle `stop_reason: "refusal"` and opt into refusal fallbacks      | Opus 5.5 runs broader safety classifiers (`cyber`, `bio`, `reasoning_extraction`); false positives on benign room photos are unlikely but possible        | Partial: a refusal throws, and `callWithFallback` retries once on `ANTHROPIC_FALLBACK_MODEL`                         |
| Keep each call single-turn                                          | Opus 5.5 thinking blocks are bound to the model and conversation; the pipeline sends one user message per call, so there is no history to keep consistent | Compliant                                                                                                            |

Refusal handling to add in phase 3:

- On the **Claude API**, send the server-side fallback parameter `fallbacks: "default"` with the `server-side-fallback-2026-07-01` beta header, so a classifier decline is re-run on the model Anthropic recommends for that category inside the same request. Record in `usage-tracker` which model actually served the call (`response.model`, `usage.iterations`).
- `reasoning_extraction` declines are not retried on a fallback; treat them as a prompt bug and alert.
- Claude is accessed through **Anthropic's own API (D11, decided 2026-09-30)**, where server-side fallbacks are available. They are not available on the Batches API, so the batch lane (§9.7.5) keeps the existing `callWithFallback`-style retry for refused items.
- Keep `ANTHROPIC_FALLBACK_MODEL` (default `claude-sonnet-5`) for **availability** failures (overload, 5xx), which is a different concern from refusals.

#### 9.7.3 Effort and cost tuning

- Anthropic reports that Opus 5.5 at `medium` matches or beats Opus 5 at `high` on many tasks, and that it reads visual material more accurately at every effort level. The pipeline's `high` settings were chosen for earlier models.
- **Run an effort sweep per step** (`low` / `medium` / `high`) on the eval fixtures before launch and pick the cheapest level that holds quality for each step. The `step` label on every recorded call already gives per-step cost and latency.
- Re-test whether the zoom-in verification pass (`object-verification.server.ts`) still pays for itself on Opus 5.5. Scaffolding built for weaker vision may no longer be needed; measure before removing it.
- Do not use fast mode. It costs twice as much per token and latency is not the constraint for a queued job.

#### 9.7.4 Prompt caching

The pipeline does not set `cache_control` today, although the usage tracker already records cache tokens.

- The per-viewpoint detection calls share the same system prompt and capture-protocol preamble. Put those first, mark the end of that shared prefix with `cache_control`, and put the per-viewpoint frames after it. Calls within the cache TTL then read the prefix at the cache-read rate.
- The minimum cacheable prefix on this model family is 512 tokens; verify hits with `cache_read_input_tokens`.
- **The biggest caching opportunity is across passes.** The landmarks, reconstruction (pass 1) and critique (pass 2) calls each send the same ~40 frames (~150K image tokens), but each has its own system prompt, so nothing is shared. Restructuring them to share one system prompt and frame block, with the pass-specific instructions after the frames, would let passes 2 and 3 read ~150K tokens each at 5% of the input price: roughly **$1 saved per scan, about 20% of its estimated cost** (§9.7.6). It changes prompt layout, so validate it with the eval harness before adopting it.

#### 9.7.5 Batch lane for non-urgent work

The Message Batches API costs half the standard rate but can take hours and doesn't support server-side fallbacks. Use it only where nobody is waiting:

- Re-analysing existing scans after a prompt or model upgrade (`prompt_version` bump).
- Scheduled eval runs.

Interactive analyses always use the standard API through `analysis-cloud`.

#### 9.7.6 Rate limits and capacity for Claude Opus 5.5

Anthropic limits each model on **requests per minute (RPM), input tokens per minute (ITPM) and output tokens per minute (OTPM)**. Opus 5.5 has its own pool (confirm at launch), and it has no Priority Tier, so capacity comes only from the granted limits plus queueing. The numbers below are derived from the pipeline's shape. They are **estimates to calibrate** against real `scan_analyses` token counts as soon as the first scans run on Opus 5.5.

**Per-scan token model (cloud run):**

| Item                                         | Estimate                                | Basis                                                                                    |
| -------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------- |
| Frames per full frame set                    | up to 40                                | `MAX_FRAMES = 40` for cloud in `scan-analysis.server.ts`                                 |
| Tokens per frame                             | ~3.7K                                   | 1920×1440 frames (`FRAME_MAX_EDGE`), per the comment in `capture.tsx`                    |
| One full frame set                           | ~150K tokens                            | 40 × 3.7K                                                                                |
| Calls that send a full frame set             | 5                                       | people screen, inventory batches (together one set), landmarks, reconstruction, critique |
| Verification crops, prompts, text-only merge | ~60K tokens                             | Assumption                                                                               |
| **Input per scan**                           | **~0.8M tokens**                        | 5 × 150K + 60K                                                                           |
| **Output per scan (includes thinking)**      | **~100K tokens**                        | Assumption: ~15 calls at `high` / `medium` effort                                        |
| Calls per scan                               | ~15                                     |                                                                                          |
| **Cost per scan at list price**              | **~$5.20** ($3.20 input + $2.00 output) | $4 / $20 per million tokens                                                              |
| With cross-pass frame caching (§9.7.4)       | ~$4.10                                  | Two frame sets read at $0.20 per million                                                 |

At the §3 target of 2,000 scans a day that is roughly **$8K–10K a day (~$250K–310K a month)** before the effort sweep. That is the most important number in this plan to validate early.

**Throughput needed:**

| Stage         | Scans/day | Peak ITPM | Peak OTPM | Peak RPM | In-flight requests (`LLM_PERMITS_CLAUDE`) |
| ------------- | --------- | --------- | --------- | -------- | ----------------------------------------- |
| Internal beta | 100       | ~250K     | ~30K      | ~10      | 16                                        |
| Public launch | 500       | ~1.2M     | ~150K     | ~25      | 64                                        |
| Target (§3)   | 2,000     | ~4.5M     | ~560K     | ~85      | 200                                       |

Peaks use the §3 factor of 4 over the daily average. In-flight requests follow from Little's law: ~1.4 requests/s at peak × 60–120 s per large vision call ≈ 85–170, rounded up to 200.

**Limits to request from Anthropic** (about 30% above the target peak to absorb bursts, because a scan's tokens arrive in a few large calls rather than evenly):

| Limit | Request for `claude-opus-5-5` |
| ----- | ----------------------------- |
| ITPM  | 6M                            |
| OTPM  | 750K                          |
| RPM   | 300                           |

These volumes are far above the standard self-serve tiers, so raise custom limits with Anthropic sales well before launch. Ask whether cache reads count toward ITPM for Opus 5.5; if they don't, cross-pass caching also cuts the ITPM needed by about a third. Check granted limits and actual usage with the Admin API rate-limit reports.

**App-side enforcement (in `packages/pipeline`, shared by all workers through Redis):**

- **Token buckets** for ITPM, OTPM and RPM, each set to **85% of the granted limit** (`LLM_ITPM_LIMIT`, `LLM_OTPM_LIMIT`, `LLM_RPM_LIMIT`). Before a call, reserve its estimated input tokens (images × 3.7K + text length / 4) and a conservative output reservation. After the call, settle against the actual `usage`.
- **Concurrency cap:** `LLM_PERMITS_CLAUDE` from the table above for the current stage.
- **Adaptive back-off:** read the `anthropic-ratelimit-*` response headers (remaining and reset) to track real headroom. On a 429, honour `retry-after`, halve the bucket refill rate for a minute, then ramp back up.
- **Retries:** keep the SDK's default retries (2) for brief transient errors. Longer outages go through the BullMQ job retry with backoff, resuming from checkpoints (§9.4).
- **Batch lane:** Message Batches have their own limits (confirm) and don't draw from these buckets.

**Per-user limits and budgets (replaces the §11 defaults):**

| Control                 | Today   | Recommended                                                                                   | Reason                                                      |
| ----------------------- | ------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `analyze_scan` per user | 30/hour | **5/hour and 20/day** (per plan, configurable)                                                | At ~$5 a scan, 30/hour lets one account spend ~$150 an hour |
| `purge_people` per user | 10/hour | 10/hour (unchanged)                                                                           | One frame set, about $0.60 a run                            |
| Per-user daily AI spend | none    | **$25/day** default, higher for paid plans                                                    | Stops runaway accounts even inside the count limits         |
| Global daily AI spend   | none    | Alert at 80%, stop new runs at 100% of a budget sized to the stage (e.g. ~$12K/day at target) | Protects against bugs and abuse                             |

Prices at launch: $4 / $20 per million input/output tokens, cache reads $0.20, batch $2 / $10. Confirm current pricing before budgeting.

#### 9.7.7 Local open-source models

- **Local development:** unchanged. The `ollama` Compose profile runs Qwen2.5-VL using the repo's `Modelfile.qwen2.5vl-*` files.
- **Production: not deployed (D12, decided 2026-09-30).** Local models are for development, CI and offline evaluation only. If a GPU pool is ever needed (cost fallback, data residency), `LocalOpenAICompatProvider` and the `analysis-local` queue already make it a deployment change rather than a code change.
- Local runs keep their own frame budgets and the 3-hour deadline.
- Embeddings stay independent of the generation provider (`EMBEDDING_PROVIDER`): Gemini in the cloud or Ollama locally, 768 dimensions to match `vector(768)`.

#### 9.7.8 Fixes to carry over from the current code

- `src/llm/usage.ts` applies a flat 10% cache-read factor. Opus 5.5 cache reads are $0.20 per million, 5% of its input price, so per-model cache factors are needed for accurate cost numbers.
- `estimateCostUsd` returns `null` when any call used a model without a price, so a run with local-model calls reports no cost at all. Price local calls at zero (or at an internal GPU cost per second) so mixed and local runs still report a number.
- `.env.example` describes `ANTHROPIC_MODEL` as "OpenAI-compat", but Claude is called through the native SDK. Fix the comment.

---

## 10. Authentication and authorization

### 10.1 Decision

**Decided (D1, 2026-09-30): an in-house `AuthModule` in NestJS**, behind an `IdentityProvider` interface so a managed IdP can replace it later.

Reasons:

- Current auth is email + password only; the scope is small and well understood.
- Supabase stores **bcrypt** hashes in `auth.users.encrypted_password`. An in-house module can import them and verify with bcrypt, then re-hash to Argon2id on the user's next sign-in, so **no user has to reset their password**. Managed IdPs generally need a forced reset or a just-in-time migration flow.
- It runs fully offline in Docker (G4).

Revisit later if you need social login, MFA, enterprise SSO or compliance certifications: Microsoft Entra External ID or Keycloak can replace the module behind the same interface.

### 10.2 Token design

- **Access token:** JWT, 15-minute expiry, asymmetric signing (EdDSA or RS256), `sub = user id`, `sid = refresh family id`. Signing key in Azure Key Vault; public keys published at `/.well-known/jwks.json` with `kid` rotation.
- **Refresh token:** opaque random 256-bit value, 30-day sliding expiry, stored **hashed** in `auth_refresh_tokens`, **rotated on every use**. Reuse of an already-rotated token revokes the whole family (theft detection).
- **Transport:** access token in memory in the SPA and sent as `Authorization: Bearer`; refresh token in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/v1/auth/refresh`. Serve web and API from the same site (e.g. `app.example.com` and `api.example.com`) so the cookie works without third-party cookie issues. CSRF risk is limited to the refresh endpoint and is covered by `SameSite=Strict` plus an `Origin` check.
- **Passwords:** Argon2id (`argon2` package); bcrypt verify only for imported hashes. Minimum length and a breached-password check.
- **Abuse protection:** per-IP and per-account rate limits on sign-in, sign-up and reset; progressive delay after failures; generic error messages.
- **Email:** verification and password reset through Azure Communication Services Email in production, Mailpit locally. Match whatever confirmation behaviour the Supabase project currently has.

### 10.3 Authorization (replacing RLS)

RLS currently guarantees tenant isolation even if a query forgets a filter. The new design must give the same guarantee:

1. **Mandatory:** every repository method for user data requires `userId` and filters on it. Missing or foreign rows return **404**, never 403 (don't reveal existence).
2. **Mandatory:** a blob-path guard. SAS is only issued for keys under `{userId}/…` that also match a row the user owns.
3. **Mandatory:** an automated tenant-isolation test suite. For every endpoint, user B tries user A's ids and must get 404. Runs in CI against real Postgres.
4. **Recommended (phase 5):** re-enable Postgres RLS as defence in depth. Each request transaction runs `SET LOCAL app.user_id = '<uuid>'`, and policies check `user_id = current_setting('app.user_id')::uuid`. `SET LOCAL` is compatible with PgBouncer transaction pooling. Workers use a separate role with `BYPASSRLS` only for cross-user maintenance jobs.

The existing `scripts/audit-rls.ts` can be adapted to verify that every user table has either a policy or an explicit exemption.

---

## 11. Rate limiting and quotas

| Layer             | Mechanism                              | Limits (initial)                                                                             |
| ----------------- | -------------------------------------- | -------------------------------------------------------------------------------------------- |
| Edge              | Front Door WAF rate rules              | Coarse per-IP flood protection                                                               |
| API global        | `@nestjs/throttler` with Redis storage | e.g. 300 req/min per user, 60 req/min per IP for anonymous endpoints                         |
| Auth              | Dedicated limits                       | Sign-in 10/min per IP and 5/min per account                                                  |
| Expensive actions | `QuotaModule`                          | `analyze_scan` 5/hour and 20/day, `purge_people` 10/hour; per-user $25/day AI spend (§9.7.6) |
| Spend             | Daily budget counter per user + global | Configurable                                                                                 |
| LLM               | Global semaphore + token bucket (§9.3) | Sized to provider limits                                                                     |

`QuotaModule` keeps today's semantics (fail closed when the limiter is unavailable; charge only work that will actually run) and moves storage from the `consume_rate_limit` SQL function to an atomic Redis Lua script (sliding-window log or GCRA). Keep the SQL function during the transition so both paths can be compared.

---

## 12. Storage: Azure Blob Storage / Azurite

### 12.1 Layout

| Container        | Access                         | Key format                                                                                                                      |
| ---------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| `scans`          | Private                        | `{userId}/{scanId}/frames/{station}-{batch}-{idx}.jpg`, `{userId}/{scanId}/depth/{name}`, `{userId}/{scanId}/thumbs/{idx}.webp` |
| `exports`        | Private                        | `{userId}/{scanId}/{exportId}.{zip\|usdz\|json}` (lifecycle delete after 7 days)                                                |
| `catalog-images` | Public read through Front Door | `{productId}/{variant}.webp`                                                                                                    |

Existing keys (`{userId}/{scanId}/frame-{i}.jpg` etc.) are copied as-is during migration and remain valid; `storage_path` values don't need rewriting. New uploads use the new layout.

### 12.2 `BlobStore` interface (`packages/storage`)

```ts
interface BlobStore {
  presignPut(key: string, opts: { contentType: string; expiresInSec: number }): Promise<string>;
  presignGet(key: string, opts: { expiresInSec: number; downloadName?: string }): Promise<string>;
  head(key: string): Promise<{ size: number; contentType: string; etag: string } | null>;
  get(key: string): Promise<NodeJS.ReadableStream>;
  put(key: string, body: Buffer | NodeJS.ReadableStream, contentType: string): Promise<void>;
  delete(keys: string[]): Promise<void>;
  deletePrefix(prefix: string): Promise<number>;
}
```

Implemented with `@azure/storage-blob`. The same code talks to Azurite and Azure; only the connection settings differ.

### 12.3 SAS policy

- **Production:** user-delegation SAS, signed with a key obtained through the API's managed identity. No account keys in the app.
- **Local (Azurite):** account-key SAS using Azurite's well-known development account.
- No storage credential ever reaches the browser. The account key (Azurite) or managed identity (Azure) stays in the API; the browser only receives individual signed URLs.
- Write SAS: single blob, permission `c` only (create a new blob, cannot overwrite an existing one), 15-minute expiry, `Content-Type` fixed at issue time.
- Storage account: anonymous blob access disabled and shared-key access disabled in production (user-delegation SAS still works), so a leaked connection string or public URL is useless.
- Read SAS: single blob, `r`, 1-hour expiry (matches today's `createSignedUrls(paths, 3600)`).
- SAS cannot enforce a maximum size, so `uploads/complete` checks size with `HEAD`, and the `media` job validates magic bytes (reusing `upload-validation.ts`). Blobs that fail are deleted and the row is not created. Uncompleted upload sessions are garbage-collected by the `maintenance` job.

### 12.4 Operational settings

- CORS on the storage account (and Azurite) allowing `PUT`/`GET`/`HEAD` from the web origins with the `x-ms-blob-type` and `Content-Type` headers.
- **Frame retention (D9, decided 2026-09-30): frames are kept after analysis** for the life of the scan. They are deleted only when the user deletes a photo, the scan or their account, or when the privacy purge removes frames that contain people. Keeping them preserves reshoots, re-analysis after prompt/model upgrades, the batch re-analysis lane (§9.7.5) and the photo views on the space page.
- Lifecycle management: frames move to the Cool tier after 30 days and Cold after 180 days (tune to real access patterns). **Never use the Archive tier for frames**, because re-analysis and the space page need them online immediately. Cool and Cold have minimum retention periods and higher read costs, so tune the thresholds against how often old scans are actually reopened. Thumbnails stay in Hot. Exports are deleted after 7 days.
- Soft delete (7 days) and versioning off for `scans` (cost), on for `catalog-images`.
- Thumbnails: generated by the `media` job so the catalog never downloads full frames.
- Account deletion: `blob-gc` deletes `{userId}/` across containers after the DB rows are gone.

---

## 13. Frontend: TanStack SPA

### 13.1 Choice

Keep **TanStack Router** (file-based routes, already used) and **TanStack Query**, built with Vite as a **static SPA**. Remove TanStack Start's server functions and SSR, Nitro and the Lovable Vite config.

- `@tanstack/router-plugin` keeps `src/routes` and `createFileRoute` working unchanged; `routeTree.gen.ts` is still generated.
- `head()` metadata keeps working through `HeadContent` from `@tanstack/react-router`.
- If public marketing pages ever need SSR, add TanStack Start back for those pages only, or serve them separately. The app shell stays a SPA.

### 13.2 Changes

| Area          | Change                                                                                                                                                                                                                                  |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Data access   | Delete `@supabase/supabase-js`. Add `apps/web/src/api/` with a typed client generated from the API's OpenAPI spec (`openapi-typescript` + `openapi-fetch`), wrapped in TanStack Query hooks (`useScans`, `useScan`, `useCreateScan`, …) |
| Auth          | `AuthProvider` holds the access token in memory, refreshes silently before expiry and on 401 (single-flight), and exposes `useAuth()` with the same shape the routes use today (`user`, `loading`)                                      |
| Uploads       | `UploadManager`: request SAS batch → parallel `PUT` (4 at a time) with retry → `complete`. Resumable across reloads using the existing IndexedDB capture draft (`capture-draft.ts`)                                                     |
| Analysis      | Replace `runAnalysisResilient` with `useAnalysisRun(scanId)`: `POST` → SSE → polling fallback; same deadline logic from `analysis-deadline.ts`                                                                                          |
| Catalog       | Infinite query with cursor pagination; thumbnails from batch read SAS                                                                                                                                                                   |
| Space page    | One `useScan(id)` query instead of 5 parallel reads                                                                                                                                                                                     |
| Feature flags | `GET /v1/flags` once per session, cached by Query                                                                                                                                                                                       |
| CSP           | `connect-src` drops `*.supabase.co`; adds the API origin and the Blob endpoint                                                                                                                                                          |
| Config        | `VITE_API_BASE_URL`, `VITE_BLOB_ORIGIN` only; no secrets in the browser                                                                                                                                                                 |
| Hosting       | Static build to Azure Static Web Apps or a Blob static website behind Front Door; hashed assets with long cache, `index.html` no-cache; SPA fallback routing                                                                            |
| PWA           | `manifest.json` and `sw.js` unchanged; make sure the service worker never caches `/v1/*` or SAS URLs                                                                                                                                    |

Migrate route by route (§17, phase 4). A route is done when it has no `supabase` import.

---

## 14. Local development

`infra/docker/docker-compose.yml`:

| Service                        | Image                                                                | Ports              |
| ------------------------------ | -------------------------------------------------------------------- | ------------------ |
| `postgres`                     | custom (PostGIS 16 + pgvector)                                       | 5432               |
| `pgbouncer`                    | `edoburu/pgbouncer` (transaction mode)                               | 6432               |
| `redis`                        | `redis:7` (`noeviction`, AOF on)                                     | 6379               |
| `azurite`                      | `mcr.microsoft.com/azure-storage/azurite`                            | 10000 (blob)       |
| `mailpit`                      | `axllent/mailpit`: catches every email the auth module sends (§14.2) | 1025 SMTP, 8025 UI |
| `ollama` (profile `local-llm`) | `ollama/ollama`                                                      | 11434              |
| `api`, `worker`, `web`         | built from the repo (or run with `pnpm dev` on the host)             | 3000, —, 5173      |

Bootstrap: `pnpm i && pnpm dev:infra && pnpm db:migrate && pnpm db:seed && pnpm dev`. The seed creates a test user, containers in Azurite (`scans`, `exports`, `catalog-images`) with CORS rules, and product-catalog rows.

### 14.1 Configuration (API and worker)

| Variable                                                  | Example (local)                                                                       |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                            | `postgres://app_rw:…@localhost:6432/spatial`                                          |
| `DATABASE_REPLICA_URL`                                    | same as primary locally                                                               |
| `REDIS_QUEUE_URL`, `REDIS_CACHE_URL`                      | `redis://localhost:6379/0`, `/1`                                                      |
| `BLOB_CONNECTION_STRING`                                  | Azurite development connection string                                                 |
| `BLOB_ACCOUNT_URL`                                        | prod only, used with managed identity                                                 |
| `BLOB_PUBLIC_ORIGIN`                                      | origin the browser uses for SAS URLs                                                  |
| `JWT_PRIVATE_KEY` / `JWT_KEY_ID`                          | dev key pair; Key Vault reference in prod                                             |
| `WEB_ORIGINS`                                             | `http://localhost:5173`                                                               |
| `SMTP_URL`                                                | `smtp://localhost:1025`                                                               |
| `ANTHROPIC_API_KEY`                                       | Key Vault reference in prod                                                           |
| `ANTHROPIC_MODEL`, `ANTHROPIC_FALLBACK_MODEL`             | `claude-opus-5-5`, `claude-sonnet-5` (today's defaults)                               |
| `ANTHROPIC_REFUSAL_FALLBACK`                              | `default` (server-side fallbacks, §9.7.2); `off` to disable                           |
| `LLM_DEFAULT_PROVIDER`                                    | `claude`; replaces the per-process `LLM_PROVIDER` (§9.7.1)                            |
| `LLM_LOCAL_BASE_URL`, `LLM_LOCAL_MODEL`                   | `http://localhost:11434/v1`, `qwen2.5vl-3b-48k`                                       |
| `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL`, `GEMINI_API_KEY` | as today                                                                              |
| `GEOCODER_PROVIDER`, `GEOCODER_API_KEY`                   | `nominatim` locally (§19, R6)                                                         |
| `LLM_PERMITS_CLAUDE`, `LLM_PERMITS_LOCAL`                 | `8`, `1` locally; Claude per stage in §9.7.6 (16 → 64 → 200); local unset outside dev |
| `LLM_ITPM_LIMIT`, `LLM_OTPM_LIMIT`, `LLM_RPM_LIMIT`       | 85% of the granted Opus 5.5 limits (§9.7.6); small values locally                     |
| `AI_BUDGET_USER_DAILY_USD`, `AI_BUDGET_GLOBAL_DAILY_USD`  | `25`, sized per stage (§9.7.6)                                                        |
| `ANALYSIS_WORKER_CONCURRENCY`, `ANALYSIS_WORKER_QUEUES`   | `2`, `analysis-cloud` (dev also `analysis-local`)                                     |

### 14.2 Why Mailpit is in the stack

Supabase sends sign-up confirmation and password-reset emails today. With the in-house auth module (D1), the API sends them itself over SMTP, so development needs somewhere for those emails to go.

Mailpit is a fake mail server for development. It accepts every email sent to it on port 1025, delivers nothing to real inboxes, and shows the captured emails in a web inbox at `http://localhost:8025`.

- **Developers** sign up with any address, open the Mailpit inbox and click the verification or reset link. No real mail account and no risk of emailing real users.
- **E2E tests** (Playwright, §18.1) read the latest email through Mailpit's HTTP API to get the verification link, so the full sign-up and password-reset flows are tested automatically.
- **Email templates** can be checked visually in its inbox, including the HTML version.

It exists only in local development and CI. Staging and production send through Azure Communication Services Email using the same `SMTP_URL` setting, so the auth code doesn't change between environments.

---

## 15. Production deployment (Azure)

| Concern             | Service                                                                                                                                                                                                                                               |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Edge, CDN, WAF, TLS | Azure Front Door (Standard/Premium)                                                                                                                                                                                                                   |
| Web                 | Azure Static Web Apps or Blob static website                                                                                                                                                                                                          |
| API                 | Azure Container Apps (min 2 replicas, HTTP-concurrency autoscaling)                                                                                                                                                                                   |
| Worker              | Azure Container Apps with a KEDA Redis scaler on the BullMQ wait list length (`bull:analysis-cloud:wait`), min 1 replica                                                                                                                              |
| Local-model workers | None in production (D12). Local models run only in development and CI                                                                                                                                                                                 |
| Claude access       | Anthropic's own API (D11), key in Key Vault; custom Opus 5.5 rate limits per §9.7.6. Outbound traffic to the Anthropic API allowed from the worker subnet                                                                                             |
| Postgres            | Azure Database for PostgreSQL Flexible Server, zone-redundant HA, built-in PgBouncer, 1 read replica, PITR 35 days                                                                                                                                    |
| Redis               | Azure Cache for Redis: queue instance (persistence, `noeviction`), cache instance (LRU)                                                                                                                                                               |
| Blob                | Azure Storage (StorageV2, ZRS), lifecycle rules; private endpoint for API/worker, public blob endpoint kept reachable for browser SAS uploads (anonymous and shared-key access disabled)                                                              |
| Secrets             | Azure Key Vault; managed identities for API and worker                                                                                                                                                                                                |
| Email               | Azure Communication Services Email                                                                                                                                                                                                                    |
| Observability       | Azure Monitor / Application Insights via OpenTelemetry                                                                                                                                                                                                |
| Networking          | VNet integration for Container Apps; private endpoints for Postgres, Redis, Storage, Key Vault. Browsers must still reach the Blob endpoint, so Storage cannot be private-endpoint-only (or it must sit behind Front Door with a Private Link origin) |
| IaC                 | Bicep or Terraform in `infra/azure`, one stack per environment (dev, staging, prod)                                                                                                                                                                   |

CI/CD (GitHub Actions): lint → typecheck → unit tests → integration tests (compose services) → build images → push to ACR → deploy to staging → run DB migrations as a separate job with the migrator role → smoke + tenant-isolation tests → manual approval → prod. Migrations must be backward compatible (expand/contract) because old and new API replicas run side by side during a rollout.

---

## 16. Observability, reliability, security

### 16.1 Observability

- **Logs:** pino JSON with `requestId`, `userId`, `scanId`, `jobId`, `runId`; no secrets, tokens or image data.
- **Traces:** OpenTelemetry across Fastify → pg → Redis → BullMQ → worker → LLM HTTP calls, so one analysis is one trace.
- **Metrics:** request rate/latency/errors per route; queue depth and wait time; job duration per stage; LLM calls, tokens, cost and 429s per model (from the existing usage tracker); upload failures; SSE connection count; DB pool saturation.
- **Dashboards and alerts:** queue wait > 10 min, analysis failure rate > 5%, LLM 429 rate, daily spend over budget, DB CPU/connections, Redis memory on the queue instance.

### 16.2 Initial SLOs

| SLO                                       | Target                          |
| ----------------------------------------- | ------------------------------- |
| API availability (non-analysis endpoints) | 99.9% monthly                   |
| `GET` p95 latency                         | < 300 ms                        |
| Analysis started within 2 min of submit   | 95% (outside declared overload) |
| Analysis completes successfully           | ≥ 95% of runs with valid input  |

### 16.3 Security

- Tenant-isolation tests (§10.3) block merges.
- Zod validation on every input; response schemas strip unknown fields.
- Least-privilege SAS; no account keys in production; managed identities everywhere.
- Helmet headers and strict CSP on the SPA.
- Uploaded images: magic-byte check, EXIF/GPS stripping for derived thumbnails, size caps.
- Privacy: keep the people-screening purge; add a user-facing "delete my account and data" flow that removes DB rows and blobs.
- Backups: PITR on Postgres; blob soft delete; quarterly restore drill.
- Dependency scanning (Dependabot/Renovate), container image scanning, secret scanning in CI.
- Run a security review before cutover, focused on auth flows, SAS issuing and tenant isolation.

---

## 17. Phased roadmap

Each phase ends with a working, deployable system. Sizes are relative (S < M < L < XL); convert them to dates once team size is known.

### Phase 0 — Foundations (M)

- Create the monorepo in a **new repository** (or a branch never pushed to the Lovable-connected branch).
- pnpm workspaces, Turborepo, shared tsconfig/eslint, CI skeleton.
- Docker Compose with Postgres (PostGIS + pgvector), PgBouncer, Redis, Azurite, Mailpit.
- Extract `packages/domain` and `packages/contracts` from the current `src/lib` and `src/contracts`, keeping the existing unit tests green.

**Exit:** `pnpm test` passes in the monorepo; `docker compose up` gives a working local stack.

### Phase 1 — Data and auth (L)

- `packages/db`: baseline schema ported from Supabase migrations (§8.2), Drizzle models, seed.
- `AuthModule`: sign-up/in/out, refresh rotation, email verification, password reset, JWKS, bcrypt import path.
- `ConfigModule`, `DatabaseModule`, `RedisModule`, `HealthModule`, logging, OpenAPI.
- Tenant-isolation test harness.

**Exit:** a user can sign up and sign in against the local stack; CI runs integration tests against real Postgres.

### Phase 2 — Core API and storage (L)

- `StorageModule` with `BlobStore` on Azurite; SAS upload flow; `uploads/complete` verification.
- `ScansModule` (list, detail aggregate, create, patch, delete), `UploadsModule`, `ConsentModule`, `FeatureFlagsModule`, `GeocodeModule`, `ExportModule` (inline formats).
- Outbox relay + `blob-gc` and `media` jobs in `apps/worker`.
- `QuotaModule` (Postgres-backed first, same limits as today).

**Exit:** every endpoint in §7.3 except analysis and privacy purge works, with isolation tests.

**As built:**

- Reshoots are the `replaceStations` option on `uploads/:sessionId/complete` instead of a separate `stations/:station/reshoot` endpoint: the new frames and the removal of the old ones commit together.
- Exports are returned inline for now; moving large IMDF/USD exports to a job that writes to the `exports` container waits until sizes show it's needed.
- Thumbnails are JPEG (320 px), made with the original app's pure-JS crop code, so the worker needs no native image library.
- Quotas stay Postgres-backed (`consume_rate_limit`) until phase 5, as planned.

### Phase 3 — Analysis worker (XL)

- `packages/pipeline`: move `scan-analysis.server`, `scan-spatial.server`, `object-verification.server`, `src/llm/*`, `src/prompts/*`; replace Supabase calls with repositories and `BlobStore`.
- Split the `analyzeScan` orchestration into checkpointed stages (§9.4) with a single-transaction `persist` stage.
- `AnalysisModule` (enqueue, status, SSE), `AnalysisProcessor`, `privacy-purge` processor, `maintenance` cron.
- Global LLM semaphore and token bucket.
- `LlmProvider` interface with `ClaudeProvider` (Opus 5.5 rules, refusal fallbacks, prompt caching) and `LocalOpenAICompatProvider`; per-run provider routing and the `analysis-cloud` / `analysis-local` / `analysis-batch` queues (§9.7).
- Cost accounting fixes from §9.7.8.
- Eval harness (`npm run eval`) wired to run the pipeline against fixture captures in CI (fix the fixture-parsing issue first), for both providers. Use it for the Opus 5.5 effort sweep and the prompt-caching experiment.

**Exit:** a scan uploaded through the API is analysed by a worker with results matching the current pipeline on the eval fixtures; killing a worker mid-run resumes from the last checkpoint.

### Phase 4 — Frontend migration (L)

- New `apps/web` on TanStack Router + Query (Vite SPA); move routes, components and browser libs.
- API client, `AuthProvider`, `UploadManager`, `useAnalysisRun`.
- Migrate in this order: `auth` → `index` (catalog) → `space.$id` → `capture` (largest: uploads, reshoot, drafts).

**Exit:** no `supabase` import remains in `apps/web`; full capture → analysis → view → export works end to end locally.

### Phase 5 — Hardening and scale (L)

- Redis-backed `QuotaModule` and throttling; optional RLS defence in depth.
- Read replica routing; indexes from §8.3; caching of flags, catalog and geocoding.
- OpenTelemetry dashboards, alerts, SLOs.
- Azure infrastructure as code for staging and prod; CI/CD pipeline.
- Load tests with k6 (§18); fix what they find.
- Security review.

**Exit:** staging sustains the target load profile with SLOs met; security review findings closed.

### Phase 6 — Data migration and cutover (M)

- See §18.2. Rehearse on staging with a production snapshot at least twice.

**Exit:** production on the new platform; Supabase kept read-only for a rollback window, then decommissioned.

---

## 18. Testing, load testing and migration

### 18.1 Test strategy

| Level            | Scope                                                                      | Tooling                                      |
| ---------------- | -------------------------------------------------------------------------- | -------------------------------------------- |
| Unit             | `packages/domain`, pipeline stages with fake LLM, services                 | Vitest (existing tests move with the code)   |
| Integration      | Repositories, SAS flow, queues, against real Postgres/Redis/Azurite        | Vitest + Testcontainers or the compose stack |
| Contract         | API responses validated against `packages/contracts`; OpenAPI diff in CI   | zod + openapi-diff                           |
| Tenant isolation | Every endpoint, cross-user access returns 404                              | Dedicated suite, blocks merges               |
| E2E              | Sign-up → capture (synthetic frames) → analysis (stub LLM) → view → export | Playwright                                   |
| Pipeline quality | Eval fixtures against the real pipeline                                    | `scripts/run-eval.ts`                        |

**Load tests (k6, staging):**

1. Read mix at 600 req/s peak: catalog list, space detail, photo URL batches.
2. Upload burst: 200 concurrent captures × 32 frames through SAS.
3. Analysis burst: 100 submissions within 5 minutes with a **stub LLM** that simulates realistic latency and occasional 429s, to test queueing, permits, backpressure and autoscaling without spending money.
4. Soak: 4 hours at average load; watch memory, Redis size and DB connections.

### 18.2 Data migration from Supabase

1. **Users:** export `auth.users` (id, email, `encrypted_password` bcrypt hash, confirmed timestamp, created_at) into `public.users`, **keeping the same UUIDs** so every `user_id` foreign key stays valid.
2. **Tables:** `pg_dump --data-only` of the `public` schema tables, restored into the new schema in dependency order. Validate row counts and checksums per table.
3. **Blobs:** a Node script (in `scripts/`) that lists each Supabase bucket and streams objects to Azure Blob with the same keys, with concurrency, resumability (a manifest of copied keys) and checksum verification. Run a bulk copy days before cutover, then a delta copy during cutover.
4. **Cutover:** announce a short maintenance window → set Supabase to read-only (revoke writes) → final delta of rows and blobs → verify counts → switch DNS/Front Door to the new web and API → monitor.
5. **Rollback:** keep Supabase intact and read-only for 2 weeks. Rollback means pointing DNS back; writes made on the new platform during that time must be replayed or discarded (decide in advance: D8).
6. **Sessions:** existing Supabase sessions become invalid at cutover; users sign in again with their existing password.

---

## 19. Risks and mitigations

| #   | Risk                                                                                                             | Impact                       | Mitigation                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ---------------------------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | **Lovable sync breaks.** Lovable's editor targets TanStack Start + Supabase; the new stack is not editable there | Loss of the Lovable workflow | Build in a new repo; keep the Lovable project frozen as the current production until cutover                                                                                                                                                                                                                                                                                       |
| R2  | Claude Opus 5.5 throughput or cost is the real ceiling (no Priority Tier for this model)                         | Queue backlog, runaway spend | Per-provider semaphores, token buckets, budgets, priorities, effort sweep, prompt caching, batch lane for re-analysis, per-user and global spend budgets, stub-LLM load tests; request custom Opus 5.5 limits (6M ITPM / 750K OTPM / 300 RPM at target) well before launch. No local-model fallback in production (D12), so an Anthropic outage means runs queue until it recovers |
| R12 | Safety-classifier false positive declines a benign scan                                                          | Failed analysis              | `stop_reason: "refusal"` handling plus server-side `fallbacks: "default"` (§9.7.2); alert on refusal rate by category                                                                                                                                                                                                                                                              |
| R13 | Local model quality differs from Opus 5.5                                                                        | Worse reconstructions        | Local runs are opt-in or explicitly labelled; eval harness scores both providers                                                                                                                                                                                                                                                                                                   |
| R3  | Tenant data leak after removing RLS                                                                              | Severe                       | Mandatory repository scoping, isolation test suite, optional RLS defence in depth, security review                                                                                                                                                                                                                                                                                 |
| R4  | Behaviour drift while porting the 1,500-line `analyzeScan` orchestration                                         | Wrong reconstructions        | Move code without rewriting it; eval fixtures before/after; checkpoint outputs compared against the old pipeline on the same inputs                                                                                                                                                                                                                                                |
| R5  | Long jobs killed during deploys or scale-in                                                                      | Wasted LLM spend             | Checkpoints, graceful shutdown, KEDA scale-in cooldown                                                                                                                                                                                                                                                                                                                             |
| R6  | Nominatim public API usage policy (about 1 request/second, no heavy use) will not hold at scale                  | Geocoding blocked            | Provider interface; switch to Azure Maps or a self-hosted Nominatim; cache results; geocode in a background job                                                                                                                                                                                                                                                                    |
| R7  | BullMQ keys evicted under memory pressure                                                                        | Lost jobs                    | Dedicated queue Redis with `noeviction` + persistence; memory alerts                                                                                                                                                                                                                                                                                                               |
| R8  | Storage cost grows every year because frames are kept (D9; ~9 TB added per year at the assumed load)             | Cost                         | Lifecycle tiering (Hot → Cool → Cold, never Archive), thumbnails, blob deletion on scan/account deletion, storage-cost dashboard                                                                                                                                                                                                                                                   |
| R9  | Auth implementation bugs                                                                                         | Account takeover             | Well-known libraries (argon2, jose), refresh reuse detection, rate limits, external review; option to move to a managed IdP                                                                                                                                                                                                                                                        |
| R10 | Mobile browsers drop SSE and long requests                                                                       | Stuck UI                     | SSE + polling fallback; nothing in the request path runs longer than a few seconds                                                                                                                                                                                                                                                                                                 |
| R11 | PgBouncer transaction mode breaks session features                                                               | Subtle bugs                  | Only `SET LOCAL`; PgBouncer ≥ 1.21 or prepared statements disabled; integration tests run through PgBouncer                                                                                                                                                                                                                                                                        |

---

## 20. Decisions

| #   | Decision                                                                    | Status                 | Outcome / recommendation                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Identity: in-house `AuthModule` vs Entra External ID / Keycloak             | **Decided 2026-09-30** | In-house, behind an `IdentityProvider` interface (§10.1)                                                                                                                                                                                 |
| D2  | Queue: BullMQ on Redis vs Azure Service Bus                                 | Proposed               | BullMQ (Redis is already in the stack, good NestJS support, simple local dev)                                                                                                                                                            |
| D3  | ORM: Drizzle vs Prisma vs Kysely                                            | **Decided (phase 1)**  | Drizzle for queries; SQL-first migrations with a schema drift test (§7.4)                                                                                                                                                                |
| D4  | Progress transport: SSE vs WebSocket vs polling                             | Proposed               | SSE with polling fallback                                                                                                                                                                                                                |
| D5  | Production LLM provider and models                                          | **Decided 2026-09-30** | Claude Opus 5.5 (`claude-opus-5-5`) in production; local open-source models (Qwen2.5-VL via Ollama) kept as a supported provider (§9.7). Still needed: the organisation's actual Opus 5.5 rate limits, to size §9.3                      |
| D6  | Web hosting: Static Web Apps vs Blob static website + Front Door            | Proposed               | Static Web Apps unless Front Door rules require otherwise                                                                                                                                                                                |
| D7  | Geocoding provider in production                                            | Proposed               | Azure Maps                                                                                                                                                                                                                               |
| D8  | Rollback policy for writes made after cutover                               | Open                   | Decide before phase 6                                                                                                                                                                                                                    |
| D9  | Frame retention after analysis                                              | **Decided 2026-09-30** | Keep frames for the life of the scan, with lifecycle tiering (§12.4)                                                                                                                                                                     |
| D10 | IaC tool: Bicep vs Terraform                                                | Open                   | Team preference                                                                                                                                                                                                                          |
| D11 | Claude access path: Claude API (first-party) vs Claude on Microsoft Foundry | **Decided 2026-09-30** | Anthropic's own API, with server-side refusal fallbacks (§9.7.2) and custom Opus 5.5 rate limits (§9.7.6)                                                                                                                                |
| D12 | Local models in production: dev-only vs a GPU worker pool                   | **Decided 2026-09-30** | Development and CI only; the provider interface and `analysis-local` queue stay so a GPU pool can be added later without code changes                                                                                                    |
| D13 | Google sign-in, which the current app offers through Lovable's OAuth helper | Open                   | The in-house auth module is email and password only. Options: add Google OpenID Connect to the auth module before cutover (accounts matched by verified email), or accept that Google-only users set a password through reset at cutover |
| D14 | NestJS major version                                                        | **Decided (phase 1)**  | NestJS 11.2.x. NestJS 12 (released September 2026) is ESM-only and parts of the ecosystem (e.g. `nestjs-zod`) don't support it yet; revisit when they do                                                                                 |

---

## Appendix A — New endpoint list

```
POST   /v1/auth/sign-up
POST   /v1/auth/sign-in
POST   /v1/auth/refresh
POST   /v1/auth/sign-out
POST   /v1/auth/verify-email
POST   /v1/auth/password-reset
POST   /v1/auth/password-reset/confirm
GET    /.well-known/jwks.json

GET    /v1/me
PATCH  /v1/me
DELETE /v1/me                                  account + data deletion (async)

GET    /v1/scans                               cursor pagination, q, status, sort
POST   /v1/scans                               idempotent on capture_id
GET    /v1/scans/:id                           aggregate: scan + objects + portals + surfaces + photos
PATCH  /v1/scans/:id
DELETE /v1/scans/:id
POST   /v1/scans/photo-urls                    batch read SAS
POST   /v1/scans/:id/uploads                   issue write SAS batch
POST   /v1/scans/:id/uploads/complete          verify + insert photo rows
POST   /v1/scans/:id/stations/:station/reshoot
DELETE /v1/scans/:id/photos/:photoId
POST   /v1/scans/:id/analysis                  202 + runId
GET    /v1/scans/:id/status
GET    /v1/scans/:id/events                    SSE
GET    /v1/scans/:id/analyses                  run history
POST   /v1/scans/:id/privacy-purge             202
GET    /v1/scans/:id/export?format=
POST   /v1/scans/:id/address

GET    /v1/geocode?q=
POST   /v1/consents
GET    /v1/flags
GET    /v1/catalog/search?q=

GET    /health/live
GET    /health/ready
```

## Appendix B — Summary of what changes and what stays

| Stays                                                                            | Changes                                                                                 |
| -------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| React 19, TanStack Router file routes, TanStack Query, Tailwind, Radix, three.js | TanStack Start server functions and SSR, Nitro, Cloudflare target, Lovable Vite config  |
| Capture UX, acoustics, SLAM, drafts, PWA                                         | `@supabase/supabase-js` in the browser                                                  |
| Reconstruction pipeline, prompts, geometry solvers, eval fixtures                | Pipeline runs in a worker, checkpointed, behind a queue                                 |
| Postgres schema (PostGIS, pgvector), SQL functions                               | `auth.users` → `public.users`; RLS policies → backend authorization (+ optional RLS)    |
| zod contracts, repository/service seams                                          | Supabase repos → Drizzle repos                                                          |
| Blob key format for existing files                                               | Supabase Storage → Azure Blob with SAS                                                  |
| Rate-limit semantics and limits                                                  | Postgres counter → Redis (phase 5)                                                      |
| Claude Opus 5.5 via the official SDK; Ollama/Qwen local provider                 | Provider chosen per run, per-provider queues and semaphores, refusal fallbacks, caching |
| Frames kept after analysis                                                       | Lifecycle tiering Hot → Cool → Cold in Azure Blob                                       |
