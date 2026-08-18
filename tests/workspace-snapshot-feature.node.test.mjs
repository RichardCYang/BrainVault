import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("workspace snapshots stay owner-scoped, private, checksummed, and quota bounded", async () => {
  const [snapshotLib, snapshotRoute, env, migration, app] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/routes/snapshot.routes.ts"),
    read("src/config/env.ts"),
    read("migrations/055_workspace_snapshots.sql"),
    read("src/app.ts")
  ]);

  assert.match(snapshotRoute, /snapshotRouter\.use\(requireAuth\)/);
  assert.match(snapshotRoute, /dataExportRateLimit/);
  assert.match(snapshotRoute, /dataImportRateLimit/);
  assert.match(snapshotRoute, /dataImportConcurrencyLimit/);
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
  assert.match(env, /SNAPSHOT_STORAGE_MAX_MB/);
  assert.match(snapshotLib, /snapshotCount >= env\.SNAPSHOT_MAX_COUNT/);
  assert.match(snapshotLib, /snapshotBytes \+ inspection\.size > maxSnapshotStorageBytes/);

  assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /KEY idx_workspace_snapshots_user_created \(user_id, created_at, id\)/);
  assert.doesNotMatch(snapshotLib, /\.git(?:\/|\\)/);
  assert.doesNotMatch(snapshotRoute, /\.git(?:\/|\\)/);
});

test("snapshot creation and restore reuse the complete validated backup boundary", async () => {
  const [snapshotLib, dataTransfer] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/lib/data-transfer.ts")
  ]);

  assert.match(snapshotLib, /prepareUserDataBackup\(userId\)/);
  assert.match(snapshotLib, /writeUserDataBackup\(plan, stream\)/);
  assert.match(snapshotLib, /importUserDataBackup\(userId, filePath, authScope\)/);
  assert.match(snapshotLib, /readUserDataBackupManifest\(filePath\)/);
  assert.match(dataTransfer, /export async function readUserDataBackupManifest/);
  assert.match(dataTransfer, /validateManifestRelations\(manifest\)/);
  assert.match(dataTransfer, /Unexpected ZIP entry/);
  assert.match(dataTransfer, /The ZIP archive is missing one or more declared entries/);

  for (const preservedField of [
    "pageShares",
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

test("snapshot diff covers complete canonical backup state without returning unbounded bodies", async () => {
  const [snapshotLib, diffLib, dataTransfer] = await Promise.all([
    read("src/lib/workspace-snapshots.ts"),
    read("src/lib/workspace-snapshot-diff.ts"),
    read("src/lib/data-transfer.ts")
  ]);

  assert.match(snapshotLib, /diffWorkspaceManifests\(manifest, currentPlan\.manifest\)/);
  assert.match(snapshotLib, /prepareUserDataBackup\(userId\)/);
  assert.match(snapshotLib, /rm\(currentPlan\.operationRoot/);
  assert.match(dataTransfer, /assertWorkspaceCollaborationMaterialized/);

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
    assert.match(diffLib, new RegExp(`\"${field}\"`));
  }

  assert.match(diffLib, /summarizeTextDifference/);
  assert.match(diffLib, /createHash\("sha256"\)/);
  assert.match(diffLib, /const maxPageDetails = 200/);
  assert.match(diffLib, /const maxBlockDetails = 500/);
  assert.match(diffLib, /detailsTruncated/);
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
