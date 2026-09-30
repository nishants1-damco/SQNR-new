import { Global, Module } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import { type AzureBlobStore, type BlobStore, blobStoreFromSettings } from "@spatial/storage";
import { API_CONFIG } from "../config/config.module";

/** The `scans` container: frames, depth files, thumbnails (plan §12.1). */
export const SCANS_BLOB_STORE = Symbol("SCANS_BLOB_STORE");

export function createScansBlobStore(config: ApiConfig): AzureBlobStore {
  return blobStoreFromSettings(config.blob, config.blob.containers.scans);
}

@Global()
@Module({
  providers: [
    {
      provide: SCANS_BLOB_STORE,
      inject: [API_CONFIG],
      useFactory: (config: ApiConfig): BlobStore => createScansBlobStore(config),
    },
  ],
  exports: [SCANS_BLOB_STORE],
})
export class StorageModule {}
