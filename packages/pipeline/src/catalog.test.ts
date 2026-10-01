import type { Database } from "@spatial/db";
import { MemoryBlobStore } from "@spatial/storage";
import { describe, expect, it } from "vitest";
import { CatalogSource } from "./catalog";
import { silentLogger } from "./logger";

const source = (options: Partial<ConstructorParameters<typeof CatalogSource>[0]> = {}) =>
  new CatalogSource({
    db: {} as Database,
    embedder: null,
    logger: silentLogger,
    imageOrigins: ["https://images.example.com"],
    ...options,
  });

describe("catalog reference photos", () => {
  it("reads a migrated row's blob key from the catalog container, never the network", async () => {
    const images = new MemoryBlobStore();
    await images.put("benq/gw2786tc-front.jpg", new Uint8Array([0xff, 0xd8, 0xff]), "image/jpeg");
    const fetched: string[] = [];
    const catalog = source({
      images,
      fetch: (url) => {
        fetched.push(String(url));
        return Promise.reject(new Error("no network"));
      },
    });
    expect(await catalog.fetchCatalogImage("benq/gw2786tc-front.jpg")).toEqual({
      contentType: "image/jpeg",
      base64: "/9j/",
    });
    expect(await catalog.fetchCatalogImage("missing.jpg")).toBeNull();
    expect(await catalog.fetchCatalogImage("../escape.jpg")).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("still refuses URLs outside the allowed origins", async () => {
    const catalog = source({ fetch: () => Promise.reject(new Error("must not fetch")) });
    expect(await catalog.fetchCatalogImage("http://169.254.169.254/latest")).toBeNull();
    expect(await catalog.fetchCatalogImage("file:///etc/passwd")).toBeNull();
  });
});
