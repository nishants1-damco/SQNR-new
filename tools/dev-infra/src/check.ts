// End-to-end check of the local stack: each service is exercised the way the
// app will use it, not just pinged. Exits non-zero if any required check fails.
// Ollama is optional (D12: local models are opt-in) and only reported.
import { randomUUID } from "node:crypto";
import {
  BlobSASPermissions,
  BlobServiceClient,
  generateBlobSASQueryParameters,
  StorageSharedKeyCredential,
} from "@azure/storage-blob";
import { Redis } from "ioredis";
import nodemailer from "nodemailer";
import pg from "pg";
import { config } from "./config";

type Check = { name: string; optional?: boolean; run: () => Promise<string> };

const REQUIRED_EXTENSIONS = ["postgis", "vector", "citext", "pg_trgm"];

async function withClient<T>(
  opts: { port: number; user: string; password: string },
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({
    host: config.postgres.host,
    database: config.postgres.database,
    ...opts,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const checks: Check[] = [
  {
    name: "postgres: extensions installed",
    run: () =>
      withClient({ port: config.postgres.port, ...config.postgres.appUser }, async (c) => {
        const { rows } = await c.query<{ extname: string; extversion: string }>(
          "select extname, extversion from pg_extension where extname = any($1) order by extname",
          [REQUIRED_EXTENSIONS],
        );
        const found = rows.map((r) => r.extname);
        const missing = REQUIRED_EXTENSIONS.filter((e) => !found.includes(e));
        assert(missing.length === 0, `missing extensions: ${missing.join(", ")}`);
        return rows.map((r) => `${r.extname} ${r.extversion}`).join(", ");
      }),
  },
  {
    name: "postgres: PostGIS and pgvector queries",
    run: () =>
      withClient({ port: config.postgres.port, ...config.postgres.appUser }, async (c) => {
        const { rows } = await c.query<{ point: string; distance: number }>(
          "select ST_AsText(ST_MakePoint(1, 2)) as point, ('[1,2,3]'::vector <-> '[1,2,5]'::vector) as distance",
        );
        const row = rows[0];
        assert(row?.point === "POINT(1 2)", `unexpected PostGIS result ${row?.point}`);
        assert(Number(row.distance) === 2, `unexpected vector distance ${row.distance}`);
        return "ST_MakePoint and vector distance OK";
      }),
  },
  {
    name: "postgres: application roles",
    run: () =>
      withClient({ port: config.postgres.port, ...config.postgres.migratorUser }, async (c) => {
        const { rows } = await c.query<{ migrator: boolean; app: boolean }>(
          `select has_schema_privilege('app_migrator', 'public', 'CREATE') as migrator,
                  has_schema_privilege('app_rw', 'public', 'CREATE') as app`,
        );
        const row = rows[0];
        assert(row?.migrator === true, "app_migrator cannot create in schema public");
        assert(row.app === false, "app_rw should not be able to create in schema public");
        return "app_migrator owns public; app_rw has no DDL rights";
      }),
  },
  {
    name: "pgbouncer: transaction pooling with prepared statements",
    run: () =>
      withClient({ port: config.pgbouncerPort, ...config.postgres.appUser }, async (c) => {
        // A named prepared statement run twice needs max_prepared_statements
        // support in transaction mode (plan §8.4, risk R11).
        const statement = { name: "dev_infra_check", text: "select $1::int + 1 as n" };
        for (const value of [1, 41]) {
          const { rows } = await c.query<{ n: number }>({ ...statement, values: [value] });
          assert(rows[0]?.n === value + 1, `unexpected result through PgBouncer`);
        }
        const { rows } = await c.query<{ user: string }>("select current_user as user");
        return `connected as ${rows[0]?.user} via port ${config.pgbouncerPort}`;
      }),
  },
  {
    name: "redis: queue-safe configuration",
    run: async () => {
      const redis = new Redis(config.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
      try {
        await redis.connect().catch(() => {
          throw new Error(`cannot connect to ${config.redisUrl}`);
        });
        assert((await redis.ping()) === "PONG", "PING failed");
        const [, policy] = (await redis.config("GET", "maxmemory-policy")) as string[];
        const [, aof] = (await redis.config("GET", "appendonly")) as string[];
        assert(policy === "noeviction", `maxmemory-policy is ${policy}, BullMQ needs noeviction`);
        assert(aof === "yes", "appendonly is off; queued jobs would not survive a restart");
        return "PONG, noeviction, appendonly yes";
      } finally {
        redis.disconnect();
      }
    },
  },
  {
    name: "azurite: containers and CORS",
    run: async () => {
      const service = BlobServiceClient.fromConnectionString(config.blob.connectionString);
      const names: string[] = [];
      for await (const container of service.listContainers()) names.push(container.name);
      const missing = config.blob.containers.map((c) => c.name).filter((n) => !names.includes(n));
      assert(missing.length === 0, `missing containers: ${missing.join(", ")} (run pnpm infra:up)`);
      const { cors } = await service.getProperties();
      assert(cors && cors.length > 0, "no CORS rules; browser uploads would be blocked");
      return `${config.blob.containers.map((c) => c.name).join(", ")}; CORS for ${cors[0]?.allowedOrigins}`;
    },
  },
  {
    name: "azurite: direct upload with a create-only SAS URL",
    run: async () => {
      // The browser upload flow from plan §5.2: the API signs a URL for one
      // blob, the client PUTs to it without any storage credential.
      const credential = new StorageSharedKeyCredential(
        config.blob.accountName,
        config.blob.accountKey,
      );
      const blobName = `_dev-infra-check/${randomUUID()}.txt`;
      const sas = generateBlobSASQueryParameters(
        {
          containerName: "scans",
          blobName,
          permissions: BlobSASPermissions.parse("c"),
          expiresOn: new Date(Date.now() + 5 * 60 * 1000),
          contentType: "text/plain",
        },
        credential,
      ).toString();
      const url = `${config.blob.endpoint}/scans/${blobName}?${sas}`;
      const body = `dev-infra check ${new Date().toISOString()}`;
      const put = await fetch(url, {
        method: "PUT",
        headers: { "x-ms-blob-type": "BlockBlob", "content-type": "text/plain" },
        body,
      });
      assert(put.status === 201, `SAS upload returned ${put.status}: ${await put.text()}`);

      const service = BlobServiceClient.fromConnectionString(config.blob.connectionString);
      const blob = service.getContainerClient("scans").getBlobClient(blobName);
      const downloaded = (await blob.downloadToBuffer()).toString("utf8");
      await blob.delete();
      assert(downloaded === body, "downloaded content differs from the upload");
      return "PUT via SAS 201, content verified, test blob deleted";
    },
  },
  {
    name: "mailpit: SMTP delivery",
    run: async () => {
      const subject = `dev-infra check ${randomUUID()}`;
      const transport = nodemailer.createTransport({
        host: "127.0.0.1",
        port: config.mailpit.smtpPort,
        secure: false,
      });
      await transport.sendMail({
        from: "no-reply@spatial.local",
        to: "developer@spatial.local",
        subject,
        text: "If you can read this in Mailpit, email from the auth module will work.",
      });

      type Message = { ID: string; Subject: string };
      let found: Message | undefined;
      for (let attempt = 0; attempt < 10 && !found; attempt++) {
        const res = await fetch(`${config.mailpit.apiUrl}/messages?limit=50`);
        const { messages } = (await res.json()) as { messages: Message[] };
        found = messages.find((m) => m.Subject === subject);
        if (!found) await new Promise((r) => setTimeout(r, 200));
      }
      assert(found, "message was sent but never appeared in Mailpit");
      await fetch(`${config.mailpit.apiUrl}/messages`, {
        method: "DELETE",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ IDs: [found.ID] }),
      });
      return `sent over SMTP :${config.mailpit.smtpPort}, received via API, cleaned up`;
    },
  },
  {
    name: "ollama: local model server (optional, pnpm infra:llm)",
    optional: true,
    run: async () => {
      const res = await fetch(`${config.ollamaUrl}/api/tags`, {
        signal: AbortSignal.timeout(2000),
      });
      const { models } = (await res.json()) as { models: { name: string }[] };
      return models.length ? models.map((m) => m.name).join(", ") : "running, no models yet";
    },
  },
];

async function main() {
  let failures = 0;
  for (const check of checks) {
    try {
      const detail = await check.run();
      console.log(`✓ ${check.name}: ${detail}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (check.optional) {
        console.log(`- ${check.name}: not running`);
      } else {
        failures++;
        console.log(`✗ ${check.name}: ${message}`);
      }
    }
  }
  if (failures) {
    console.log(`\n${failures} check(s) failed. Is the stack up? Try \`pnpm infra:up\`.`);
    process.exit(1);
  }
  console.log("\nLocal stack OK.");
}

void main();
