// Global control of model traffic across every worker replica (plan §9.3,
// §9.7.6): a concurrency semaphore per provider, plus token buckets for
// requests, input tokens and output tokens per minute, all in Redis.
//
// Every call reserves its estimated tokens before it starts and settles the
// difference against the real usage afterwards. A 429 halves the refill rate
// for a minute, so replicas back off together instead of each rediscovering
// the limit.
import { randomUUID } from "node:crypto";
import type { Redis } from "ioredis";
import { LlmError } from "./errors";
import type { ProviderKind } from "./types";

export interface TokenReservation {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmLease {
  /** Give the permit back and settle the reservation against real usage. */
  release(actual?: TokenReservation): Promise<void>;
}

export interface LlmGate {
  acquire(provider: ProviderKind, reservation: TokenReservation): Promise<LlmLease>;
  /** The provider rate-limited us: slow every replica down for a while. */
  penalize(provider: ProviderKind): Promise<void>;
}

/** No limits: unit tests and scripts. */
export const openGate: LlmGate = {
  acquire: () => Promise.resolve({ release: () => Promise.resolve() }),
  penalize: () => Promise.resolve(),
};

export interface ProviderLimits {
  /** Calls in flight at once, across all replicas. */
  permits: number;
  /** Requests / input tokens / output tokens per minute; 0 = not limited. */
  rpm: number;
  itpm: number;
  otpm: number;
}

export interface RedisLlmGateOptions {
  /** Key namespace, e.g. the queue prefix. */
  prefix: string;
  limits: Record<ProviderKind, ProviderLimits>;
  /** Give up waiting for capacity after this long (the job retries later). */
  acquireTimeoutMs?: number;
  /** A permit expires if its holder dies without releasing it. Renewed while held. */
  leaseMs?: number;
  /** How long a 429 halves the refill rate. */
  penaltyMs?: number;
}

// Claims a permit if fewer than `limit` unexpired permits are held.
// KEYS[1] permits zset; ARGV: leaseMs, limit, token. Uses the server clock so
// replicas with skewed clocks agree.
const ACQUIRE_PERMIT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
if redis.call('ZCARD', KEYS[1]) < tonumber(ARGV[2]) then
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
  redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
  return 1
end
return 0`;

// Extends a held permit's expiry. KEYS[1] permits zset; ARGV: leaseMs, token.
const RENEW_PERMIT = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
return redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[1]), ARGV[2])`;

// Takes `cost` from every bucket, or from none. Returns 0 when granted, else
// the milliseconds until all buckets could pay. KEYS[1..n] buckets, KEYS[n+1]
// the penalty flag; ARGV[1] = n, then per bucket: capacity, refill per ms, cost.
const TAKE_TOKENS = `
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
local n = tonumber(ARGV[1])
local slow = redis.call('EXISTS', KEYS[n + 1]) == 1
local wait = 0
local levels = {}
for i = 1, n do
  local cap = tonumber(ARGV[2 + (i - 1) * 3])
  local rate = tonumber(ARGV[3 + (i - 1) * 3])
  local cost = math.min(tonumber(ARGV[4 + (i - 1) * 3]), cap)
  if slow then rate = rate / 2 end
  local state = redis.call('HMGET', KEYS[i], 'tokens', 'ts')
  local tokens = tonumber(state[1]) or cap
  local ts = tonumber(state[2]) or now
  tokens = math.min(cap, tokens + math.max(0, now - ts) * rate)
  if tokens < cost then
    wait = math.max(wait, math.ceil((cost - tokens) / rate))
  end
  levels[i] = { tokens, cost }
end
for i = 1, n do
  local tokens = levels[i][1]
  if wait == 0 then tokens = tokens - levels[i][2] end
  redis.call('HSET', KEYS[i], 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', KEYS[i], 120000)
end
return wait`;

// Adds `delta` to each bucket that still exists, never above its capacity.
// KEYS[1..n] buckets; ARGV: per bucket capacity, delta.
const SETTLE_TOKENS = `
for i = 1, #KEYS do
  if redis.call('EXISTS', KEYS[i]) == 1 then
    local tokens = tonumber(redis.call('HGET', KEYS[i], 'tokens')) or 0
    local cap = tonumber(ARGV[(i - 1) * 2 + 1])
    redis.call('HSET', KEYS[i], 'tokens', math.min(cap, tokens + tonumber(ARGV[(i - 1) * 2 + 2])))
  end
end
return 0`;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class RedisLlmGate implements LlmGate {
  private readonly acquireTimeoutMs: number;
  private readonly leaseMs: number;
  private readonly penaltyMs: number;

  constructor(
    private readonly redis: Redis,
    private readonly options: RedisLlmGateOptions,
  ) {
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? 10 * 60 * 1000;
    this.leaseMs = options.leaseMs ?? 15 * 60 * 1000;
    this.penaltyMs = options.penaltyMs ?? 60 * 1000;
  }

  /** Keys share a hash tag, so the scripts also work on a Redis cluster. */
  private key(provider: ProviderKind, name: string) {
    return `${this.options.prefix}:{llm:${provider}}:${name}`;
  }

  async acquire(provider: ProviderKind, reservation: TokenReservation): Promise<LlmLease> {
    const limits = this.options.limits[provider];
    const deadline = Date.now() + this.acquireTimeoutMs;
    const permits = this.key(provider, "permits");
    const token = randomUUID();

    // A permit first, so a call waiting for tokens holds its place in line.
    let backoff = 100;
    while (
      (await this.redis.eval(ACQUIRE_PERMIT, 1, permits, this.leaseMs, limits.permits, token)) !== 1
    ) {
      if (Date.now() > deadline) throw this.busy(provider);
      await sleep(backoff + Math.random() * backoff);
      backoff = Math.min(backoff * 2, 2000);
    }

    const renew = setInterval(() => {
      void this.redis.eval(RENEW_PERMIT, 1, permits, this.leaseMs, token).catch(() => undefined);
    }, this.leaseMs / 3);
    renew.unref();
    const giveBack = async () => {
      clearInterval(renew);
      await this.redis.zrem(permits, token).catch(() => undefined);
    };

    try {
      await this.takeTokens(provider, limits, reservation, deadline);
    } catch (err) {
      await giveBack();
      throw err;
    }

    let released = false;
    return {
      release: async (actual) => {
        if (released) return;
        released = true;
        await giveBack();
        if (actual) await this.settle(provider, limits, reservation, actual);
      },
    };
  }

  async penalize(provider: ProviderKind): Promise<void> {
    await this.redis.set(this.key(provider, "penalty"), "1", "PX", this.penaltyMs);
  }

  private buckets(provider: ProviderKind, limits: ProviderLimits, r: TokenReservation) {
    return [
      { name: "rpm", perMinute: limits.rpm, cost: 1 },
      { name: "itpm", perMinute: limits.itpm, cost: r.inputTokens },
      { name: "otpm", perMinute: limits.otpm, cost: r.outputTokens },
    ]
      .filter((b) => b.perMinute > 0)
      .map((b) => ({ ...b, key: this.key(provider, `bucket:${b.name}`) }));
  }

  private async takeTokens(
    provider: ProviderKind,
    limits: ProviderLimits,
    reservation: TokenReservation,
    deadline: number,
  ) {
    const buckets = this.buckets(provider, limits, reservation);
    if (buckets.length === 0) return;
    const keys = [...buckets.map((b) => b.key), this.key(provider, "penalty")];
    const args = buckets.flatMap((b) => [b.perMinute, b.perMinute / 60_000, b.cost]);
    for (;;) {
      const wait = Number(
        await this.redis.eval(TAKE_TOKENS, keys.length, ...keys, buckets.length, ...args),
      );
      if (wait === 0) return;
      if (Date.now() + wait > deadline) throw this.busy(provider);
      await sleep(Math.min(wait, 5000) + Math.random() * 250);
    }
  }

  /** Return over-reserved tokens, or take the shortfall (a bucket may go into debt). */
  private async settle(
    provider: ProviderKind,
    limits: ProviderLimits,
    reserved: TokenReservation,
    actual: TokenReservation,
  ) {
    const deltas: Record<string, number> = {
      itpm: reserved.inputTokens - actual.inputTokens,
      otpm: reserved.outputTokens - actual.outputTokens,
    };
    const buckets = this.buckets(provider, limits, reserved).filter((b) => deltas[b.name]);
    if (buckets.length === 0) return;
    await this.redis
      .eval(
        SETTLE_TOKENS,
        buckets.length,
        ...buckets.map((b) => b.key),
        ...buckets.flatMap((b) => [b.perMinute, deltas[b.name] ?? 0]),
      )
      .catch(() => undefined);
  }

  private busy(provider: ProviderKind) {
    return new LlmError("capacity", "The AI service is busy. The analysis will retry shortly.", {
      provider,
    });
  }
}
