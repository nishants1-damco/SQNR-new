// Transactional outbox (migration plan §7.4). Write messages with the same
// transaction (or db handle) as the change they describe; the worker relays
// them to the job queue after commit.
import { outbox } from "./schema";
import type { Database, Transaction } from "./client";

export const OUTBOX_TOPICS = {
  /** Delete specific blob keys. */
  blobDelete: "blob.delete",
  /** Delete every blob under a prefix ending in "/". */
  blobDeletePrefix: "blob.delete_prefix",
  /** Check a newly uploaded frame and make its thumbnail. */
  mediaProcess: "media.process",
} as const;

export type OutboxMessage =
  | { topic: typeof OUTBOX_TOPICS.blobDelete; payload: { keys: string[] } }
  | { topic: typeof OUTBOX_TOPICS.blobDeletePrefix; payload: { prefix: string } }
  | { topic: typeof OUTBOX_TOPICS.mediaProcess; payload: { photoId: string } };

export type OutboxTopic = OutboxMessage["topic"];

export async function enqueueOutbox(
  db: Database | Transaction,
  ...messages: OutboxMessage[]
): Promise<void> {
  const rows = messages.filter(
    (m) => m.topic !== OUTBOX_TOPICS.blobDelete || m.payload.keys.length > 0,
  );
  if (rows.length === 0) return;
  await db.insert(outbox).values(rows.map((m) => ({ topic: m.topic, payload: m.payload })));
}
