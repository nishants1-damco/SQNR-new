// What to know before copying anything. Errors stop the migration; warnings
// are for the operator to read and accept (see docs/cutover-runbook.md).
import type { Client } from "./db";
import type { MigrationPlan } from "./plan";

export interface Preflight {
  errors: string[];
  warnings: string[];
  facts: Record<string, number>;
}

const count = async (client: Client, sql: string) =>
  Number((await client.query<{ n: string }>(sql)).rows[0]?.n ?? 0);

export async function preflight(
  source: Client,
  target: Client,
  plan: MigrationPlan,
): Promise<Preflight> {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (plan.unmapped.length) {
    errors.push(`Source columns with no place in the new schema: ${plan.unmapped.join(", ")}`);
  }

  // Accounts without an email can't become users; their rows would be orphaned.
  const userTables = plan.tables
    .filter((t) => t.name !== "users" && t.columns.includes("user_id"))
    .map((t) => t.name);
  const owned = userTables.map((t) => `SELECT user_id FROM public."${t}"`).join(" UNION ");
  const emailless = await count(
    source,
    `SELECT count(*) AS n FROM auth.users u WHERE u.email IS NULL
       AND u.id IN (${owned || "SELECT NULL::uuid"})`,
  );
  if (emailless) errors.push(`${emailless} accounts without an email own data (anonymous users?)`);

  const duplicates = await count(
    source,
    `SELECT count(*) AS n FROM (SELECT lower(email) FROM auth.users WHERE email IS NOT NULL
       GROUP BY lower(email) HAVING count(*) > 1) d`,
  );
  if (duplicates) errors.push(`${duplicates} emails used by more than one account (ignoring case)`);

  const passwordless = await count(
    source,
    `SELECT count(*) AS n FROM auth.users WHERE email IS NOT NULL
       AND coalesce(encrypted_password, '') = ''`,
  );
  if (passwordless) {
    warnings.push(
      `${passwordless} accounts have no password (Google sign-in). They arrive without one and must use password reset, unless Google sign-in is added first (decision D13).`,
    );
  }

  const busy = await count(
    source,
    "SELECT count(*) AS n FROM public.scans WHERE status = 'processing'",
  );
  if (busy) {
    warnings.push(
      `${busy} spaces are mid-analysis. In the read-only window this should be 0; their runs are lost and the stalled-scan sweep marks them failed.`,
    );
  }

  // Rows pointing at files that aren't in storage (old failures, manual deletes).
  const missing = await source.query<{ key: string }>(
    `SELECT k.key FROM (
       SELECT storage_path AS key FROM public.scan_photos
       UNION SELECT depth_path FROM public.scans WHERE depth_path IS NOT NULL) k
     WHERE NOT EXISTS (SELECT 1 FROM storage.objects o WHERE o.bucket_id = 'scans' AND o.name = k.key)
     LIMIT 1000`,
  );
  if (missing.rows.length) {
    warnings.push(
      `${missing.rows.length}${missing.rows.length === 1000 ? "+" : ""} rows point at files missing from storage, e.g. ${missing.rows
        .slice(0, 3)
        .map((r) => r.key)
        .join(", ")}. They copy as they are.`,
    );
  }

  const facts: Record<string, number> = {
    sourceUsers: await count(
      source,
      "SELECT count(*) AS n FROM auth.users WHERE email IS NOT NULL",
    ),
    sourceScans: await count(source, "SELECT count(*) AS n FROM public.scans"),
    sourceObjects: await count(source, "SELECT count(*) AS n FROM storage.objects"),
    targetUsers: await count(target, "SELECT count(*) AS n FROM public.users"),
    targetScans: await count(target, "SELECT count(*) AS n FROM public.scans"),
  };
  return { errors, warnings, facts };
}
