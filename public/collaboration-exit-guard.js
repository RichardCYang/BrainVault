const defaultSyncRequiredMessage = "Wait for real-time synchronization before leaving this document";

export function assertCollaborationExitSafe(session, message = defaultSyncRequiredMessage) {
  if (!session?.hasUnconfirmedLocalChanges || session.isReady) return;
  throw new Error(message);
}

export function shouldFlushCollaborationMaterialization(session) {
  return Boolean(session?.isReady && session.hasPendingChanges);
}
