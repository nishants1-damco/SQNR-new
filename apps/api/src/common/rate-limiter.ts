// A rate limiter in Redis (plan §11): GCRA, the generic cell rate algorithm.
// One key per bucket holds the "theoretical arrival time"; each request moves
// it forward by window/max, and a request is allowed while that stays within
// one window of now. The result is `max` requests per window with a smooth
// refill, instead of a fixed window that allows 2x at its boundary. One atomic
// script per request, on the server's clock.
import { Inject, Injectable } from "@nestjs/common";
import type { Redis } from "ioredis";
import { REDIS } from "../redis/redis.module";

export interface RateLimit {
  max: number;
  windowMs: number;
}

export interface RateDecision {
  allowed: boolean;
  /** Requests still allowed right now. */
  remaining: number;
  /** When refused: milliseconds until the next request would be allowed. */
  retryAfterMs: number;
}

// KEYS[1] bucket; ARGV: emission interval ms, window ms.
// Returns { allowed (0/1), remaining, retry-after ms }.
const GCRA = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local interval = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local tat = tonumber(redis.call('GET', KEYS[1]) or now)
if tat < now then tat = now end
local next_tat = tat + interval
local allow_at = next_tat - window
if allow_at > now then
  return { 0, 0, math.ceil(allow_at - now) }
end
redis.call('SET', KEYS[1], next_tat, 'PX', math.ceil(next_tat - now))
return { 1, math.floor((window - (next_tat - now)) / interval), 0 }`;

@Injectable()
export class RateLimiter {
  constructor(@Inject(REDIS) private readonly redis: Redis) {}

  /** Counts one request against `key`. Throws if Redis is unreachable; callers decide what that means. */
  async hit(key: string, limit: RateLimit): Promise<RateDecision> {
    const interval = limit.windowMs / limit.max;
    const [allowed, remaining, retryAfterMs] = (await this.redis.eval(
      GCRA,
      1,
      `ratelimit:${key}`,
      interval,
      limit.windowMs,
    )) as [number, number, number];
    return { allowed: allowed === 1, remaining, retryAfterMs };
  }
}
