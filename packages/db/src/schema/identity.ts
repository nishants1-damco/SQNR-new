// Mirrors migrations/0001_identity.sql. The SQL is the source of truth; the
// drift test (schema.int.test.ts) fails if the two disagree.
import { type AnyPgColumn, inet, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { citext } from "./types";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").notNull().unique(),
  passwordHash: text("password_hash"),
  emailVerifiedAt: timestamptz("email_verified_at"),
  lastSignInAt: timestamptz("last_sign_in_at"),
  disabledAt: timestamptz("disabled_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
  updatedAt: timestamptz("updated_at").notNull().defaultNow(),
});

export const profiles = pgTable("profiles", {
  id: uuid("id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  displayName: text("display_name"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const authRefreshTokens = pgTable("auth_refresh_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamptz("expires_at").notNull(),
  revokedAt: timestamptz("revoked_at"),
  replacedBy: uuid("replaced_by").references((): AnyPgColumn => authRefreshTokens.id, {
    onDelete: "set null",
  }),
  userAgent: text("user_agent"),
  ip: inet("ip"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export const EMAIL_TOKEN_PURPOSES = ["verify_email", "reset_password"] as const;
export type EmailTokenPurpose = (typeof EMAIL_TOKEN_PURPOSES)[number];

export const authEmailTokens = pgTable("auth_email_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  purpose: text("purpose", { enum: EMAIL_TOKEN_PURPOSES }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamptz("expires_at").notNull(),
  usedAt: timestamptz("used_at"),
  createdAt: timestamptz("created_at").notNull().defaultNow(),
});

export { timestamptz };
