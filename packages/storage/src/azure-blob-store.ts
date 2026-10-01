// BlobStore on Azure Blob Storage (Azurite locally).
//
// Signing (plan §12.3):
//   * Local / tests: an account-key connection string (Azurite's dev account).
//   * Production: the account URL plus a token credential (managed identity).
//     SAS URLs are signed with a user-delegation key fetched through that
//     identity, so no account key ever lives in the app, and shared-key access
//     can be disabled on the storage account.
import type { TokenCredential } from "@azure/core-auth";
import {
  BlobSASPermissions,
  BlobServiceClient,
  type ContainerClient,
  generateBlobSASQueryParameters,
  SASProtocol,
  StorageSharedKeyCredential,
  type UserDelegationKey,
} from "@azure/storage-blob";
import { assertSafeKey, type BlobHead, type BlobStore, type PresignedUpload } from "./blob-store";

export interface AzureBlobStoreOptions {
  container: string;
  /** Account-key connection string (Azurite, or accounts that still allow shared keys). */
  connectionString?: string;
  /** `https://<account>.blob.core.windows.net`, used with `credential`. */
  accountUrl?: string;
  credential?: TokenCredential;
  /**
   * Origin browsers use for SAS URLs when it differs from the SDK's endpoint
   * (e.g. a CDN in front of storage). Path and query are kept.
   */
  publicEndpoint?: string;
  /** Deletes in flight at once. */
  deleteConcurrency?: number;
}

/** Tolerate clocks a few minutes apart between the API and storage. */
const CLOCK_SKEW_MS = 5 * 60 * 1000;
/** User-delegation keys are fetched for this long and refreshed well before expiry. */
const DELEGATION_KEY_TTL_MS = 6 * 60 * 60 * 1000;
const DELEGATION_KEY_MIN_REMAINING_MS = 2 * 60 * 60 * 1000;

type Signer =
  | { kind: "shared-key"; credential: StorageSharedKeyCredential }
  | { kind: "user-delegation"; accountName: string };

function sharedKeyFromConnectionString(connectionString: string): StorageSharedKeyCredential {
  const parts = new Map(
    connectionString
      .split(";")
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i), part.slice(i + 1)] as const;
      }),
  );
  const name = parts.get("AccountName");
  const key = parts.get("AccountKey");
  if (!name || !key) throw new Error("Blob connection string needs AccountName and AccountKey");
  return new StorageSharedKeyCredential(name, key);
}

export class AzureBlobStore implements BlobStore {
  readonly container: ContainerClient;
  private readonly service: BlobServiceClient;
  private readonly signer: Signer;
  private delegationKey: { key: UserDelegationKey; expiresOn: Date } | null = null;
  /** The container's URL as browsers reach it (publicEndpoint applied). */
  private readonly containerUrl: string;

  constructor(private readonly options: AzureBlobStoreOptions) {
    if (options.connectionString) {
      this.service = BlobServiceClient.fromConnectionString(options.connectionString);
      this.signer = {
        kind: "shared-key",
        credential: sharedKeyFromConnectionString(options.connectionString),
      };
    } else if (options.accountUrl && options.credential) {
      this.service = new BlobServiceClient(options.accountUrl, options.credential);
      this.signer = { kind: "user-delegation", accountName: this.service.accountName };
    } else {
      throw new Error("AzureBlobStore needs a connection string, or an account URL and credential");
    }
    this.container = this.service.getContainerClient(options.container);
    this.containerUrl = this.publicUrl(this.container.url);
  }

  async presignPut(
    key: string,
    options: { contentType: string; expiresInSec: number },
  ): Promise<PresignedUpload> {
    const expiresAt = new Date(Date.now() + options.expiresInSec * 1000);
    const url = await this.sign(key, {
      // Create only: can't overwrite an existing blob, read, list or delete.
      permissions: BlobSASPermissions.parse("c"),
      expiresOn: expiresAt,
      contentType: options.contentType,
    });
    return {
      url,
      method: "PUT",
      headers: { "x-ms-blob-type": "BlockBlob", "content-type": options.contentType },
      expiresAt,
    };
  }

