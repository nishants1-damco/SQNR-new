// Single-use tokens behind emailed links. Only the SHA-256 is stored, so a
// database leak doesn't expose working links.
import { Inject, Injectable } from "@nestjs/common";
import { authEmailTokens, type Database, type EmailTokenPurpose } from "@spatial/db";
import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { DB } from "../database/database.module";

export const EMAIL_TOKEN_TTL_MS: Record<EmailTokenPurpose, number> = {
  verify_email: 24 * 60 * 60 * 1000,
  reset_password: 60 * 60 * 1000,
};

@Injectable()
export class EmailTokensRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  async create(userId: string, purpose: EmailTokenPurpose, tokenHash: string): Promise<void> {
    await this.db.insert(authEmailTokens).values({
      userId,
      purpose,
      tokenHash,
      expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS[purpose]),
    });
  }

  /**
   * Marks the token used and returns its user, or null if it is unknown,
   * expired or already used. Redeeming one token also retires the user's
   * other outstanding tokens for the same purpose.
   */
  async consume(tokenHash: string, purpose: EmailTokenPurpose): Promise<string | null> {
    return this.db.transaction(async (tx) => {
      const [token] = await tx
        .update(authEmailTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(authEmailTokens.tokenHash, tokenHash),
            eq(authEmailTokens.purpose, purpose),
            isNull(authEmailTokens.usedAt),
            gt(authEmailTokens.expiresAt, sql`now()`),
          ),
        )
        .returning({ userId: authEmailTokens.userId });
      if (!token) return null;
      await tx
        .update(authEmailTokens)
        .set({ usedAt: sql`now()` })
        .where(
          and(
            eq(authEmailTokens.userId, token.userId),
            eq(authEmailTokens.purpose, purpose),
            isNull(authEmailTokens.usedAt),
          ),
        );
      return token.userId;
    });
  }
}
