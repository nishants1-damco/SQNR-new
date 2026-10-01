// Transactional outbox (migration plan §7.4). Write messages with the same
// transaction (or db handle) as the change they describe; the worker relays
// them to the job queue after commit.
import { context, propagation } from "@opentelemetry/api";
import { outbox } from "./schema";
import type { Database, Transaction } from "./client";

/** Payload key holding the W3C trace context of the request that wrote the message. */
export const OUTBOX_TRACE_KEY = "_trace";

export const OUTBOX_TOPICS = {
  /** Delete specific blob keys. */
  blobDelete: "blob.delete",
  /** Delete every blob under a prefix ending in "/". */
  blobDeletePrefix: "blob.delete_prefix",
  /** Check a newly uploaded frame and make its thumbnail. */
  mediaProcess: "media.process",
  /** Run a claimed analysis on Claude. */
  analysisCloud: "analysis.cloud",
  /** Run a claimed analysis on a local model (development only, D12). */
  analysisLocal: "analysis.local",
  /** Re-screen every frame of a scan for people and delete the matches. */
  privacyPurge: "privacy.purge",
} as const;

export interface AnalysisJob {
  analysisId: string;
  scanId: string;
  userId: string;
  provider: "claude" | "ollama";
  model: string;
}

export interface PrivacyPurgeJob {
  scanId: string;
  userId: string;
  requestedAt: string;
}

export type OutboxMessage =
  | { topic: typeof OUTBOX_TOPICS.blobDelete; payload: { keys: string[] } }
  | { topic: typeof OUTBOX_TOPICS.blobDeletePrefix; payload: { prefix: string } }
  | { topic: typeof OUTBOX_TOPICS.mediaProcess; payload: { photoId: string } }
  | { topic: typeof OUTBOX_TOPICS.analysisCloud; payload: AnalysisJob }
  | { topic: typeof OUTBOX_TOPICS.analysisLocal; payload: AnalysisJob }
  | { topic: typeof OUTBOX_TOPICS.privacyPurge; payload: PrivacyPurgeJob };

export type OutboxTopic = OutboxMessage["topic"];

export async function enqueueOutbox(
  db: Database | Transaction,
  ...messages: OutboxMessage[]
): Promise<void> {
  const rows = messages.filter(
    (m) => m.topic !== OUTBOX_TOPICS.blobDelete || m.payload.keys.length > 0,
  );
  if (rows.length === 0) return;
  // The request's trace context travels with the job, so the worker's span
  // continues the same trace (plan §16.1). Empty when not tracing.
  const trace: Record<string, string> = {};
  propagation.inject(context.active(), trace);
  const traced = Object.keys(trace).length ? { [OUTBOX_TRACE_KEY]: trace } : {};
  await db
    .insert(outbox)
    .values(rows.map((m) => ({ topic: m.topic, payload: { ...m.payload, ...traced } })));
}
