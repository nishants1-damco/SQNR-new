// Access tokens are stateless for their 15 minutes (plan §10.1). When an
// account is deleted, its id goes on this Redis list for one token lifetime,
// and the JWT guard refuses tokens for it: without this, a token issued just
// before deletion would keep working (and its writes would hit missing rows).
import { Inject, Injectable, Logger } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import type { Redis } from "ioredis";
import { API_CONFIG } from "../config/config.module";
import { REDIS } from "../redis/redis.module";

const revokedKey = (userId: string) => `revoked:user:${userId}`;

@Injectable()
export class RevokedUsers {
  private readonly logger = new Logger("RevokedUsers");

  constructor(
    @Inject(REDIS) private readonly redis: Redis,
    @Inject(API_CONFIG) private readonly config: ApiConfig,
  ) {}

  async revoke(userId: string): Promise<void> {
    // A minute past the longest-lived token, for clock skew.
    const seconds = this.config.auth.accessTokenTtlSeconds + 60;
    await this.redis.set(revokedKey(userId), "1", "EX", seconds);
  }

  /** Fails open: in a Redis outage a deleted account's token lives out its 15 minutes. */
  async isRevoked(userId: string): Promise<boolean> {
    try {
      return (await this.redis.exists(revokedKey(userId))) === 1;
    } catch (err) {
      this.logger.warn({ err }, "can't check token revocation; allowing");
      return false;
    }
  }
}
