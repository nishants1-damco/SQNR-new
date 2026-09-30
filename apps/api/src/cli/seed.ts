// Development seed: a verified user to sign in with. Refuses to run in
// production. Idempotent: re-running resets the dev user's password.
import { existsSync } from "node:fs";
import { loadApiConfig } from "@spatial/config";
import { createDatabase, profiles, users } from "@spatial/db";
import { sql } from "drizzle-orm";
import { PasswordsService } from "../auth/passwords.service";

export const DEV_USER = { email: "dev@spatial.local", password: "spatial-dev-password" };

async function main() {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const config = loadApiConfig();
  if (config.env === "production") throw new Error("The development seed never runs in production");

  const { db, close } = createDatabase({ url: config.database.url, max: 1 });
  try {
    const passwordHash = await new PasswordsService().hash(DEV_USER.password);
    const [user] = await db
      .insert(users)
      .values({ email: DEV_USER.email, passwordHash, emailVerifiedAt: new Date() })
      .onConflictDoUpdate({
        target: users.email,
        set: { passwordHash, emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` },
      })
      .returning({ id: users.id });
    await db
      .insert(profiles)
      .values({ id: user!.id, displayName: "Dev User" })
      .onConflictDoNothing();
    console.log(`Seeded ${DEV_USER.email} / ${DEV_USER.password}`);
  } finally {
    await close();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
