// The global LLM gate against the local stack's Redis.
import { randomUUID } from "node:crypto";
import { localStack } from "@spatial/config";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { type ProviderLimits, RedisLlmGate } from "./gate";

const redis = new Redis(localStack().redisUrl);
afterAll(async () => {
  await redis.quit();
});

const unlimited: ProviderLimits = { permits: 100, rpm: 0, itpm: 0, otpm: 0 };

const gate = (claude: Partial<ProviderLimits>, acquireTimeoutMs = 5000) =>
  new RedisLlmGate(redis, {
    prefix: `test-${randomUUID()}`,
    limits: { claude: { ...unlimited, ...claude }, ollama: unlimited },
    acquireTimeoutMs,
  });

const noTokens = { inputTokens: 0, outputTokens: 0 };

describe("RedisLlmGate", () => {
  it("never lets more calls run at once than there are permits", async () => {
    const g = gate({ permits: 2 });
    let running = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        const lease = await g.acquire("claude", noTokens);
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 50));
        running--;
        await lease.release();
      }),
    );
    expect(peak).toBe(2);
  });

  it("makes a call wait until the token bucket can pay for it", async () => {
    // 6000 input tokens a minute = 100 a second; the first call drains it.
    const g = gate({ itpm: 6000 });
    const first = await g.acquire("claude", { inputTokens: 6000, outputTokens: 0 });
    await first.release({ inputTokens: 6000, outputTokens: 0 });
    const started = Date.now();
    const second = await g.acquire("claude", { inputTokens: 50, outputTokens: 0 });
    await second.release();
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  it("returns tokens a call reserved but didn't use", async () => {
    const g = gate({ itpm: 6000 });
    const lease = await g.acquire("claude", { inputTokens: 6000, outputTokens: 0 });
    await lease.release({ inputTokens: 100, outputTokens: 0 });
    const started = Date.now();
    await (await g.acquire("claude", { inputTokens: 5000, outputTokens: 0 })).release();
    expect(Date.now() - started).toBeLessThan(300);
  });

  it("gives up with a retryable capacity error instead of waiting forever", async () => {
    const g = gate({ rpm: 1 }, 300);
    await (await g.acquire("claude", noTokens)).release();
    await expect(g.acquire("claude", noTokens)).rejects.toMatchObject({
      code: "capacity",
      retryable: true,
    });
  });

  it("frees a permit when its lease expires, so a crashed holder can't block others", async () => {
    const g = new RedisLlmGate(redis, {
      prefix: `test-${randomUUID()}`,
      limits: { claude: { ...unlimited, permits: 1 }, ollama: unlimited },
      leaseMs: 200,
      acquireTimeoutMs: 2000,
    });
    await g.acquire("claude", noTokens); // never released
    const started = Date.now();
    await (await g.acquire("claude", noTokens)).release();
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
