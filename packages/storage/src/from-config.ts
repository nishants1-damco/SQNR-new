import { DefaultAzureCredential } from "@azure/identity";
import { AzureBlobStore, type AzureBlobStoreOptions } from "./azure-blob-store";

export interface BlobSettings {
  connectionString: string | null;
  accountUrl: string | null;
  publicEndpoint: string | null;
}

/**
 * A store for one container from app settings: an account-key connection
 * string (Azurite locally), or the account URL with Azure credentials
 * (managed identity in Azure, developer sign-in when run locally against Azure).
 */
export function blobStoreFromSettings(settings: BlobSettings, container: string): AzureBlobStore {
  const options: AzureBlobStoreOptions = { container };
  if (settings.connectionString) {
    options.connectionString = settings.connectionString;
  } else if (settings.accountUrl) {
    options.accountUrl = settings.accountUrl;
    options.credential = new DefaultAzureCredential();
  }
  if (settings.publicEndpoint) options.publicEndpoint = settings.publicEndpoint;
  return new AzureBlobStore(options);
}
