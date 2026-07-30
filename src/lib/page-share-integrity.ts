export type PageShareRestoreTarget = {
  is_collection: number | boolean;
};

export type BackupPageShareIdentity = {
  shared_user_id?: string;
  shared_username: string;
};

export type BackupPageShareIdentityMode = "exact" | "legacy" | "mixed";

export type LegacyBackupPageShareIdentity = {
  page_id: string;
  shared_username: string;
  permission: "EDIT";
};

export type CurrentPageShareIdentity = {
  page_id: string;
  user_id: string;
  permission: "EDIT";
};

/**
 * A page share can be persisted for any ordinary page, including an archived
 * page. Archiving suspends live collaboration but does not delete the grant;
 * collections remain structurally non-shareable.
 */
export function isRestorablePageShareTarget(
  page: PageShareRestoreTarget | null | undefined
): boolean {
  return Boolean(page && !page.is_collection);
}

/**
 * Current backups bind each grant to both the collaborator's immutable account
 * ID and username. A mixture of ID-bound and username-only records is rejected
 * because it cannot have been emitted by one supported exporter generation.
 */
export function getBackupPageShareIdentityMode(
  shares: readonly BackupPageShareIdentity[]
): BackupPageShareIdentityMode {
  if (!shares.length) return "exact";
  const withId = shares.filter((share) => Boolean(share.shared_user_id)).length;
  if (withId === shares.length) return "exact";
  if (withId === 0) return "legacy";
  return "mixed";
}

/**
 * An ID-bound share is valid only when both stable identity fields still match.
 * A username match alone is not identity proof across independent servers.
 */
export function isExactBackupPageShareIdentityMatch(
  share: BackupPageShareIdentity,
  user: { id: string; username: string } | null | undefined
): boolean {
  return Boolean(
    share.shared_user_id
    && user
    && user.id === share.shared_user_id
    && user.username === share.shared_username
  );
}

/**
 * A username-only legacy grant is safe only when the destination workspace
 * already contains the exact page-to-account grant and that locked account
 * still has the username recorded in the backup. This prevents both cross-
 * server rebinding and same-server delete-and-reregister username reuse.
 */
export function isLegacyBackupPageShareCurrentMatch(
  backupShare: LegacyBackupPageShareIdentity,
  currentShare: CurrentPageShareIdentity | null | undefined,
  currentUser: { id: string; username: string } | null | undefined
): boolean {
  return Boolean(
    currentShare
    && currentUser
    && backupShare.page_id === currentShare.page_id
    && backupShare.permission === currentShare.permission
    && currentShare.user_id === currentUser.id
    && backupShare.shared_username === currentUser.username
  );
}
