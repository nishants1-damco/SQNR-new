// The whole migration against a Supabase-shaped source: the project's schema
// (fixtures/supabase-source.sql) with seeded accounts, spaces and files, a
// fake of the Storage API serving those files, a migrated target database and
// Azurite. Bulk copy, delta, verification, and the failures it must catch.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import { localStack } from "@spatial/config";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import bcrypt from "bcryptjs";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkBlobs, copyBlobs, Manifest, SupabaseStorage } from "./blobs";
import { type Client, connect } from "./db";
import { buildPlan } from "./plan";
import { preflight } from "./preflight";
import { checkTables, copyTables } from "./tables";

const SERVICE_KEY = "service-role-key";
const SUPABASE = "https://abcd1234.supabase.co";

let sourceName: string;
let source: Client;
let target: Client;
let targetDb: TestDatabase;
let server: Server;
let storageUrl: string;
let containers: Record<string, ContainerClient>;
let manifestPath: string;

/** What the fake Storage API serves, by `bucket/name`. */
const files = new Map<string, Buffer>();
/** Keys that answer 503 once, then work. */
const flaky = new Set<string>();

const ids = {
  alice: randomUUID(),
  bob: randomUUID(),
  carol: randomUUID(),
  anon: randomUUID(),
  scan: randomUUID(),
  consent: randomUUID(),
};
const ALICE_PASSWORD = "alice-supabase-password";

const md5 = (b: Buffer) => createHash("md5").update(b).digest("hex");

async function addObject(
  bucket: string,
  name: string,
  body: Buffer,
  options: { etag?: string; mimetype?: string } = {},
) {
  files.set(`${bucket}/${name}`, body);
  await source.query(
    `INSERT INTO storage.objects (bucket_id, name, owner, metadata) VALUES ($1, $2, $3, $4)
     ON CONFLICT (bucket_id, name) DO UPDATE SET metadata = EXCLUDED.metadata`,
    [
      bucket,
      name,
      ids.alice,
      {
        size: body.length,
        eTag: `"${options.etag ?? md5(body)}"`,
        mimetype: options.mimetype ?? "image/jpeg",
      },
    ],
  );
}

