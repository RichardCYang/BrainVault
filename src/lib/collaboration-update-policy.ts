export const minCollaborationSnapshotHistoryEntries = 200;

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
