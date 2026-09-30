// Boots the real API (createApp) against a throwaway database, the local
// Redis (under a per-run key prefix), a throwaway Azurite container and
// Mailpit. Geocoding uses the fake provider, so tests never call Nominatim. Requests go through
// Fastify's inject(), so the whole HTTP stack runs without opening a port.
import "reflect-metadata";
import { randomBytes, randomInt } from "node:crypto";
import type { NestFastifyApplication } from "@nestjs/platform-fastify";
import { type ApiConfig, loadApiConfig } from "@spatial/config";
import { createTestDatabase, type TestDatabase } from "@spatial/db/testing";
import { createApp } from "../../src/app";
import { createScansBlobStore } from "../../src/storage/storage.module";

export const WEB_ORIGIN = "http://localhost:5173";

export interface RegisteredRoute {
  method: string;
  url: string;
}

export interface TestApp {
  app: NestFastifyApplication;
  config: ApiConfig;
  database: TestDatabase;
  /** Every route Fastify registered for the API (HEAD/OPTIONS and /docs excluded). */
  routes: RegisteredRoute[];
  close(): Promise<void>;
}

export async function startTestApp(env: Record<string, string> = {}): Promise<TestApp> {
  const database = await createTestDatabase();
  const container = `test-${randomBytes(6).toString("hex")}`;
  const config = loadApiConfig({
    NODE_ENV: "test",
    LOG_LEVEL: process.env["TEST_LOG_LEVEL"] ?? "silent",
    DATABASE_URL: database.appUrl,
    REDIS_KEY_PREFIX: `test:${database.name}:`,
    QUEUE_PREFIX: `test:${database.name}`,
    WEB_ORIGINS: WEB_ORIGIN,
    APP_BASE_URL: WEB_ORIGIN,
    BLOB_CONTAINER_SCANS: container,
    GEOCODER_PROVIDER: "fake",
    ...env,
  });
  const blobs = createScansBlobStore(config);
  await blobs.ensureContainer();

  const app = await createApp(config);
  const routes: RegisteredRoute[] = [];
  app
    .getHttpAdapter()
    .getInstance()
    .addHook("onRoute", (route) => {
      for (const method of [route.method].flat()) {
        if (method === "HEAD" || method === "OPTIONS" || route.url.startsWith("/docs")) continue;
        routes.push({ method, url: route.url });
      }
    });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    config,
    database,
    routes,
    close: async () => {
      await app.close();
      await blobs.container.deleteIfExists();
      await database.drop();
    },
  };
}

export interface Response<T = Record<string, unknown>> {
  status: number;
  body: T;
  headers: Record<string, string | string[] | number | undefined>;
  cookies: { name: string; value: string; [attribute: string]: unknown }[];
}

/**
 * One simulated client: a fixed source IP (so per-IP rate limits apply per
 * test, not across the whole file) and a cookie jar for the refresh cookie.
 */
export class Client {
  readonly ip = `10.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
  private cookies = new Map<string, string>();

  constructor(private readonly app: NestFastifyApplication) {}

  async request<T = Record<string, unknown>>(options: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    url: string;
    body?: unknown;
    token?: string;
    headers?: Record<string, string>;
    /** Send cookies from the jar (default true). */
    withCookies?: boolean;
  }): Promise<Response<T>> {
    const headers: Record<string, string> = { ...options.headers };
    if (options.token) headers["authorization"] = `Bearer ${options.token}`;
    if (options.withCookies !== false && this.cookies.size) {
      headers["cookie"] = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
    }
    const response = await this.app.inject({
      method: options.method,
      url: options.url,
      headers,
      remoteAddress: this.ip,
      ...(options.body === undefined ? {} : { payload: options.body as object }),
    });
    for (const cookie of response.cookies as Response["cookies"]) {
      if (cookie.value === "" || cookie["maxAge"] === 0) this.cookies.delete(cookie.name);
      else this.cookies.set(cookie.name, cookie.value);
    }
    const text = response.body;
    return {
      status: response.statusCode,
      // Non-JSON bodies (the event stream) come back as `{ text }`.
      body: (!text
        ? {}
        : /json/.test(String(response.headers["content-type"] ?? ""))
          ? JSON.parse(text)
          : { text }) as T,
      headers: response.headers,
      cookies: response.cookies as Response["cookies"],
    };
  }

  cookie(name: string): string | undefined {
    return this.cookies.get(name);
  }

  setCookie(name: string, value: string) {
    this.cookies.set(name, value);
  }
}

let counter = 0;
/** A unique, valid address per call, so tests never collide in Mailpit or the users table. */
export function uniqueEmail(label = "user"): string {
  counter++;
  return `${label}-${Date.now().toString(36)}-${counter}@example.test`;
}