async function seed() {
  await source.query(
    "INSERT INTO storage.buckets (id, name, public) VALUES ('scans', 'scans', false), ('catalog-images', 'catalog-images', true)",
  );
  // Supabase stores bcrypt as $2a$; the profile row comes from its trigger.
  const hash = bcrypt.hashSync(ALICE_PASSWORD, 4).replace(/^\$2b\$/, "$2a$");
  await source.query(
    `INSERT INTO auth.users (id, email, encrypted_password, email_confirmed_at, created_at, updated_at, raw_user_meta_data, banned_until)
     VALUES ($1, 'alice@example.com', $5, '2026-08-20T10:00:00Z', '2026-08-20T09:00:00Z', '2026-08-21T09:00:00Z', '{"display_name":"Alice"}', NULL),
            ($2, 'bob@example.com', '', '2026-08-22T10:00:00Z', '2026-08-22T09:00:00Z', '2026-08-22T09:00:00Z', '{}', NULL),
            ($3, 'carol@example.com', $5, NULL, '2026-08-23T09:00:00Z', '2026-08-24T09:00:00Z', '{}', '2999-01-01T00:00:00Z'),
            ($4, NULL, NULL, NULL, '2026-08-25T09:00:00Z', '2026-08-25T09:00:00Z', '{}', NULL)`,
    [ids.alice, ids.bob, ids.carol, ids.anon, hash],
  );
  await source.query(
    `INSERT INTO auth.identities (user_id, provider, provider_id, email) VALUES ($1, 'google', 'g-123', 'bob@example.com')`,
    [ids.bob],
  );
  const depthKey = `${ids.alice}/${ids.scan}/depth/ab12cd34-room_scan.ply`;
  await source.query(
    `INSERT INTO public.scans (id, user_id, name, status, width_m, length_m, height_m, floor_area_m2,
       acoustics, depth_path, site_location, analysis_notes, capture_id, created_at)
     VALUES ($1, $2, 'Studio', 'ready', 3.5, 4.0, 2.5, 14.0, '{"rt60_s": 0.42}', $3,
       ST_SetSRID(ST_MakePoint(77.5946, 12.9716), 4326)::geography, '{"frame_removals": []}', $4, '2026-08-20T11:00:00Z')`,
    [ids.scan, ids.alice, depthKey, randomUUID()],
  );
  for (let i = 0; i < 3; i++) {
    const key = `${ids.alice}/${ids.scan}/frames/${i}.jpg`;
    await source.query(
      `INSERT INTO public.scan_photos (scan_id, user_id, storage_path, heading_deg, idx, sensor_payload, camera_pose)
       VALUES ($1, $2, $3, $4, $5, '{"station": 0}', ST_SetSRID(ST_MakePoint(1.5, 2.0, 1.4), 0))`,
      [ids.scan, ids.alice, key, i * 120, i],
    );
    await addObject("scans", key, randomBytes(2048 + i));
  }
  // Big enough for a multipart upload in Supabase: its ETag isn't an MD5.
  await addObject("scans", depthKey, randomBytes(9000), {
    etag: "9b2cf535f27731c974343645a3985328-2",
    mimetype: "application/octet-stream",
  });
  await source.query(
    `INSERT INTO public.scan_objects (scan_id, user_id, label, category, confidence, x_m, y_m, width_m, depth_m, height_m, metadata)
     VALUES ($1, $2, 'Desk', 'table', 0.9, 0, 1.6, 1.4, 0.7, 0.75, '{"material": "wood"}')`,
    [ids.scan, ids.alice],
  );
  await source.query(
    `INSERT INTO public.scan_portals (scan_id, user_id, kind, wall, offset_m, width_m, height_m, sill_m)
     VALUES ($1, $2, 'door', 'east', 1, 0.9, 2.03, 0)`,
    [ids.scan, ids.alice],
  );
  await source.query(
    `INSERT INTO public.scan_analyses (scan_id, user_id, provider, model_version, prompt_version, status,
       started_at, finished_at, duration_ms, cost_estimate_usd, metrics)
     VALUES ($1, $2, 'claude', 'claude-opus-4-1', 'v7', 'succeeded', '2026-08-20T11:01:00Z', '2026-08-20T11:06:00Z',
       300000, 4.87, '{"calls": 12}')`,
    [ids.scan, ids.alice],
  );
  await source.query(
    `INSERT INTO public.capture_consents (id, user_id, capture_id, consent_version) VALUES ($1, $2, $3, '2026-08')`,
    [ids.consent, ids.alice, randomUUID()],
  );
  await source.query(
    `INSERT INTO public.feature_flags (key, user_id, enabled, payload)
     VALUES ('acoustics', NULL, true, '{}'), ('acoustics', $1, false, '{"why": "beta opt-out"}')`,
    [ids.alice],
  );
  const catalogKey = "benq/gw2786tc-front.jpg";
  const vector = `[${Array.from({ length: 768 }, (_, i) => (i % 7) / 10).join(",")}]`;
  await source.query(
    `INSERT INTO public.product_dimensions (category, label, brand, model, width_m, height_m, depth_m,
       image_url, specs, embedding)
     VALUES ('monitor', 'BenQ GW2786TC', 'BenQ', 'GW2786TC', 0.612, 0.442, 0.2, $1, $2, $3)`,
    [
      `${SUPABASE}/storage/v1/object/public/catalog-images/${catalogKey}`,
      {
        image_urls: [
          `${SUPABASE}/storage/v1/object/public/catalog-images/${catalogKey}`,
          "https://images.example.com/benq-side.jpg",
        ],
        ports: ["HDMI", "USB-C"],
      },
      vector,
    ],
  );
  await addObject("catalog-images", catalogKey, randomBytes(1500));
}

