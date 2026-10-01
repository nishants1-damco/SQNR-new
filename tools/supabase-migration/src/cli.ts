// pnpm --filter @spatial/supabase-migration migrate <command>
//
//   preflight          what would move, and anything that stops it
//   tables --yes       replace the target's rows with Supabase's (users included)
//   blobs              copy new or changed files (resumable; run it again for the delta)
//   verify [--deep]    row counts and checksums; every file copied (--deep: checked in Azure)
//
// Settings come from the environment; see docs/cutover-runbook.md.
import { ContainerClient } from "@azure/storage-blob";
import { blobStoreFromSettings } from "@spatial/storage";
import { checkBlobs, copyBlobs, Manifest, SupabaseStorage } from "./blobs";
import { connect } from "./db";
import { buildPlan } from "./plan";
import { preflight } from "./preflight";
import { checkTables, copyTables } from "./tables";

const env = process.env;
const required = (name: string) => {
  const value = env[name];
  if (!value) throw new Error(`${name} is required (see docs/cutover-runbook.md)`);
  return value;
};

/** Bucket → container, e.g. "scans=scans,catalog-images=catalog-images". */
function containers(): Record<string, ContainerClient> {
  const map = (env["BLOB_CONTAINERS"] ?? "scans=scans,catalog-images=catalog-images")
    .split(",")
    .map((pair) => pair.split("=").map((s) => s.trim()) as [string, string]);
  const settings = {
    connectionString: env["BLOB_CONNECTION_STRING"] ?? null,
    accountUrl: env["BLOB_ACCOUNT_URL"] ?? null,
    publicEndpoint: null,
  };
  if (!settings.connectionString && !settings.accountUrl) {
    throw new Error("BLOB_CONNECTION_STRING or BLOB_ACCOUNT_URL is required");
  }
  return Object.fromEntries(
    map.map(([bucket, container]) => [
      bucket,
      blobStoreFromSettings(settings, container).container,
    ]),
  );
}

async function main() {
  const [command, ...flags] = process.argv.slice(2);
  const source = await connect(required("SOURCE_DATABASE_URL"), "supabase-migration");
  const target = await connect(required("TARGET_DATABASE_URL"), "supabase-migration");
  const log = (message: string) => console.log(message);
  try {
    const plan = await buildPlan(source, target);
    const manifest = () => new Manifest(env["MANIFEST"] ?? "supabase-blobs.manifest.jsonl");

    if (command === "preflight" || command === "tables") {
      const checks = await preflight(source, target, plan);
      log(
        `Source: ${checks.facts["sourceUsers"]} users, ${checks.facts["sourceScans"]} spaces, ${checks.facts["sourceObjects"]} files`,
      );
      log(
        `Target now: ${checks.facts["targetUsers"]} users, ${checks.facts["targetScans"]} spaces`,
      );
      log(`Tables, in order: ${plan.tables.map((t) => t.name).join(", ")}`);
      log(`Also emptied: ${plan.cleared.join(", ")}`);
      if (checks.facts["targetUsers"]) {
        checks.warnings.unshift(
          `The target already has ${checks.facts["targetUsers"]} users and ${checks.facts["targetScans"]} spaces; tables --yes deletes them.`,
        );
      }
      checks.warnings.forEach((w) => log(`WARNING ${w}`));
      checks.errors.forEach((e) => log(`ERROR ${e}`));
      if (checks.errors.length) process.exitCode = 1;
      if (command === "preflight" || checks.errors.length) return;
      if (!flags.includes("--yes")) {
        log("This replaces every row above in the target. Run again with --yes.");
        process.exitCode = 1;
        return;
      }
      const results = await copyTables(source, target, plan, log);
      log(`Copied ${results.reduce((n, r) => n + r.rows, 0)} rows. Now run verify.`);
    } else if (command === "blobs") {
      const m = manifest();
      const result = await copyBlobs({
        source,
        storage: new SupabaseStorage(
          required("SUPABASE_URL"),
          required("SUPABASE_SERVICE_ROLE_KEY"),
        ),
        containers: containers(),
        manifest: m,
        concurrency: Number(env["CONCURRENCY"] ?? 8),
        log,
      });
      log(
        `Copied ${result.copied} files (${(result.bytes / 1e6).toFixed(1)} MB), ${result.skipped} unchanged, ${result.failed.length} failed`,
      );
      result.failed.slice(0, 50).forEach((f) => log(`FAILED ${f.key}: ${f.error}`));
      if (result.failed.length) process.exitCode = 1;
    } else if (command === "verify") {
      const tables = await checkTables(source, target, plan);
      for (const t of tables) {
        log(`${t.matches ? "ok  " : "DIFF"} ${t.table}: ${t.sourceRows} → ${t.targetRows}`);
      }
      const blobs = await checkBlobs({
        source,
        containers: containers(),
        manifest: manifest(),
        deep: flags.includes("--deep"),
      });
      log(
        `Files: ${blobs.objects} in Supabase, ${blobs.notCopied.length} not copied, ${blobs.mismatched.length} different in Azure`,
      );
      [...blobs.notCopied, ...blobs.mismatched].slice(0, 50).forEach((k) => log(`  ${k}`));
      if (tables.some((t) => !t.matches) || blobs.notCopied.length || blobs.mismatched.length) {
        process.exitCode = 1;
      }
    } else {
      log("Usage: migrate preflight | tables --yes | blobs | verify [--deep]");
      process.exitCode = 1;
    }
  } finally {
    await source.end();
    await target.end();
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
