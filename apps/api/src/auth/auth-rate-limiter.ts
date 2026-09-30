// Brute-force protection for auth endpoints (plan §10.2, §11): fixed windows
// in Redis, keyed by client IP and by account. Account keys use a hash of the
// email so no addresses sit in Redis.
//
// Fails closed: if Redis is unreachable the request is refused with 503
// rather than letting unlimited password guesses through.
import { createHash } from "node:crypto";
import { Inject, Injectable, Logger } from "@nestjs/common";
import { Redis } from "ioredis";
import { ApiError } from "../common/api-error";
import { REDIS } from "../redis/redis.module";

export interface Limit {
  /** Requests allowed per window. */
  max: number;
  windowSeconds: number;
}

export const AUTH_LIMITS = {
  signInPerIp: { max: 10, windowSeconds: 60 },
  signInPerAccount: { max: 5, windowSeconds: 60 },
  signUpPerIp: { max: 10, windowSeconds: 3600 },
  refreshPerIp: { max: 60, windowSeconds: 60 },
  resetRequestPerAccount: { max: 3, windowSeconds: 3600 },
  resetRequestPerIp: { max: 20, windowSeconds: 3600 },
  tokenRedeemPerIp: { max: 30, windowSeconds: 600 },
  resendVerificationPerUser: { max: 3, windowSeconds: 3600 },
} as const satisfies Record<string, Limit>;

export const accountKey = (email: string) =>
  createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);

@Injectable()
export class AuthRateLimiter {
  private readonly logger = new Logger("AuthRateLimiter");

  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts one attempt against `bucket`/`key`; throws rate_limited once over the limit. */
  async hit(bucket: string, key: string, limit: Limit): Promise<void> {
    const redisKey = `ratelimit:auth:${bucket}:${key}`;
    let count: number;
    let ttl: number;
    try {
      const results = await this.redis
        .multi()
        .incr(redisKey)
        .expire(redisKey, limit.windowSeconds, "NX")
        .ttl(redisKey)
        .exec();
      if (!results || results.some(([err]) => err))
        throw new Error("rate-limit transaction failed");
      count = Number(results[0]?.[1]);
      ttl = Number(results[2]?.[1]);
    } catch (err) {
      this.logger.error({ err, bucket }, "rate limiter unavailable; refusing request");
      throw ApiError.unavailable();
    }
    if (count > limit.max) throw ApiError.rateLimited(Math.max(1, ttl));
  }
}
