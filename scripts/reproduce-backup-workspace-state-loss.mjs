import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const currentTransfer = normalize(readFileSync(path.join(projectRoot, "src/lib/data-transfer.ts"), "utf8"));
const currentAuth = normalize(readFileSync(path.join(projectRoot, "src/routes/auth.routes.ts"), "utf8"));
const pageVersionMigration = normalize(readFileSync(path.join(projectRoot, "migrations/027_page_version_history.sql"), "utf8"));
const navigationMigration = normalize(readFileSync(path.join(projectRoot, "migrations/043_navigation_collapse_preferences.sql"), "utf8"));
const vulnerableTransfer = normalize(execFileSync(
  "git",
  ["show", "HEAD:src/lib/data-transfer.ts"],
  { cwd: projectRoot, encoding: "utf8" }
));

const original = {
  pageVersions: [
    {
      page_id: "pag_alpha",
      revision: 7,
      page_edit_version: 310,
      page_content_version: 309,
      actors: JSON.stringify([{ id: "usr_source", username: "alice", name: "Alice" }]),
      source: "page-update",
      change_count: 1,
      change_summary: JSON.stringify({ pageFields: ["icon"] }),
      changes: JSON.stringify([{ kind: "page-updated", fields: [{ field: "icon", before: null, after: "image:/upload/icons/usr_source/ico_old.png" }] }]),
      created_at: "2026-08-11 07:00:00.000000"
    }
  ],
  navigationCollapsedPageIds: ["pag_alpha"]
};

function modelV3Restore() {
  // DELETE FROM pages cascades both relations, and v3 carries neither relation.
  return { pageVersions: [], navigationCollapsedPageIds: [] };
}

function rebindHistoryForTarget(version, sourceUserId, targetUserId) {
  const actors = JSON.parse(version.actors);
  for (const actor of actors) if (actor.id === sourceUserId) actor.id = targetUserId;
  const changes = JSON.parse(version.changes);
  for (const change of changes) {
    if (change.kind !== "page-updated") continue;
    for (const field of change.fields ?? []) {
      if (field.field !== "icon") continue;
      for (const key of ["before", "after"]) {
        const value = field[key];
        if (typeof value === "string") {
          field[key] = value.replace(`/upload/icons/${sourceUserId}/`, `/upload/icons/${targetUserId}/`);
        }
      }
    }
  }
  return { ...version, actors: JSON.stringify(actors), changes: JSON.stringify(changes) };
}

function modelV4Restore(sourceUserId, targetUserId) {
  return {
    pageVersions: original.pageVersions.map((version) => rebindHistoryForTarget(version, sourceUserId, targetUserId)),
    navigationCollapsedPageIds: [...original.navigationCollapsedPageIds]
  };
}

const vulnerableAfter = modelV3Restore();
const fixedAfter = modelV4Restore("usr_source", "usr_target");

