import type { CollectionSharePermission } from "./page-access.js";

type CollectionShareAuditEvent = {
  action: "create" | "update" | "remove";
  actorId: string;
  ownerId: string;
  collectionId: string;
  targetId: string;
  previousPermission: CollectionSharePermission | null;
  permission: CollectionSharePermission | null;
  previousGeneration: string | null;
  generation: string | null;
  revokedCollectionGrants: number;
  revokedDirectGrants: number;
};

/** Emit only after a confirmed commit; operators retain stdout in their log sink. */
export function auditCollectionShareChange(event: CollectionShareAuditEvent) {
  // Explicit fields keep note contents, credentials and arbitrary request data
  // out of the log. JSON framing escapes newlines in any identifier.
  console.info(JSON.stringify({
    event: "collection_share_changed",
    timestamp: new Date().toISOString(),
    action: event.action,
    actorId: event.actorId,
    actorRole: event.actorId === event.ownerId ? "OWNER" : "ADMIN",
    ownerId: event.ownerId,
    collectionId: event.collectionId,
    targetId: event.targetId,
    previousPermission: event.previousPermission,
    permission: event.permission,
    previousGeneration: event.previousGeneration,
    generation: event.generation,
    revokedCollectionGrants: event.revokedCollectionGrants,
    revokedDirectGrants: event.revokedDirectGrants
  }));
}
