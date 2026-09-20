import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workspace snapshots stay owner-scoped, private, checksummed, count bounded, and byte-unbounded", async () => {
  const [snapshotLib, snapshotRoute, env, migration, app, dataRoute] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/routes/snapshot.routes.ts"),
    read("src/config/env.ts"),
    read("migrations/055_workspace_snapshots.sql"),
    read("src/app.ts"),
    read("src/routes/data.routes.ts")
  ]);

  assert.match(snapshotRoute, /snapshotRouter\.use\(requireAuth\)/);
  assert.match(snapshotRoute, /dataExportRateLimit/);
  assert.match(snapshotRoute, /dataExportConcurrencyLimit/);
  assert.match(snapshotRoute, /dataImportRateLimit/);
  assert.match(snapshotRoute, /dataImportConcurrencyLimit/);
  assert.match(snapshotRoute, /beginDataImportProcessing/);
  assert.match(app, /app\.use\("\/api\/snapshots", snapshotRouter\)/);

  assert.match(snapshotLib, /\.workspace-snapshots/);
  assert.match(snapshotLib, /createHash\("sha256"\)\.update\(userId/);
  assert.match(snapshotLib, /mode: 0o700/);
  assert.match(snapshotLib, /mode: 0o600/);
  assert.match(snapshotLib, /inspection\.sha256 !== row\.archive_sha256/);
  assert.match(snapshotLib, /inspection\.size !== BigInt\(row\.archive_size\)/);
  assert.match(snapshotLib, /await rename\(temporaryPath, finalPath\)/);
  assert.match(snapshotLib, /await syncPath\(directory\)/);
  assert.match(snapshotLib, /SNAPSHOT_CREATE_OUTCOME_UNKNOWN/);
  assert.match(snapshotLib, /SNAPSHOT_DELETE_OUTCOME_UNKNOWN/);

  assert.match(env, /SNAPSHOT_MAX_COUNT/);
  assert.doesNotMatch(env, /SNAPSHOT_STORAGE_MAX_MB/);
  assert.match(snapshotLib, /snapshotCount >= env\.SNAPSHOT_MAX_COUNT/);
  assert.doesNotMatch(snapshotLib, /SNAPSHOT_STORAGE_LIMIT_REACHED/);
  assert.doesNotMatch(snapshotLib, /maxSnapshotStorageBytes/);
  assert.match(snapshotLib, /snapshotDataTransferOptions = Object\.freeze\(\{ enforceConfiguredSizeLimits: false \}\)/);
  assert.doesNotMatch(dataRoute, /enforceConfiguredSizeLimits\s*:\s*false/);

  assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /KEY idx_workspace_snapshots_user_created \(user_id, created_at, id\)/);
  assert.doesNotMatch(snapshotLib, /\.git(?:\/|\\)/);
  assert.doesNotMatch(snapshotRoute, /\.git(?:\/|\\)/);
});

test("snapshot creation, comparison, and restore reuse the validated backup boundary without configured byte ceilings", async () => {
  const [snapshotLib, dataTransfer] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/lib/data-transfer.ts")
  ]);

  assert.match(snapshotLib, /prepareUserDataBackup\(userId, snapshotDataTransferOptions\)/);
  assert.match(snapshotLib, /writeUserDataBackup\(plan, stream\)/);
  assert.match(snapshotLib, /importUserDataBackup\(userId, filePath, authScope, async \(client\) =>/);
  assert.match(snapshotLib, /}, snapshotDataTransferOptions\);/);
  assert.match(snapshotLib, /readUserDataBackupManifest\(filePath, snapshotDataTransferOptions\)/);
  assert.match(dataTransfer, /export type DataTransferOptions/);
  assert.match(dataTransfer, /enforceConfiguredSizeLimits\?: boolean/);
  assert.match(dataTransfer, /configuredSizeLimitsEnabled/);
  assert.match(dataTransfer, /export async function readUserDataBackupManifest/);
  assert.match(dataTransfer, /validateManifestRelations\(manifest\)/);
  assert.match(dataTransfer, /Unexpected ZIP entry/);
  assert.match(dataTransfer, /The ZIP archive is missing one or more declared entries/);
  assert.match(dataTransfer, /maxCentralDirectoryBytes: dataTransferResourceLimits\.maxCentralDirectoryBytes/);
  assert.match(dataTransfer, /maxEntries: dataTransferResourceLimits\.maxZipEntries/);

  for (const preservedField of [
    "pageShares",
    "pageComments",
    "pageVersions",
    "navigationCollapsedPageIds",
    "navigationPageOrder",
    "retainedAttachments",
    "pageCovers",
    "customIcons",
    "customIconLibraryRemovals"
  ]) {
    assert.match(dataTransfer, new RegExp(preservedField));
  }
});