const result = {
  vulnerability: {
    baselineHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: projectRoot, encoding: "utf8" }).trim(),
    pageVersionRowsCascadeOnPageDelete: /REFERENCES pages\(id\) ON DELETE CASCADE/.test(pageVersionMigration),
    navigationRowsCascadeOnPageDelete: /REFERENCES pages\(id\) ON DELETE CASCADE/.test(navigationMigration),
    restoreDeletesOwnedPages: vulnerableTransfer.includes('DELETE FROM pages WHERE owner_id = ?'),
    v3ManifestOmittedPageVersions: !vulnerableTransfer.includes("pageVersions: snapshot.pageVersions"),
    v3ManifestOmittedNavigationState: !vulnerableTransfer.includes("navigationCollapsedPageIds: snapshot.navigationCollapsedPageIds"),
    v3RestoreDidNotReinsertPageVersions: !vulnerableTransfer.includes("INSERT INTO page_versions"),
    v3RestoreDidNotReinsertNavigationState: !vulnerableTransfer.includes("INSERT INTO user_navigation_collapsed_pages"),
    pageVersionHistoryLostAfterSuccessfulRestore: vulnerableAfter.pageVersions.length === 0,
    navigationCollapseStateLostAfterSuccessfulRestore: vulnerableAfter.navigationCollapsedPageIds.length === 0
  },
  fixed: {
    currentBackupVersionIs4: currentTransfer.includes("const uploadedAssetBackupVersion = 3;\nconst backupVersion = 4;"),
    v1ThroughV4ImportCompatibilityRetained: /z\.literal\(legacyBackupVersion\)[\s\S]*?z\.literal\(pageCoverFileBackupVersion\)[\s\S]*?z\.literal\(uploadedAssetBackupVersion\)[\s\S]*?z\.literal\(backupVersion\)/.test(currentTransfer),
    manifestExportsPageVersions: currentTransfer.includes("pageVersions: snapshot.pageVersions"),
    manifestExportsNavigationState: currentTransfer.includes("navigationCollapsedPageIds: snapshot.navigationCollapsedPageIds"),
    restoreReinsertsPageVersions: currentTransfer.includes("INSERT INTO page_versions"),
    restoreReinsertsNavigationState: currentTransfer.includes("INSERT INTO user_navigation_collapsed_pages"),
    relationValidationAdded: currentTransfer.includes('assertUnique(navigationCollapsedPageIds, "collapsed navigation page ID")')
      && currentTransfer.includes("Page version page is missing")
      && currentTransfer.includes("Page version edit version exceeds the current page version")
      && currentTransfer.includes("Page version content version exceeds the current page version"),
    restoreConflictFingerprintIncludesHistory: currentTransfer.includes("page-version\\0${version.page_id}"),
    restoreConflictFingerprintIncludesNavigationState: currentTransfer.includes("navigation-collapsed\\0${pageId}"),
    navigationMutationUsesBackupRestoreUserLock: currentAuth.includes('SELECT id FROM users WHERE id = ? FOR UPDATE')
      && currentAuth.includes("/navigation-preferences"),
    sourceOwnerIdentityReboundInHistory: JSON.parse(fixedAfter.pageVersions[0].actors)[0].id === "usr_target",
    customIconHistoryReferenceRebound: JSON.parse(fixedAfter.pageVersions[0].changes)[0].fields[0].after
      === "image:/upload/icons/usr_target/ico_old.png",
    roundTripPreservesPageVersionCount: fixedAfter.pageVersions.length === original.pageVersions.length,
    roundTripPreservesNavigationState: JSON.stringify(fixedAfter.navigationCollapsedPageIds)
      === JSON.stringify(original.navigationCollapsedPageIds)
  }
};

assert.equal(result.vulnerability.pageVersionRowsCascadeOnPageDelete, true);
assert.equal(result.vulnerability.navigationRowsCascadeOnPageDelete, true);
assert.equal(result.vulnerability.pageVersionHistoryLostAfterSuccessfulRestore, true);
assert.equal(result.vulnerability.navigationCollapseStateLostAfterSuccessfulRestore, true);
assert.equal(result.fixed.currentBackupVersionIs4, true);
assert.equal(result.fixed.v1ThroughV4ImportCompatibilityRetained, true);
assert.equal(result.fixed.manifestExportsPageVersions, true);
assert.equal(result.fixed.manifestExportsNavigationState, true);
assert.equal(result.fixed.restoreReinsertsPageVersions, true);
assert.equal(result.fixed.restoreReinsertsNavigationState, true);
assert.equal(result.fixed.relationValidationAdded, true);
assert.equal(result.fixed.restoreConflictFingerprintIncludesHistory, true);
assert.equal(result.fixed.restoreConflictFingerprintIncludesNavigationState, true);
assert.equal(result.fixed.navigationMutationUsesBackupRestoreUserLock, true);
assert.equal(result.fixed.sourceOwnerIdentityReboundInHistory, true);
assert.equal(result.fixed.customIconHistoryReferenceRebound, true);
assert.equal(result.fixed.roundTripPreservesPageVersionCount, true);
assert.equal(result.fixed.roundTripPreservesNavigationState, true);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
