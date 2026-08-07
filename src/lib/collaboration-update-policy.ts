export const minCollaborationSnapshotHistoryEntries = 200;

// Cooperative clients compact after 200 updates. The larger server-enforced
// ceiling remains a hard security boundary while avoiding frequent full-state
// rewrites when a malicious or obsolete client refuses to compact a large
// document. A retained log may contain one 16 MiB canonical state plus a
// bounded 16 MiB delta window.
export const maxCollaborationRetainedHistoryEntries = 4_096;
export const maxCollaborationRetainedHistoryBytes = 32 * 1024 * 1024;

// A bounded migration window lets the fixed server compact moderately oversized
// histories written by older builds without accepting an unbounded replay into
// process memory. Histories beyond this window fail closed before row payloads
// are loaded and require an operator-controlled recovery.
export const maxCollaborationHistoryReplayEntries = maxCollaborationRetainedHistoryEntries * 2;
export const maxCollaborationHistoryReplayBytes = maxCollaborationRetainedHistoryBytes * 2;

export type CollaborationUpdatePersistenceDecision =
  | { action: "persist" }
  | { action: "ignore"; reason: "no-document-change" }
  | {
      action: "reject";
      reason: "snapshot-changed-document" | "snapshot-too-early";
    };

/**
 * Yjs updates are idempotent. Do not persist or fan out a replay that leaves
 * the canonical document unchanged. A compaction snapshot is accepted only as
 * a state-equivalent replacement after enough history exists to justify it.
 */
export function assessCollaborationUpdatePersistence({
  snapshot,
  documentChanged,
  historyEntries
}: {
  snapshot: boolean;
  documentChanged: boolean;
  historyEntries: number;
}): CollaborationUpdatePersistenceDecision {
  if (!snapshot) {
    return documentChanged
      ? { action: "persist" }
      : { action: "ignore", reason: "no-document-change" };
  }
  if (documentChanged) {
    return { action: "reject", reason: "snapshot-changed-document" };
  }
  if (historyEntries < minCollaborationSnapshotHistoryEntries) {
    return { action: "reject", reason: "snapshot-too-early" };
  }
  return { action: "persist" };
}

/**
 * Client-requested snapshots remain an optimization, never a security
 * dependency. The server replaces the durable log with its own validated full
 * state whenever retaining another incremental update would cross either cap.
 */
export function shouldCompactCollaborationHistory({
  clientSnapshot,
  historyEntries,
  historyBytes,
  nextUpdateBytes
}: {
  clientSnapshot: boolean;
  historyEntries: number;
  historyBytes: number;
  nextUpdateBytes: number;
}) {
  if (clientSnapshot) return true;
  if (
    !Number.isSafeInteger(historyEntries)
    || historyEntries < 0
    || !Number.isSafeInteger(historyBytes)
    || historyBytes < 0
    || !Number.isSafeInteger(nextUpdateBytes)
    || nextUpdateBytes < 0
  ) return true;
  return historyEntries >= maxCollaborationRetainedHistoryEntries
    || nextUpdateBytes > maxCollaborationRetainedHistoryBytes - historyBytes;
}

export type CollaborationHistoryReplayAssessment =
  | { accepted: true; compact: boolean }
  | { accepted: false; reason: "entry-limit" | "byte-limit" | "invalid-metrics" };

/**
 * Inspect aggregate metadata before selecting BLOB rows. This bounds legacy
 * replay work and allows moderately oversized histories to be compacted once
 * under the same page lock that serializes collaboration writes.
 */
export function assessCollaborationHistoryReplay({
  historyEntries,
  historyBytes
}: {
  historyEntries: number;
  historyBytes: number;
}): CollaborationHistoryReplayAssessment {
  if (
    !Number.isSafeInteger(historyEntries)
    || historyEntries < 0
    || !Number.isSafeInteger(historyBytes)
    || historyBytes < 0
  ) {
    return { accepted: false, reason: "invalid-metrics" };
  }
  if (historyEntries > maxCollaborationHistoryReplayEntries) {
    return { accepted: false, reason: "entry-limit" };
  }
  if (historyBytes > maxCollaborationHistoryReplayBytes) {
    return { accepted: false, reason: "byte-limit" };
  }
  return {
    accepted: true,
    compact: historyEntries > maxCollaborationRetainedHistoryEntries
      || historyBytes > maxCollaborationRetainedHistoryBytes
  };
}
