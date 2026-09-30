import { Inject, Injectable } from "@nestjs/common";
import type { User } from "@spatial/contracts";
import { type Database, profiles, users } from "@spatial/db";
import { eq, sql } from "drizzle-orm";
import { DB } from "../database/database.module";

export interface UserRecord {
  id: string;
  email: string;
  passwordHash: string | null;
  emailVerifiedAt: Date | null;
  disabledAt: Date | null;
  createdAt: Date;
  displayName: string | null;
}

export class EmailTaken extends Error {
  override name = "EmailTaken";
}

/** Postgres error code, whether or not a driver wrapper sits in front of it. */
export function pgErrorCode(err: unknown): string | undefined {
  for (let e: unknown = err; e; e = (e as { cause?: unknown }).cause) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return undefined;
}

export function toUserDto(user: UserRecord): User {
  return {
    id: user.id,
    email: user.email,
    emailVerified: user.emailVerifiedAt !== null,
    displayName: user.displayName,
    createdAt: user.createdAt.toISOString(),
  };
}

const userColumns = {
  id: users.id,
  email: users.email,
  passwordHash: users.passwordHash,
  emailVerifiedAt: users.emailVerifiedAt,
  disabledAt: users.disabledAt,
  createdAt: users.createdAt,
  displayName: profiles.displayName,
};

@Injectable()
export class UsersRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async findByEmail(email: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(eq(users.email, email))
      .limit(1);
    return row ?? null;
  }

  async findById(id: string): Promise<UserRecord | null> {
    const [row] = await this.db
      .select(userColumns)
      .from(users)
      .leftJoin(profiles, eq(profiles.id, users.id))
      .where(eq(users.id, id))
      .limit(1);
    return row ?? null;
  }

  /** Creates the user and their profile together. Throws EmailTaken on a duplicate address. */
  async create(input: {
    email: string;
    passwordHash: string;
    displayName: string;
  }): Promise<UserRecord> {
    try {
      return await this.db.transaction(async (tx) => {
        const [user] = await tx
          .insert(users)
          .values({ email: input.email, passwordHash: input.passwordHash })
          .returning();
        if (!user) throw new Error("insert returned no row");
        await tx.insert(profiles).values({ id: user.id, displayName: input.displayName });
        return { ...user, displayName: input.displayName };
      });
    } catch (err) {
      if (pgErrorCode(err) === "23505") throw new EmailTaken();
      throw err;
    }
  }

  async setPasswordHash(id: string, passwordHash: string): Promise<void> {
    await this.db.update(users).set({ passwordHash }).where(eq(users.id, id));
  }

  async markEmailVerified(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
      .where(eq(users.id, id));
  }

  async recordSignIn(id: string): Promise<void> {
    await this.db
      .update(users)
      .set({ lastSignInAt: sql`now()` })
      .where(eq(users.id, id));
  }
}
