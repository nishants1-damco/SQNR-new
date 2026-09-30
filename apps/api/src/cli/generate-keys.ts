// Prints a new Ed25519 signing key in the form the API reads (plan §10.2).
// Locally, paste the output into apps/api/.env so sessions survive restarts.
// In Azure, store JWT_PRIVATE_KEY in Key Vault; to rotate, move the old key's
// public half to JWT_PREVIOUS_PUBLIC_KEY / JWT_PREVIOUS_KEY_ID for one
// access-token lifetime so tokens already issued keep verifying.
import { generateKeyPairSync } from "node:crypto";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const keyId = new Date().toISOString().slice(0, 10);
const oneLine = (pem: string) => pem.trim().replace(/\n/g, "\\n");

console.log(`JWT_KEY_ID=${keyId}`);
console.log(
  `JWT_PRIVATE_KEY="${oneLine(privateKey.export({ type: "pkcs8", format: "pem" }).toString())}"`,
);
console.log(`# Public key (for JWT_PREVIOUS_PUBLIC_KEY during the next rotation):`);
console.log(`# ${oneLine(publicKey.export({ type: "spki", format: "pem" }).toString())}`);