  async presignGet(
    key: string,
    options: { expiresInSec: number; downloadName?: string },
  ): Promise<string> {
    return this.sign(key, {
      permissions: BlobSASPermissions.parse("r"),
      expiresOn: new Date(Date.now() + options.expiresInSec * 1000),
      ...(options.downloadName
        ? { contentDisposition: `attachment; filename="${options.downloadName.replace(/"/g, "")}"` }
        : {}),
    });
  }

  async head(key: string): Promise<BlobHead | null> {
    assertSafeKey(key);
    try {
      const props = await this.container.getBlobClient(key).getProperties();
      return {
        size: props.contentLength ?? 0,
        contentType: props.contentType ?? null,
        etag: props.etag ?? null,
      };
    } catch (err) {
      if ((err as { statusCode?: number }).statusCode === 404) return null;
      throw err;
    }
  }

  async get(key: string): Promise<Uint8Array> {
    assertSafeKey(key);
    return new Uint8Array(await this.container.getBlobClient(key).downloadToBuffer());
  }

  async put(key: string, body: Uint8Array, contentType: string): Promise<void> {
    assertSafeKey(key);
    await this.container
      .getBlockBlobClient(key)
      .uploadData(body, { blobHTTPHeaders: { blobContentType: contentType } });
  }

  async delete(keys: string[]): Promise<number> {
    keys.forEach(assertSafeKey);
    const unique = [...new Set(keys)];
    const concurrency = this.options.deleteConcurrency ?? 8;
    let deleted = 0;
    for (let i = 0; i < unique.length; i += concurrency) {
      const results = await Promise.all(
        unique
          .slice(i, i + concurrency)
          .map((key) =>
            this.container.getBlobClient(key).deleteIfExists({ deleteSnapshots: "include" }),
          ),
      );
      deleted += results.filter((r) => r.succeeded).length;
    }
    return deleted;
  }

  async deletePrefix(prefix: string): Promise<number> {
    assertSafeKey(prefix);
    // A prefix must end at a folder boundary, so "u1/s1" can't match "u1/s10".
    if (!prefix.endsWith("/")) throw new Error(`Prefix must end with "/": ${prefix}`);
    const keys: string[] = [];
    for await (const blob of this.container.listBlobsFlat({ prefix })) keys.push(blob.name);
    return this.delete(keys);
  }

  /** Creates the container if it's missing (local development and tests). */
  async ensureContainer(): Promise<void> {
    await this.container.createIfNotExists();
  }

  private async sign(
    key: string,
    options: {
      permissions: BlobSASPermissions;
      expiresOn: Date;
      contentType?: string;
      contentDisposition?: string;
    },
  ): Promise<string> {
    assertSafeKey(key);
    // Built by hand: a BlobClient per URL was 13% of API CPU on detail pages
    // with many frames (plan §18.1 load tests).
    const url = `${this.containerUrl}/${key.split("/").map(encodeURIComponent).join("/")}`;
    const values = {
      containerName: this.container.containerName,
      blobName: key,
      startsOn: new Date(Date.now() - CLOCK_SKEW_MS),
      protocol: url.startsWith("https:") ? SASProtocol.Https : SASProtocol.HttpsAndHttp,
      ...options,
    };
    const sas =
      this.signer.kind === "shared-key"
        ? generateBlobSASQueryParameters(values, this.signer.credential)
        : generateBlobSASQueryParameters(
            values,
            await this.userDelegationKey(options.expiresOn),
            this.signer.accountName,
          );
    return `${url}?${sas.toString()}`;
  }

  private async userDelegationKey(mustCover: Date): Promise<UserDelegationKey> {
    const now = Date.now();
    const cached = this.delegationKey;
    if (
      cached &&
      cached.expiresOn.getTime() - now > DELEGATION_KEY_MIN_REMAINING_MS &&
      cached.expiresOn > mustCover
    ) {
      return cached.key;
    }
    const expiresOn = new Date(Math.max(now + DELEGATION_KEY_TTL_MS, mustCover.getTime() + 60_000));
    const key = await this.service.getUserDelegationKey(new Date(now - CLOCK_SKEW_MS), expiresOn);
    this.delegationKey = { key, expiresOn };
    return key;
  }

  private publicUrl(url: string): string {
    if (!this.options.publicEndpoint) return url;
    const internal = new URL(url);
    const external = new URL(this.options.publicEndpoint);
    internal.protocol = external.protocol;
    internal.host = external.host;
    return internal.toString().replace(/\/$/, "");
  }
}
