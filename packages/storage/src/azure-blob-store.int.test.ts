// Against Azurite (`pnpm infra:up`): real signed URLs, real HTTP uploads.
import { randomBytes } from "node:crypto";
import { localStack } from "@spatial/config";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AzureBlobStore } from "./azure-blob-store";

const container = `test-${randomBytes(6).toString("hex")}`;
const store = new AzureBlobStore({
  container,
  connectionString: localStack().blob.connectionString,
});
const bytes = (text: string) => new TextEncoder().encode(text);

beforeAll(async () => {
  await store.ensureContainer();
});

afterAll(async () => {
  await store.container.deleteIfExists();
});

describe("presigned uploads", () => {
  it("lets a client PUT once to the signed key, then read it back with a read URL", async () => {
    const key = "user-1/scan-1/frames/a.jpg";
    const upload = await store.presignPut(key, { contentType: "image/jpeg", expiresInSec: 300 });
    const put = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: bytes("jpeg-ish"),
    });
    expect(put.status).toBe(201);
    // Create-only: the same URL can't overwrite what was uploaded.
    const again = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: bytes("evil"),
    });
    expect(again.status).toBe(403);

    expect(await store.head(key)).toMatchObject({ size: 8, contentType: "image/jpeg" });
    const read = await fetch(await store.presignGet(key, { expiresInSec: 300 }));
    expect(read.status).toBe(200);
    expect(await read.text()).toBe("jpeg-ish");
  });

  it("scopes the upload URL to its one key", async () => {
    const upload = await store.presignPut("user-1/scan-1/frames/b.jpg", {
      contentType: "image/jpeg",
      expiresInSec: 300,
    });
    const elsewhere = upload.url.replace("/frames/b.jpg", "/frames/other.jpg");
    const res = await fetch(elsewhere, {
      method: "PUT",
      headers: upload.headers,
      body: bytes("x"),
    });
    expect(res.status).toBe(403);
    expect(await store.head("user-1/scan-1/frames/other.jpg")).toBeNull();
  });

  it("refuses an expired URL", async () => {
    const upload = await store.presignPut("user-1/scan-1/frames/late.jpg", {
      contentType: "image/jpeg",
      expiresInSec: -60,
    });
    const res = await fetch(upload.url, {
      method: "PUT",
      headers: upload.headers,
      body: bytes("x"),
    });
    expect(res.status).toBe(403);
  });

  it("does not let an upload URL read", async () => {
    const key = "user-1/scan-1/frames/c.jpg";
    await store.put(key, bytes("secret"), "image/jpeg");
    const upload = await store.presignPut(key, { contentType: "image/jpeg", expiresInSec: 300 });
    const res = await fetch(upload.url);
    expect(res.status).toBe(403);
  });
});

describe("server-side operations", () => {
  it("reports missing blobs as null and round-trips content", async () => {
    expect(await store.head("user-1/nothing.jpg")).toBeNull();
    await store.put("user-1/scan-2/depth/room.ply", bytes("ply"), "application/octet-stream");
    expect(new TextDecoder().decode(await store.get("user-1/scan-2/depth/room.ply"))).toBe("ply");
  });

  it("deletes keys and whole prefixes without touching neighbours", async () => {
    for (const key of ["u9/s1/a.jpg", "u9/s1/frames/b.jpg", "u9/s10/c.jpg"]) {
      await store.put(key, bytes(key), "image/jpeg");
    }
    expect(await store.delete(["u9/s1/a.jpg", "u9/missing.jpg"])).toBe(1);
    expect(await store.deletePrefix("u9/s1/")).toBe(1);
    expect(await store.head("u9/s10/c.jpg")).not.toBeNull();
    await expect(store.deletePrefix("u9/s1")).rejects.toThrow(/must end with/);
  });

  it("refuses unsafe keys", async () => {
    await expect(store.head("../other-container/x")).rejects.toThrow(/Unsafe/);
    await expect(store.presignGet("/abs", { expiresInSec: 60 })).rejects.toThrow(/Unsafe/);
  });
});
