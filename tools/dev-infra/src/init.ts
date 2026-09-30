// Creates the Azurite containers and CORS rules the app expects (plan §12).
// Idempotent: safe to run after every `docker compose up`. Database schema is
// not created here; migrations arrive with packages/db in phase 1.
import { BlobServiceClient } from "@azure/storage-blob";
import { config } from "./config";

async function main() {
  const service = BlobServiceClient.fromConnectionString(config.blob.connectionString);

  for (const { name, public: isPublic } of config.blob.containers) {
    const container = service.getContainerClient(name);
    const result = await container.createIfNotExists(isPublic ? { access: "blob" } : {});
    console.log(
      `${result.succeeded ? "created" : "exists "}  container ${name}${isPublic ? " (anonymous read)" : ""}`,
    );
  }

  // Browsers upload and download directly with SAS URLs (plan §5.2, §12.4).
  await service.setProperties({
    cors: [
      {
        allowedOrigins: config.webOrigins.join(","),
        allowedMethods: "GET,HEAD,PUT,OPTIONS",
        allowedHeaders: "content-type,x-ms-blob-type,x-ms-version,x-ms-date,x-ms-client-request-id",
        exposedHeaders: "etag,content-length,x-ms-request-id",
        maxAgeInSeconds: 3600,
      },
    ],
  });
  console.log(`set      blob CORS for ${config.webOrigins.join(", ")}`);
}

main().catch((err: unknown) => {
  console.error("Azurite init failed. Is the stack running? Try `pnpm infra:up`.");
  console.error(err);
  process.exit(1);
});