beforeAll(async () => {
  sourceName = `supabase_source_test_${Date.now()}_${randomBytes(3).toString("hex")}`;
  const admin = new pg.Client({ connectionString: localStack().adminDatabaseUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${sourceName}"`);
  await admin.end();
  source = await connect(localStack({ database: sourceName }).adminDatabaseUrl, "test-source");
  await source.query(
    readFileSync(join(import.meta.dirname, "..", "fixtures", "supabase-source.sql"), "utf8"),
  );
  await source.query("SET search_path = public");

  targetDb = await createTestDatabase();
  target = await connect(targetDb.migratorUrl, "test-target");

  server = createServer((req, res) => {
    const prefix = "/storage/v1/object/authenticated/";
    if (req.headers.authorization !== `Bearer ${SERVICE_KEY}` || !req.url?.startsWith(prefix)) {
      res.writeHead(401).end();
      return;
    }
    const key = req.url.slice(prefix.length).split("/").map(decodeURIComponent).join("/");
    if (flaky.delete(key)) {
      res.writeHead(503).end();
      return;
    }
    const body = files.get(key);
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as { port: number };
  storageUrl = `http://127.0.0.1:${address.port}`;

  const service = BlobServiceClient.fromConnectionString(localStack().blob.connectionString);
  const suffix = randomBytes(4).toString("hex");
  containers = {
    scans: service.getContainerClient(`mig-scans-${suffix}`),
    "catalog-images": service.getContainerClient(`mig-catalog-${suffix}`),
  };
  for (const c of Object.values(containers)) await c.createIfNotExists();
  manifestPath = join(tmpdir(), `supabase-manifest-${suffix}.jsonl`);

  await seed();
});

afterAll(async () => {
  server?.close();
  await target?.end();
  await targetDb?.drop();
  await source?.end();
  if (sourceName) {
    const admin = new pg.Client({ connectionString: localStack().adminDatabaseUrl });
    await admin.connect();
    await admin.query(`DROP DATABASE IF EXISTS "${sourceName}" WITH (FORCE)`);
    await admin.end();
  }
  for (const c of Object.values(containers ?? {})) await c.deleteIfExists();
});

const storage = () => new SupabaseStorage(storageUrl, SERVICE_KEY);
const runBlobs = (manifest = new Manifest(manifestPath)) =>
  copyBlobs({ source, storage: storage(), containers, manifest, concurrency: 3 });

describe("rows", () => {
  it("finds nothing blocking, and warns about accounts without a password", async () => {
    const plan = await buildPlan(source, target);
    expect(plan.unmapped).toEqual([]);
    expect(plan.tables[0]!.name).toBe("users");
    expect(plan.tables.map((t) => t.name)).not.toContain("user_rate_limits");
    expect(plan.cleared).toEqual(
      expect.arrayContaining(["auth_refresh_tokens", "outbox", "upload_sessions"]),
    );
    const order = plan.tables.map((t) => t.name);
    expect(order.indexOf("scans")).toBeLessThan(order.indexOf("scan_photos"));

    const checks = await preflight(source, target, plan);
    expect(checks.errors).toEqual([]);
    expect(checks.warnings).toEqual([expect.stringContaining("1 accounts have no password")]);
    expect(checks.facts).toMatchObject({ sourceUsers: 3, sourceScans: 1, targetUsers: 0 });
  });

  it("copies every row, keeping ids and passwords, and the checksums match", async () => {
    const plan = await buildPlan(source, target);
    const results = await copyTables(source, target, plan);
    expect(results.find((r) => r.table === "users")?.rows).toBe(3);
    expect(results.find((r) => r.table === "scan_photos")?.rows).toBe(3);

    const checks = await checkTables(source, target, plan);
    expect(checks.filter((c) => !c.matches)).toEqual([]);

    const { rows: users } = await target.query<{
      id: string;
      email: string;
      password_hash: string | null;
      email_verified_at: Date | null;
      disabled_at: Date | null;
    }>(
      "SELECT id, email::text, password_hash, email_verified_at, disabled_at FROM users ORDER BY email",
    );
    expect(users.map((u) => u.id)).toEqual([ids.alice, ids.bob, ids.carol]);
    const [alice, bob, carol] = users;
    expect(await bcrypt.compare(ALICE_PASSWORD, alice!.password_hash!)).toBe(true);
    expect(alice!.email_verified_at).not.toBeNull();
    expect(bob!.password_hash).toBeNull();
    expect(carol!.disabled_at).not.toBeNull();

    const profile = await target.query("SELECT display_name FROM profiles WHERE id = $1", [
      ids.alice,
    ]);
    expect(profile.rows[0]).toEqual({ display_name: "Alice" });

    const scan = await target.query<{ lon: number; status: string; rt60: string }>(
      `SELECT ST_X(site_location::geometry) AS lon, status, acoustics->>'rt60_s' AS rt60
         FROM scans WHERE id = $1`,
      [ids.scan],
    );
    expect(scan.rows[0]).toEqual({ lon: 77.5946, status: "ready", rt60: "0.42" });
  });

  it("turns Supabase catalog photo URLs into keys in the catalog container", async () => {
    const { rows } = await target.query<{ image_url: string; specs: { image_urls: string[] } }>(
      "SELECT image_url, specs FROM product_dimensions WHERE model = 'GW2786TC'",
    );
    expect(rows[0]!.image_url).toBe("benq/gw2786tc-front.jpg");
    expect(rows[0]!.specs.image_urls).toEqual([
      "benq/gw2786tc-front.jpg",
      "https://images.example.com/benq-side.jpg",
    ]);
  });

  it("replaces the target on every run, so changes and deletions arrive too", async () => {
    await source.query("UPDATE public.scans SET name = 'Studio (renamed)' WHERE id = $1", [
      ids.scan,
    ]);
    await source.query("DELETE FROM public.capture_consents WHERE id = $1", [ids.consent]);
    // State that only exists on the new platform is cleared with the rows it belongs to.
    await target.query(
      "INSERT INTO auth_refresh_tokens (user_id, family_id, token_hash, expires_at) VALUES ($1, gen_random_uuid(), 'x', now() + interval '1 day')",
      [ids.alice],
    );

    const plan = await buildPlan(source, target);
    await copyTables(source, target, plan);
    expect((await checkTables(source, target, plan)).every((c) => c.matches)).toBe(true);
    const scan = await target.query("SELECT name FROM scans WHERE id = $1", [ids.scan]);
    expect(scan.rows[0]).toEqual({ name: "Studio (renamed)" });
    expect((await target.query("SELECT 1 FROM capture_consents")).rows).toHaveLength(0);
    expect((await target.query("SELECT 1 FROM auth_refresh_tokens")).rows).toHaveLength(0);
  });

  it("notices a target row that differs", async () => {
    const plan = await buildPlan(source, target);
    await target.query("UPDATE scan_objects SET label = 'Table' WHERE label = 'Desk'");
    const checks = await checkTables(source, target, plan);
    expect(checks.filter((c) => !c.matches).map((c) => c.table)).toEqual(["scan_objects"]);
    await target.query("UPDATE scan_objects SET label = 'Desk' WHERE label = 'Table'");
  });
});

describe("files", () => {
  it("copies every object under the same key, checked against size and MD5", async () => {
    flaky.add(`scans/${ids.alice}/${ids.scan}/frames/1.jpg`);
    const result = await runBlobs();
    expect(result.failed).toEqual([]);
    expect(result.copied).toBe(5);
    expect(flaky.size).toBe(0); // the 503 was retried

    for (const [key, body] of files) {
      const [bucket, ...rest] = key.split("/");
      const blob = containers[bucket!]!.getBlobClient(rest.join("/"));
      expect(Buffer.from(await blob.downloadToBuffer()).equals(body), key).toBe(true);
      const props = await blob.getProperties();
      expect(Buffer.from(props.contentMD5!).toString("hex")).toBe(md5(body));
    }
    const frame = await containers["scans"]!.getBlobClient(
      `${ids.alice}/${ids.scan}/frames/0.jpg`,
    ).getProperties();
    expect(frame.contentType).toBe("image/jpeg");

    const check = await checkBlobs({
      source,
      containers,
      manifest: new Manifest(manifestPath),
      deep: true,
    });
    expect(check).toEqual({ objects: 5, notCopied: [], mismatched: [] });
  });

  it("copies only new or changed files on the next run (the cutover delta)", async () => {
    const key = `${ids.alice}/${ids.scan}/frames/3.jpg`;
    await addObject("scans", key, randomBytes(3000));
    await addObject("scans", `${ids.alice}/${ids.scan}/frames/0.jpg`, randomBytes(2100));
    const result = await runBlobs();
    expect(result).toMatchObject({ copied: 2, skipped: 4, failed: [] });
    const check = await checkBlobs({
      source,
      containers,
      manifest: new Manifest(manifestPath),
      deep: true,
    });
    expect(check.notCopied).toEqual([]);
    expect(check.mismatched).toEqual([]);
  });

  it("refuses a file whose bytes don't match Supabase's MD5, and leaves nothing behind", async () => {
    const key = `${ids.alice}/${ids.scan}/frames/4.jpg`;
    const body = randomBytes(1000);
    await addObject("scans", key, body, { etag: md5(Buffer.from("something else")) });
    const result = await runBlobs();
    expect(result.failed).toEqual([
      { key: `scans/${key}`, error: expect.stringContaining("MD5") as string },
    ]);
    expect(await containers["scans"]!.getBlobClient(key).exists()).toBe(false);
    const check = await checkBlobs({ source, containers, manifest: new Manifest(manifestPath) });
    expect(check.notCopied).toEqual([`scans/${key}`]);
  });
});

describe("schema drift", () => {
  it("stops when Supabase has a column the new schema doesn't", async () => {
    await source.query("ALTER TABLE public.scans ADD COLUMN favourite boolean");
    const plan = await buildPlan(source, target);
    expect(plan.unmapped).toEqual(["scans.favourite"]);
    const checks = await preflight(source, target, plan);
    expect(checks.errors).toEqual([expect.stringContaining("scans.favourite")]);
  });
});
