import { describe, expect, it } from "vitest";
import { AzureBlobStore } from "./azure-blob-store";

const devConnection =
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://azurite:10000/devstoreaccount1;";

describe("AzureBlobStore signing (no network)", () => {
  it("signs a create-only, content-type-bound upload URL", async () => {
    const store = new AzureBlobStore({ container: "scans", connectionString: devConnection });
    const upload = await store.presignPut("u/s/frames/1.jpg", {
      contentType: "image/jpeg",
      expiresInSec: 900,
    });
    const url = new URL(upload.url);
    expect(url.pathname).toBe("/devstoreaccount1/scans/u/s/frames/1.jpg");
    expect(url.searchParams.get("sp")).toBe("c");
    expect(url.searchParams.get("rsct")).toBe("image/jpeg");
    expect(upload.headers).toEqual({ "x-ms-blob-type": "BlockBlob", "content-type": "image/jpeg" });
  });

  it("rewrites SAS URLs to the public endpoint browsers use", async () => {
    const store = new AzureBlobStore({
      container: "scans",
      connectionString: devConnection,
      publicEndpoint: "http://127.0.0.1:10000",
    });
    const url = new URL(await store.presignGet("u/s/frames/1.jpg", { expiresInSec: 60 }));
    expect(url.host).toBe("127.0.0.1:10000");
    expect(url.pathname).toBe("/devstoreaccount1/scans/u/s/frames/1.jpg");
    expect(url.searchParams.get("sp")).toBe("r");
  });

  it("encodes each path segment of the key the way the SDK's BlobClient does", async () => {
    const store = new AzureBlobStore({ container: "scans", connectionString: devConnection });
    const key = "u/s/depth/ab12-room scan#1+ü.ply";
    const signed = new URL(await store.presignGet(key, { expiresInSec: 60 }));
    expect(signed.origin + signed.pathname).toBe(store.container.getBlobClient(key).url);
  });

  it("needs a connection string or an account URL with a credential", () => {
    expect(() => new AzureBlobStore({ container: "scans" })).toThrow(/connection string/);
  });
});