test("snapshot diff covers complete canonical backup state while structural DoS bounds remain", async () => {
  const [snapshotLib, diffLib, dataTransfer, dataTransferLimits] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/lib/workspace-snapshot-diff.ts"),
    read("src/lib/data-transfer.ts"),
    read("src/lib/data-transfer-limits.ts")
  ]);

  assert.match(snapshotLib, /diffWorkspaceManifests\(manifest, currentPlan\.manifest\)/);
  assert.match(snapshotLib, /prepareUserDataBackup\(userId, snapshotDataTransferOptions\)/);
  assert.match(snapshotLib, /rm\(currentPlan\.operationRoot/);
  assert.match(dataTransfer, /assertWorkspaceCollaborationMaterialized/);
  assert.match(dataTransferLimits, /maxPages: 20_000/);
  assert.match(dataTransferLimits, /maxBlocks: 50_000/);
  assert.match(dataTransferLimits, /maxAttachments: 5_000/);

  for (const field of [
    "title",
    "icon",
    "cover",
    "coverPositionX",
    "coverPositionY",
    "archived",
    "collection",
    "parentPageId",
    "editVersion",
    "contentVersion",
    "tags",
    "tagState",
    "sharedWith",
    "sharingState",
    "commentCount",
    "commentState",
    "navigationCollapsed",
    "navigationOrder",
    "historyEntries",
    "historyData",
    "createdAt",
    "updatedAt",
    "type",
    "parentBlockId",
    "markdown",
    "htmlCache",
    "checked",
    "sortOrder",
    "metadata",
    "attachmentFile",
    "retainedAttachments",
    "customIcons",
    "customIconRemovals"
  ]) {
    assert.match(diffLib, new RegExp(`"${field}"`));
  }

  assert.match(diffLib, /summarizeTextDifference/);
  assert.match(diffLib, /createHash\("sha256"\)/);
  assert.doesNotMatch(diffLib, /maxPageDetails/);
  assert.doesNotMatch(diffLib, /maxBlockDetails/);
  assert.doesNotMatch(diffLib, /detailsTruncated/);
  assert.doesNotMatch(diffLib, /blockDetailsTruncated/);
});

test("snapshot settings UI fences browser-only drafts before create, diff, and restore", async () => {
  const [html, appJs, i18n, styles] = await Promise.all([
    read("public/index.html"),
    read("public/app.js"),
    read("public/i18n.js"),
    read("public/styles.css")
  ]);

  assert.match(html, /data-account-panel="snapshots"/);
  assert.match(html, /id="account-snapshot-create"/);
  assert.match(html, /id="account-snapshot-list"/);
  assert.match(appJs, /withWorkspacePersistenceTransition\("snapshot-create"/);
  assert.match(appJs, /withWorkspacePersistenceTransition\("snapshot-diff"/);
  assert.match(appJs, /withWorkspacePersistenceTransition\("snapshot-restore"/);
  assert.ok((appJs.match(/assertNoPendingLocalPageDraftsForPages\(ownedPageIds/g) ?? []).length >= 3);
  assert.ok((appJs.match(/assertNoPendingLocalCollaborationRecoveryForPages\(ownedPageIds/g) ?? []).length >= 3);
  assert.match(appJs, /data-snapshot-action/);
  assert.match(appJs, /snapshot\.integrity !== "ok"/);
  assert.match(appJs, /accountDataOperationGuard/);
  assert.match(i18n, /snapshotAccountTranslationAdditions/);
  assert.match(styles, /\.account-snapshot-diff/);
});
