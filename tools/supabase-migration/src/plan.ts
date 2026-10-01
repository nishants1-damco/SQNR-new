// What moves where (plan §18.2). The new schema kept every Supabase table and
// column, so most tables copy column for column; the exceptions are here:
// users come from `auth.users`, and catalog photo links become blob keys.
import { type Client, ident } from "./db";

export interface TablePlan {
  /** Table in the new database (schema public). */
  name: string;
  /** Relation read in Supabase. */
  source: string;
  /** Target columns written, in order. */
  columns: string[];
  /** Source expressions, one per column. */
  expressions: string[];
  /** Target primary key: the order rows are checksummed in. */
  key: string[];
  where: string | null;
}

/** Not copied: PostGIS's own table, and quota counters (they live in Redis now). */
export const SKIPPED_TABLES = ["spatial_ref_sys", "user_rate_limits"];

/**
 * Supabase's public URL for a catalog photo. Rows keep only the key; the
 * worker reads it from the private `catalog-images` container.
 */
export const CATALOG_URL_PATTERN = "^https?://[^/?#]+/storage/v1/object/public/catalog-images/";

const stripCatalogUrl = (expr: string) => `regexp_replace(${expr}, '${CATALOG_URL_PATTERN}', '')`;

/** Accounts that become users (see USERS). */
const MIGRATED_USERS = "SELECT id FROM auth.users WHERE email IS NOT NULL";

/**
 * Rows left behind with an account that isn't migrated. Supabase's trigger
 * gives every account a profile, anonymous ones included; any other data an
 * email-less account owns stops the migration in preflight instead.
 */
const FILTERS: Record<string, string> = {
  profiles: `id IN (${MIGRATED_USERS})`,
};

/** Columns whose source value is transformed on the way. */
const TRANSFORMS: Record<string, Record<string, string>> = {
  product_dimensions: {
    image_url: stripCatalogUrl("image_url"),
    specs: `CASE WHEN jsonb_typeof(specs->'image_urls') = 'array' THEN jsonb_set(specs, '{image_urls}',
      (SELECT coalesce(jsonb_agg(CASE WHEN jsonb_typeof(e.v) = 'string'
                 THEN to_jsonb(${stripCatalogUrl("e.v #>> '{}'")}) ELSE e.v END ORDER BY e.i), '[]'::jsonb)
       FROM jsonb_array_elements(specs->'image_urls') WITH ORDINALITY AS e(v, i)))
      ELSE specs END`,
  },
};

/**
 * Supabase accounts to `users`, keeping the ids every `user_id` points at.
 * The bcrypt hashes carry over, so people keep their passwords (the API
 * re-hashes them with Argon2id at the next sign-in). OAuth-only accounts have
 * an empty hash and arrive without a password (decision D13). Deleted or
 * banned accounts arrive disabled.
 */
const USERS: Omit<TablePlan, "key"> = {
  name: "users",
  source: "auth.users",
  columns: [
    "id",
    "email",
    "password_hash",
    "email_verified_at",
    "disabled_at",
    "last_sign_in_at",
    "created_at",
    "updated_at",
  ],
  expressions: [
    "id",
    "email",
    "nullif(encrypted_password, '')",
    "email_confirmed_at",
    "coalesce(deleted_at, CASE WHEN banned_until > now() THEN coalesce(updated_at, created_at) END)",
    "last_sign_in_at",
    "coalesce(created_at, updated_at, now())",
    "coalesce(updated_at, created_at, now())",
  ],
  where: "email IS NOT NULL",
};

async function columnsOf(client: Client, schema: string): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ table_name: string; column_name: string }>(
    `SELECT c.table_name, c.column_name FROM information_schema.columns c
       JOIN information_schema.tables t USING (table_schema, table_name)
      WHERE c.table_schema = $1 AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`,
    [schema],
  );
  const tables = new Map<string, string[]>();
  for (const r of rows)
    tables.set(r.table_name, [...(tables.get(r.table_name) ?? []), r.column_name]);
  return tables;
}

