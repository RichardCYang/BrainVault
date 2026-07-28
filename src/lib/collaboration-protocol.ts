export const maxCollaborationUpdateBytes = 16 * 1024 * 1024;
export const maxCollaborationDocumentBytes = 16 * 1024 * 1024;

/**
 * Version 1 means that materialized_update_id was advanced only after the
 * server rebuilt the relational snapshot from the durable Yjs update log.
 * Version 0 is deliberately reserved for rows written by older builds that
 * trusted a browser-supplied duplicate snapshot.
 */
export const currentCollaborationMaterializationVersion = 1;

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
