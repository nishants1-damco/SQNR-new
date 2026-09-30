// `pnpm db:migrate` / `pnpm db:status`. Uses DATABASE_MIGRATOR_URL, or the
// local stack's schema-owner connection outside production.
import { loadMigratorDatabaseUrl } from "@spatial/config";
import { migrate, migrationStatus } from "../migrator";

async function main() {
  const databaseUrl = loadMigratorDatabaseUrl();
  const target = new URL(databaseUrl);
  const where = `${target.hostname}:${target.port}${target.pathname}`;

  if (process.argv.includes("--status")) {
    const status = await migrationStatus({ databaseUrl });
    for (const m of status) console.log(`${m.applied ? "applied" : "pending"}  ${m.id}`);
    return;
  }

  console.log(`Migrating ${where}`);
  const result = await migrate({ databaseUrl, log: (line) => console.log(`  ${line}`) });
  console.log(
    result.applied.length
      ? `Done: ${result.applied.length} applied, ${result.alreadyApplied.length} already applied.`
      : `Up to date (${result.alreadyApplied.length} applied).`,
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
