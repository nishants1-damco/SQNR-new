// Progress events from the worker to open SSE streams (plan §9.6). One Redis
// subscriber per API process fans each scan's channel out to its streams, so
// a thousand open streams cost one connection, not a thousand.
import { appMetrics } from "@spatial/observability";
import { Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import type { ApiConfig } from "@spatial/config";
import { analysisEventsChannel } from "@spatial/contracts";
import { Redis } from "ioredis";
import { API_CONFIG } from "../config/config.module";

type Listener = (message: string) => void;

@Injectable()
export class AnalysisEventsHub implements OnApplicationShutdown {
  private subscriber: Redis | null = null;
  private readonly listeners = new Map<string, Set<Listener>>();
  private open = 0;

  constructor(@Inject(API_CONFIG) private readonly config: ApiConfig) {}

  private connection(): Redis {
    if (!this.subscriber) {
      // No key prefix: pub/sub channels aren't keys, and the worker publishes
      // on the queue Redis under QUEUE_PREFIX.
      this.subscriber = new Redis(this.config.queue.redisUrl, { maxRetriesPerRequest: 2 });
      this.subscriber.on("message", (channel: string, message: string) => {
        for (const listener of this.listeners.get(channel) ?? []) listener(message);
      });
    }
    return this.subscriber;
  }

  /** Reserves a stream slot; false when this replica is at its cap. */
  tryOpenStream(): boolean {
    if (this.open >= this.config.analysis.maxStreams) return false;
    this.open++;
    appMetrics().sseStreams.add(1);
    return true;
  }

  closeStream() {
    this.open = Math.max(0, this.open - 1);
    appMetrics().sseStreams.add(-1);
  }

  /** Listens to one scan's events; resolves once subscribed. Returns the unsubscribe function. */
  async listen(scanId: string, listener: Listener): Promise<() => Promise<void>> {
    const channel = analysisEventsChannel(this.config.queue.prefix, scanId);
    let set = this.listeners.get(channel);
    if (!set) {
      set = new Set();
      this.listeners.set(channel, set);
      await this.connection().subscribe(channel);
    }
    set.add(listener);
    return async () => {
      const current = this.listeners.get(channel);
      current?.delete(listener);
      if (current && current.size === 0) {
        this.listeners.delete(channel);
        await this.subscriber?.unsubscribe(channel).catch(() => undefined);
      }
    };
  }

  async onApplicationShutdown() {
    await this.subscriber?.quit().catch(() => this.subscriber?.disconnect());
  }
}
