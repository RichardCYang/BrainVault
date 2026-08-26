export const maxCollaborationUpdateBytes = 16 * 1024 * 1024;
export const maxCollaborationDocumentBytes = 16 * 1024 * 1024;

export type CollaborationWriteRejectionReason =
  | "room-stale"
  | "snapshot-base-mismatch"
  | "snapshot-changed-document"
  | "snapshot-too-early";

export type CollaborationWriteCheckpoint =
  | { accepted: true }
  | {
      accepted: false;
      currentUpdateId: number;
      reason: CollaborationWriteRejectionReason;
    };

/**
 * A process-local room may accept a write only when its in-memory Yjs state is
 * known to include the latest durable update. This is checked while the page
 * row is locked, so an overlapping application process cannot advance or
 * compact the log from a stale room.
 */
export function assessCollaborationWriteCheckpoint({
  durableUpdateId,
  roomUpdateId,
  snapshot,
  snapshotBaseUpdateId
}: {
  durableUpdateId: number;
  roomUpdateId: number;
  snapshot: boolean;
  snapshotBaseUpdateId: number | null;
}): CollaborationWriteCheckpoint {
  if (roomUpdateId !== durableUpdateId) {
    return {
      accepted: false,
      currentUpdateId: durableUpdateId,
      reason: "room-stale"
    };
  }
  if (snapshot && snapshotBaseUpdateId !== durableUpdateId) {
    return {
      accepted: false,
      currentUpdateId: durableUpdateId,
      reason: "snapshot-base-mismatch"
    };
  }
  return { accepted: true };
}

/**
 * Version 2 means that materialized_update_id was advanced only after the
 * server rebuilt the relational snapshot from the durable Yjs update log and
 * verified the complete persisted canonical state before checkpointing.
 *
 * Version 0 is reserved for builds that trusted a browser-supplied duplicate
 * snapshot. Version 1 is also intentionally stale: older server-authoritative
 * builds could advance the checkpoint after an incomplete/stale relational
 * write or after verifying only block IDs. Treating both versions as pending
 * forces one lossless rematerialization before destructive operations can
 * trust those historical checkpoints.
 */
export const currentCollaborationMaterializationVersion = 2;

export type CollaborationMaterializationState = {
  latestUpdateId: number;
  materializedUpdateId: number;
  materializationVersion: number;
};

export function needsCollaborationMaterialization(
  state: CollaborationMaterializationState
) {
  return state.latestUpdateId !== state.materializedUpdateId
    || (
      state.latestUpdateId > 0
      && state.materializationVersion !== currentCollaborationMaterializationVersion
    );
}
