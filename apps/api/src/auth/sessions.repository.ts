// Refresh-token families (plan §10.2). A family is one signed-in device. Each
// refresh replaces the token; presenting a token that was already replaced
// means it was copied, so the whole family is revoked and that device (and
// whoever copied the token) must sign in again.
import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { authRefreshTokens, type Database } from "@spatial/db";
import { and, eq, isNull, sql } from "drizzle-orm";
import { DB } from "../database/database.module";
import type { ClientInfo } from "./auth.types";

export type RotateResult =
  | { kind: "rotated"; userId: string; familyId: string }
  | { kind: "reused"; userId: string; familyId: string }
  | { kind: "invalid" };

@Injectable()
export class SessionsRepository {
  constructor(@Inject(DB) private readonly db: Database) {}

  /** Starts a new family with its first token. */
  async start(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    client: ClientInfo;
  }): Promise<{ familyId: string }> {
    const familyId = randomUUID();
    await this.db.insert(authRefreshTokens).values({
      userId: input.userId,
      familyId,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      userAgent: input.client.userAgent,
      ip: input.client.ip,
    });
    return { familyId };
  }

  /**
   * Swaps the presented token for `next`. The row lock makes concurrent
   * refreshes with the same token serialize: the second one sees the token
   * already replaced and is treated as reuse.
   */
  async rotate(input: {
    presentedHash: string;
    nextHash: string;
    expiresAt: Date;
    client: ClientInfo;
  }): Promise<RotateResult> {
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(authRefreshTokens)
        .where(eq(authRefreshTokens.tokenHash, input.presentedHash))
        .for("update")
        .limit(1);
      if (!current) return { kind: "invalid" };

      if (current.revokedAt || current.replacedBy) {
        await tx
          .update(authRefreshTokens)
          .set({ revokedAt: sql`now()` })
          .where(
            and(
              eq(authRefreshTokens.familyId, current.familyId),
              isNull(authRefreshTokens.revokedAt),
            ),
          );
        // A token revoked by sign-out is simply dead; one replaced by a refresh is theft.
        return current.replacedBy
          ? { kind: "reused", userId: current.userId, familyId: current.familyId }
          : { kind: "invalid" };
      }
      if (current.expiresAt.getTime() <= Date.now()) return { kind: "invalid" };

      const [next] = await tx
        .insert(authRefreshTokens)
        .values({
          userId: current.userId,
          familyId: current.familyId,
          tokenHash: input.nextHash,
          expiresAt: input.expiresAt,
          userAgent: input.client.userAgent,
          ip: input.client.ip,
        })
        .returning({ id: authRefreshTokens.id });
      await tx
        .update(authRefreshTokens)
        .set({ revokedAt: sql`now()`, replacedBy: next!.id })
        .where(eq(authRefreshTokens.id, current.id));
      return { kind: "rotated", userId: current.userId, familyId: current.familyId };
    });
  }

  /** Revokes the family a token belongs to (sign-out). Unknown tokens are ignored. */
  async revokeFamilyOf(tokenHash: string): Promise<void> {
    await this.db.execute(sql`
      UPDATE ${authRefreshTokens} SET revoked_at = now()
      WHERE revoked_at IS NULL
        AND family_id = (SELECT family_id FROM ${authRefreshTokens} WHERE token_hash = ${tokenHash})`);
  }

  /** Signs the user out everywhere (after a password reset). */
  async revokeAllForUser(userId: string): Promise<void> {
    await this.db
      .update(authRefreshTokens)
      .set({ revokedAt: sql`now()` })
      .where(and(eq(authRefreshTokens.userId, userId), isNull(authRefreshTokens.revokedAt)));
  }
}
