// Rows (plan §18.2 step 2). Every run replaces the target's copied tables in
// one transaction, from one consistent snapshot of Supabase, so a run can be
// repeated as often as needed and the last one (in the read-only window)
// leaves an exact copy, deletions included.
import { pipeline } from "node:stream/promises";
import { from as copyFrom, to as copyTo } from "pg-copy-streams";
import { type Client, ident } from "./db";
import { type MigrationPlan, sourceSelect, type TablePlan } from "./plan";

export interface CopyResult {
  table: string;
  rows: number;
  ms: number;
}

export async function copyTables(
  source: Client,
  target: Client,
  plan: MigrationPlan,
  log: (message: string) => void = () => undefined,
): Promise<CopyResult[]> {
  const results: CopyResult[] = [];
  await source.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  await target.query("BEGIN");
  try {
    const emptied = [...plan.tables.map((t) => t.name), ...plan.cleared];
    await target.query(`TRUNCATE ${emptied.map((t) => `public.${ident(t)}`).join(", ")}`);
    for (const table of plan.tables) {
      const started = Date.now();
      const rows = await copyOne(source, target, table);
      results.push({ table: table.name, rows, ms: Date.now() - started });
      log(`${table.name}: ${rows} rows`);
    }
    await target.query("COMMIT");
  } catch (err) {
    await target.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    await source.query("ROLLBACK").catch(() => undefined);
  }
  for (const table of plan.tables) await target.query(`ANALYZE public.${ident(table.name)}`);
  return results;
}

async function copyOne(source: Client, target: Client, table: TablePlan): Promise<number> {
  const out = source.query(copyTo(`COPY (${sourceSelect(table)}) TO STDOUT`));
  const into = target.query(
    copyFrom(
      `COPY public.${ident(table.name)} (${table.columns.map(ident).join(", ")}) FROM STDIN`,
    ),
  );
  await pipeline(out, into);
  return into.rowCount;
}

export interface TableCheck {
  table: string;
  sourceRows: number;
  targetRows: number;
  matches: boolean;
}

/**
 * Row counts and a checksum of every row's text form, in primary-key order,
 * on both sides. A difference anywhere (a value, a missing row) shows up.
 */
export async function checkTables(
  source: Client,
  target: Client,
  plan: MigrationPlan,
): Promise<TableCheck[]> {
  const checks: TableCheck[] = [];
  for (const table of plan.tables) {
    const order = table.key.map((k) => `s.${ident(k)}`).join(", ");
    const summary = (rowsSql: string) =>
      `SELECT count(*)::int AS n, md5(coalesce(string_agg(md5(s::text), '' ORDER BY ${order}), '')) AS sum
         FROM (${rowsSql}) s`;
    const targetSql = `SELECT ${table.columns.map(ident).join(", ")} FROM public.${ident(table.name)}`;
    const [a, b] = await Promise.all([
      source.query<{ n: number; sum: string }>(summary(sourceSelect(table))),
      target.query<{ n: number; sum: string }>(summary(targetSql)),
    ]);
    const s = a.rows[0]!;
    const t = b.rows[0]!;
    checks.push({
      table: table.name,
      sourceRows: s.n,
      targetRows: t.n,
      matches: s.n === t.n && s.sum === t.sum,
    });
  }
  return checks;
}
