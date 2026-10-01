# Cutover runbook: Supabase → new platform

How to move users, rows and files from the Supabase project to the new platform and switch traffic over (migration plan §18.2, Phase 6). The tooling is `tools/supabase-migration`; rehearse the whole runbook on staging, with a copy of production data, at least twice before doing it for real.

> **Two decisions are still open and change this runbook.** D8 is what happens to writes made on the new platform if you roll back; D13 is whether Google sign-in is added before cutover. Both are described [below](#decisions-to-make-first). Decide them before the first rehearsal.

## What moves, and how

| What                | How                                                                    | Notes                                                                                                                                                                                                                                                     |
| ------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Accounts            | `auth.users` → `users`, same UUIDs                                     | Bcrypt hashes carry over, so people keep their passwords; the API re-hashes them with Argon2id at the next sign-in. Deleted or banned accounts arrive disabled. Accounts with no email (anonymous) are skipped, and preflight stops if one owns any data. |
| Rows                | every `public` table, column for column, in foreign-key order          | Each `tables --yes` run replaces the target's copied tables in one transaction, from one consistent snapshot. Re-running is safe, and the last run leaves an exact copy, deletions included.                                                              |
| Catalog photo links | `image_url` and `specs.image_urls`                                     | Supabase public URLs become keys in the private `catalog-images` container. The worker reads them from there.                                                                                                                                             |
| Files               | each Supabase bucket → the Azure container of the same name, same keys | The paths stored in rows keep working. Size and MD5 are checked, and Azure stores the MD5. A manifest makes runs resumable, so a second run copies only new or changed files.                                                                             |
| Not moved           | sessions, `user_rate_limits`, Supabase Auth identities                 | Everyone signs in again after cutover. Quota counters start fresh (they're in Redis now).                                                                                                                                                                 |

Before copying, the target's sessions, email tokens, upload sessions, analysis checkpoints and outbox are emptied, since they belong to the rows being replaced. **`tables --yes` deletes whatever the target holds**; `preflight` says how much that is.

## Settings

| Variable                                    | Value                                                                                                                                                                                                          |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SOURCE_DATABASE_URL`                       | Supabase's **direct** connection, i.e. session mode on port 5432, not the transaction pooler, as `postgres`. Find it under Project settings → Database.                                                        |
| `TARGET_DATABASE_URL`                       | The new database as the migrator role, directly rather than through PgBouncer (Key Vault secret `database-migrator-url`).                                                                                      |
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | For reading files through the Storage API (Project settings → API).                                                                                                                                            |
| `BLOB_ACCOUNT_URL`                          | `https://<account>.blob.core.windows.net`. The tool signs in with your Azure identity (`az login`), which needs _Storage Blob Data Contributor_ on the account. Locally, use `BLOB_CONNECTION_STRING` instead. |
| `BLOB_CONTAINERS`                           | Optional; default `scans=scans,catalog-images=catalog-images` (bucket=container).                                                                                                                              |
| `MANIFEST`                                  | Where the file manifest lives; default `./supabase-blobs.manifest.jsonl`. **Keep this file** between the bulk copy and the cutover delta.                                                                      |
| `CONCURRENCY`                               | Parallel file copies; default 8.                                                                                                                                                                               |

Postgres, Key Vault and the storage account are private (plan §15). Run the tool from a machine inside the VNet, for example a temporary VM or Container Apps job in the `apps` subnet. Alternatively, open the firewall to your address for the duration and close it afterwards.

```sh
pnpm --filter @spatial/supabase-migration migrate preflight
pnpm --filter @spatial/supabase-migration migrate tables --yes
pnpm --filter @spatial/supabase-migration migrate blobs
pnpm --filter @spatial/supabase-migration migrate verify --deep
```

## Timeline

### Rehearsals (staging, twice or more)

1. Deploy staging from the commit you'll cut over with (`infra/azure/README.md`).
2. Run `preflight` against production Supabase, with staging as the target. Fix the cause of every `ERROR`, and read every `WARNING`: accounts without a password (D13), rows pointing at missing files, spaces mid-analysis.
3. Run `tables --yes`, `blobs`, then `verify --deep`, and time each step. The blob copy dominates; plan the bulk copy with that time in mind.
4. Test as real users on staging: sign in with an existing password, open spaces (frames load), export, run an analysis, delete a space.
5. Run `blobs` again with the same manifest, to measure the delta.
6. Write down the timings. The read-only window is roughly the second `tables` run, plus the delta `blobs`, plus `verify`, plus the smoke test.

### A few days before

- **Bulk file copy into production**, using the same manifest file you'll use at cutover: `blobs`. It can run for hours, and Supabase stays live meanwhile.
- `tables --yes` into production as well, to validate. It is replaced again at cutover.
- Announce the maintenance window to users. Tell them they'll need to sign in again, and Google-only users what D13 means for them.
- Lower the DNS TTL of the app's hostname to 5 minutes.

### The window

1. **Stop writes in Supabase.** In the dashboard, Authentication → Providers → Email: turn off "Allow new users to sign up". Then run this in the SQL editor:

   ```sql
   -- The app writes as anon/authenticated through the API, and server code as service_role.
   REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public FROM anon, authenticated, service_role;
   REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM anon, authenticated;
   -- Uploads. Reads stay allowed: the tool downloads with the service-role key.
   REVOKE INSERT, UPDATE, DELETE ON storage.objects FROM anon, authenticated, service_role;
   ```

   Password changes through Supabase Auth aren't covered by these grants, so put the Lovable app into maintenance as well, or accept that a change made during the window is lost.

2. Wait until `preflight` shows no spaces mid-analysis, or accept that those runs are lost (the new platform's stalled-scan sweep marks them failed).
3. `tables --yes`
4. `blobs` (the delta)
5. `verify --deep`. Every table must say `ok`, and the file counts must show 0 not copied and 0 different.
6. **Smoke test** on the production hostname of the new platform, or its Front Door endpoint, before DNS changes: sign in as a real account, open a space, check frames and plan, export.
7. **Switch traffic:** point the app's hostname at Front Door, deploy SQNR-web to the Static Web App, and set `WEB_ORIGINS` and `APP_BASE_URL` to the real hostname.
8. Watch the dashboards and alerts (plan §16): sign-in errors, 5xx, analysis failures, queue depth.

### After

- Supabase stays intact and read-only for **two weeks** (plan §18.2). Don't delete the bucket files or the project.
- At the end of that, take a final backup of the Supabase database and buckets, store it for the agreed retention, and decommission the project.
- Remove the temporary VM or firewall rule used to run the tool, and delete the manifest and any local copies of credentials.

## Rollback

Rolling back means pointing DNS back at the Lovable app and giving the app its writes back:

```sql
GRANT INSERT, UPDATE, DELETE, TRUNCATE ON ALL TABLES IN SCHEMA public TO anon, authenticated, service_role;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON storage.objects TO anon, authenticated, service_role;
```

Then turn sign-ups back on. These grants are Supabase's defaults; the app's RLS policies still decide which rows each user can touch. What happens to accounts, spaces and analyses created on the new platform in the meantime is decision D8.

## Decisions to make first

**D8: writes made on the new platform before a rollback.** Options:

1. **Discard them** (simplest). Users lose whatever they did on the new platform since cutover. Fine if a rollback can only happen within hours, and if it's announced.
2. **Replay them.** Copy new and changed rows and files back to Supabase. That needs a reverse tool, which doesn't exist; budget about a week to build and test it.
3. **Freeze them.** Roll back only within the first hour or so, and keep the new platform read-only for that hour.

Recommendation: option 1 with a short rollback horizon, for example 48 hours, and a clear notice. After that, fix forward instead of rolling back.

**D13: Google sign-in.** `preflight` counts the accounts without a password. Options:

1. **Add Google OpenID Connect to the auth module before cutover**, matching accounts by verified email. About 3–5 days with tests, plus a web-app change.
2. **Password reset at cutover.** Those users get an email, set a password via `POST /v1/auth/password-reset`, and keep their data.

Recommendation: decide by that count. If it's a small share of users, option 2 with a targeted email; otherwise option 1.

## If something goes wrong

- **`verify` shows `DIFF` for a table:** something wrote to Supabase after the copy (writes weren't fully stopped), or the target was changed. Run `tables --yes` again, then `verify`.
- **Files not copied:** run `blobs` again, since only failures and changes are retried. A `size`/`MD5` failure that keeps happening means the object in Supabase doesn't match its own metadata. Download it by hand to check.
- **Preflight: "columns with no place in the new schema":** the Supabase schema changed since this tool was written. Add the column to the new schema with a migration, then refresh `fixtures/supabase-source.sql` (the instructions are in its header).