async function primaryKeys(client: Client): Promise<Map<string, string[]>> {
  const { rows } = await client.query<{ table_name: string; columns: string[] }>(
    `SELECT c.relname AS table_name,
            array_agg(a.attname::text ORDER BY array_position(i.indkey, a.attnum)) AS columns
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
       JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = ANY(i.indkey)
      WHERE i.indisprimary
      GROUP BY c.relname`,
  );
  return new Map(rows.map((r) => [r.table_name, r.columns]));
}

/** Foreign keys between public tables in the target: child → parents. */
export async function foreignKeys(client: Client): Promise<Map<string, Set<string>>> {
  const { rows } = await client.query<{ child: string; parent: string }>(
    `SELECT c.relname AS child, p.relname AS parent
       FROM pg_constraint k
       JOIN pg_class c ON c.oid = k.conrelid
       JOIN pg_class p ON p.oid = k.confrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
      WHERE k.contype = 'f' AND k.conrelid <> k.confrelid`,
  );
  const edges = new Map<string, Set<string>>();
  for (const r of rows) edges.set(r.child, (edges.get(r.child) ?? new Set()).add(r.parent));
  return edges;
}

/** Parents before children. */
function dependencyOrder(names: string[], parents: Map<string, Set<string>>): string[] {
  const order: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string) => {
    if (state.get(name) === "done") return;
    if (state.get(name) === "visiting") throw new Error(`Foreign-key cycle through ${name}`);
    state.set(name, "visiting");
    for (const parent of parents.get(name) ?? []) if (names.includes(parent)) visit(parent);
    state.set(name, "done");
    order.push(name);
  };
  [...names].sort().forEach(visit);
  return order;
}

export interface MigrationPlan {
  tables: TablePlan[];
  /** Source columns the new schema has no place for. A non-empty list stops the migration. */
  unmapped: string[];
  /** Target tables emptied as well, because they reference copied ones (sessions, uploads...). */
  cleared: string[];
}

export async function buildPlan(source: Client, target: Client): Promise<MigrationPlan> {
  // One query at a time per connection (node-postgres queues them anyway).
  const sourceTables = await columnsOf(source, "public");
  const targetTables = await columnsOf(target, "public");
  const keys = await primaryKeys(target);
  const parents = await foreignKeys(target);

  const unmapped: string[] = [];
  const plans = new Map<string, TablePlan>();
  const withKey = (plan: Omit<TablePlan, "key">): TablePlan => {
    const key = keys.get(plan.name);
    if (!key) throw new Error(`Target table ${plan.name} has no primary key`);
    return { ...plan, key };
  };
  plans.set("users", withKey(USERS));

  for (const [name, sourceColumns] of sourceTables) {
    if (SKIPPED_TABLES.includes(name)) continue;
    const targetColumns = targetTables.get(name);
    if (!targetColumns) {
      unmapped.push(`${name} (whole table)`);
      continue;
    }
    for (const column of sourceColumns) {
      if (!targetColumns.includes(column)) unmapped.push(`${name}.${column}`);
    }
    const columns = targetColumns.filter((c) => sourceColumns.includes(c));
    const transforms = TRANSFORMS[name] ?? {};
    plans.set(
      name,
      withKey({
        name,
        source: `public.${ident(name)}`,
        columns,
        expressions: columns.map((c) => transforms[c] ?? ident(c)),
        where: FILTERS[name] ?? null,
      }),
    );
  }

  const order = dependencyOrder([...plans.keys()], parents);
  const copied = new Set(order);
  // Everything that references a copied table (transitively), plus the outbox:
  // state that belongs to the rows being replaced.
  const cleared = new Set<string>(["outbox"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, ps] of parents) {
      if (copied.has(child) || cleared.has(child)) continue;
      if ([...ps].some((p) => copied.has(p) || cleared.has(p))) {
        cleared.add(child);
        grew = true;
      }
    }
  }
  return {
    tables: order.map((name) => plans.get(name)!),
    unmapped,
    cleared: [...cleared].filter((t) => targetTables.has(t)).sort(),
  };
}

/** `SELECT` of the source rows in target column order. */
export function sourceSelect(plan: TablePlan): string {
  const exprs = plan.expressions.map((e, i) => `${e} AS ${ident(plan.columns[i]!)}`).join(", ");
  return `SELECT ${exprs} FROM ${plan.source}${plan.where ? ` WHERE ${plan.where}` : ""}`;
}
