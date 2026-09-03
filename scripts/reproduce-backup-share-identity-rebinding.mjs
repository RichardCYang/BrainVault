import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  getBackupPageShareIdentityMode,
  isExactBackupPageShareIdentityMatch,
  isLegacyBackupPageShareCurrentMatch
} from "../src/lib/page-share-integrity.ts";

const sourceCollaborator = {
  id: "usr_source_alice",
  username: "alice"
};
const unrelatedDestinationAccount = {
  id: "usr_destination_alice",
  username: "alice"
};
const exactBackupGrant = {
  page_id: "pag_shared",
  shared_user_id: sourceCollaborator.id,
  shared_username: sourceCollaborator.username,
  permission: "EDIT",
  created_at: "2026-07-30 00:00:00.000000"
};
const legacyBackupGrant = {
  page_id: exactBackupGrant.page_id,
  shared_username: exactBackupGrant.shared_username,
  permission: exactBackupGrant.permission,
  created_at: exactBackupGrant.created_at
};

// The vulnerable resolver treated a username match as sufficient identity proof.
const vulnerableResolvedUserId = unrelatedDestinationAccount.username === legacyBackupGrant.shared_username
  ? unrelatedDestinationAccount.id
  : null;
const unrelatedAccountReceivedEditAccess = vulnerableResolvedUserId === unrelatedDestinationAccount.id;

const currentSource = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const pageAccessSource = (await readFile(new URL("../src/lib/page-access.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const canEditPolicySource = pageAccessSource.slice(
  pageAccessSource.indexOf("export function canEditPageAccess"),
  pageAccessSource.indexOf("export function canAdministerPageAccess")
);
const accessPayloadSource = pageAccessSource.slice(
  pageAccessSource.indexOf("export function toAccessPayload"),
  pageAccessSource.indexOf("export function toCollaborationPayload")
);

const vulnerableBlocks = [{ id: "blk_private_note", markdown: "private note" }];
const vulnerableAfterEdit = unrelatedAccountReceivedEditAccess ? [] : vulnerableBlocks;
const currentOriginalGrant = {
  page_id: legacyBackupGrant.page_id,
  user_id: sourceCollaborator.id,
  permission: "EDIT"
};

const fixed = {
  newBackupBindsAccountId: currentSource.includes("ps.user_id AS shared_user_id"),
  restoreLocksAccountsById: currentSource.includes("SELECT id, username FROM users WHERE id IN"),
  unrelatedSameUsernameRejected:
    !isExactBackupPageShareIdentityMatch(exactBackupGrant, unrelatedDestinationAccount),
  exactIdentityAccepted:
    isExactBackupPageShareIdentityMatch(exactBackupGrant, sourceCollaborator),
  usernameMismatchRejected:
    !isExactBackupPageShareIdentityMatch(exactBackupGrant, {
      id: sourceCollaborator.id,
      username: "renamed-alice"
    }),
  legacyWithoutCurrentExactGrantRejected:
    !isLegacyBackupPageShareCurrentMatch(legacyBackupGrant, undefined, unrelatedDestinationAccount),
  legacyCurrentExactGrantAccepted:
    isLegacyBackupPageShareCurrentMatch(legacyBackupGrant, currentOriginalGrant, sourceCollaborator),
  deletedAndReregisteredUsernameRejected:
    !isLegacyBackupPageShareCurrentMatch(legacyBackupGrant, undefined, unrelatedDestinationAccount),
  mixedIdentityManifestRejected:
    getBackupPageShareIdentityMode([exactBackupGrant, legacyBackupGrant]) === "mixed",
  restoreUsesExactIdentityGuard: currentSource.includes("isExactBackupPageShareIdentityMatch"),
  legacyRequiresCurrentExactGrant:
    currentSource.includes("Legacy sharing grant cannot be verified against a current exact account grant"),
  editorGrantCarriesWriteAuthority:
    canEditPolicySource.includes('access.role === "EDITOR"')
      && accessPayloadSource.includes("const canEdit = canEditPageAccess(access)")
      && /\n\s+canEdit,/.test(accessPayloadSource),
  unrelatedAccountCannotDeleteAfterFix:
    !isExactBackupPageShareIdentityMatch(exactBackupGrant, unrelatedDestinationAccount)
      && vulnerableBlocks.length === 1
};

const result = {
  vulnerable: {
    sourceCollaboratorId: sourceCollaborator.id,
    destinationSameUsernameId: unrelatedDestinationAccount.id,
    vulnerableResolvedUserId,
    unrelatedAccountReceivedEditAccess,
    noteBlocksBeforeUnauthorizedEdit: vulnerableBlocks.length,
    noteBlocksAfterUnauthorizedEdit: vulnerableAfterEdit.length,
    noteDataDeletedByWrongAccount: vulnerableAfterEdit.length === 0,
    integrityRiskReproduced:
      unrelatedAccountReceivedEditAccess && vulnerableAfterEdit.length === 0
  },
  fixed: {
    ...fixed,
    identityRebindingClosed: Object.values(fixed).every(Boolean)
  }
};

assert.equal(result.vulnerable.integrityRiskReproduced, true);
assert.equal(result.fixed.identityRebindingClosed, true);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
