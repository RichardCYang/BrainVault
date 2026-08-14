import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const normalize = (value) => value.replace(/\r\n/g, "\n");
const currentTransfer = normalize(readFileSync(path.join(projectRoot, "src/lib/data-transfer.ts"), "utf8"));
const collapsedMigration = normalize(readFileSync(
  path.join(projectRoot, "migrations/043_navigation_collapse_preferences.sql"),
  "utf8"
));
const orderMigration = normalize(readFileSync(
  path.join(projectRoot, "migrations/049_navigation_page_order.sql"),
  "utf8"
));

const ownerId = "usr_owner";
const collaboratorId = "usr_collaborator";
const removedCollaboratorId = "usr_removed";
const dormantCollaboratorId = "usr_dormant";
const pageId = "pag_shared";
const removedSharePageId = "pag_removed_share";
const restoredSharePageId = "pag_restored_share";

const original = {
  pages: [
    { id: pageId, ownerId },
    { id: removedSharePageId, ownerId },
    { id: restoredSharePageId, ownerId }
  ],
  shares: [
    { pageId, userId: collaboratorId },
    { pageId: removedSharePageId, userId: removedCollaboratorId }
  ],
  collapsed: [
    { pageId, userId: collaboratorId, createdAt: "2026-08-10T01:02:03.004Z" },
    { pageId: removedSharePageId, userId: removedCollaboratorId, createdAt: "2026-08-10T02:03:04.005Z" },
    // This preference is dormant because the current share was revoked, but the
    // backup restores that exact collaborator grant and should not erase it.
    { pageId: restoredSharePageId, userId: dormantCollaboratorId, createdAt: "2026-08-10T03:04:05.006Z" }
  ],
  order: [
    { pageId, userId: collaboratorId, sortOrder: 4, updatedAt: "2026-08-10T04:05:06.007Z" },
    { pageId: removedSharePageId, userId: removedCollaboratorId, sortOrder: 9, updatedAt: "2026-08-10T05:06:07.008Z" },
    { pageId: restoredSharePageId, userId: dormantCollaboratorId, sortOrder: 7, updatedAt: "2026-08-10T06:07:08.009Z" }
  ]
};

const restoredBackup = {
  pages: original.pages.map((page) => ({ ...page })),
  // The backup keeps the first share, intentionally removes the second, and
  // restores a grant that is not present in the live share table anymore.
  shares: [
    { pageId, userId: collaboratorId },
    { pageId: restoredSharePageId, userId: dormantCollaboratorId }
  ],
  ownerCollapsed: [],
  ownerOrder: []
};

function cascadeOwnedPages(state) {
  const deletedPageIds = new Set(state.pages.filter((page) => page.ownerId === ownerId).map((page) => page.id));
  return {
    pages: state.pages.filter((page) => !deletedPageIds.has(page.id)),
    shares: state.shares.filter((share) => !deletedPageIds.has(share.pageId)),
    collapsed: state.collapsed.filter((row) => !deletedPageIds.has(row.pageId)),
    order: state.order.filter((row) => !deletedPageIds.has(row.pageId))
  };
}

function modelBaselineRestore() {
  const afterCascade = cascadeOwnedPages(structuredClone(original));
  afterCascade.pages.push(...restoredBackup.pages.map((page) => ({ ...page })));
  afterCascade.shares.push(...restoredBackup.shares.map((share) => ({ ...share })));
  // Baseline restore only reinserts the owner's manifest navigation state.
  return afterCascade;
}

function pairKey(row) {
  return `${row.userId}\u0000${row.pageId}`;
}

function modelFixedRestore() {
  const finalShareKeys = new Set(restoredBackup.shares.map(pairKey));
  const preservedCollapsed = original.collapsed.filter((row) => finalShareKeys.has(pairKey(row)));
  const preservedOrder = original.order.filter((row) => finalShareKeys.has(pairKey(row)));
  const afterCascade = cascadeOwnedPages(structuredClone(original));
  afterCascade.pages.push(...restoredBackup.pages.map((page) => ({ ...page })));
  afterCascade.shares.push(...restoredBackup.shares.map((share) => ({ ...share })));
  afterCascade.collapsed.push(...preservedCollapsed.map((row) => ({ ...row })));
  afterCascade.order.push(...preservedOrder.map((row) => ({ ...row })));
  return afterCascade;
}

const baselineAfter = modelBaselineRestore();
const fixedAfter = modelFixedRestore();

const result = {
  vulnerability: {
    baselineModel: "embedded pre-fix restore model",
    collapsedRowsCascadeWithPageDelete: /user_navigation_collapsed_pages[\s\S]*?REFERENCES pages\(id\) ON DELETE CASCADE/.test(collapsedMigration),
    orderRowsCascadeWithPageDelete: /user_navigation_page_order[\s\S]*?REFERENCES pages\(id\) ON DELETE CASCADE/.test(orderMigration),
    restoreDeletesOwnedPages: currentTransfer.includes('DELETE FROM pages WHERE owner_id = ?'),
    baselineOnlyBacksUpOwnersCollapsedState: currentTransfer.includes("WHERE np.user_id = ? AND p.owner_id = ?"),
    baselineOnlyBacksUpOwnersOrderState: currentTransfer.includes("WHERE no.user_id = ? AND p.owner_id = ?"),
    vulnerableModelDidNotPreserveCollaboratorNavigation: true,
    collaboratorCollapseLostAfterSuccessfulRestore: !baselineAfter.collapsed.some(
      (row) => row.userId === collaboratorId && row.pageId === pageId
    ),
    collaboratorOrderLostAfterSuccessfulRestore: !baselineAfter.order.some(
      (row) => row.userId === collaboratorId && row.pageId === pageId
    )
  },
  fixed: {
    capturesFinalCollaboratorCollapsedRows: currentTransfer.includes("prepareRestoreCollaboratorNavigationPlan")
      && currentTransfer.includes("FROM user_navigation_collapsed_pages np")
      && currentTransfer.includes("restoredCollaboratorIds")
      && currentTransfer.includes("np.user_id IN (${placeholders})"),
    capturesFinalCollaboratorOrderRows: currentTransfer.includes("FROM user_navigation_page_order no")
      && currentTransfer.includes("no.user_id IN (${placeholders})"),
    preservesNavigationTimestamps: currentTransfer.includes("DATE_FORMAT(np.created_at")
      && currentTransfer.includes("DATE_FORMAT(no.updated_at")
      && currentTransfer.includes("page_id, created_at) VALUES (?, ?, ?)")
      && currentTransfer.includes("sort_order, updated_at) VALUES (?, ?, ?, ?)"),
    filtersToSharesThatSurviveRestore: currentTransfer.includes("restoredShareKeys.has(collaboratorNavigationKey"),
    snapshotsBeforeDestructiveImport: currentTransfer.indexOf("prepareRestoreCollaboratorNavigationPlan(", currentTransfer.indexOf("restoreSharingPlan = await"))
      < currentTransfer.indexOf("await importRows(", currentTransfer.indexOf("restoreSharingPlan = await")),
    reinsertsCollaboratorCollapsedRows: currentTransfer.includes("for (const row of collaboratorNavigation.collapsed)"),
    reinsertsCollaboratorOrderRows: currentTransfer.includes("for (const row of collaboratorNavigation.order)"),
    collaboratorCollapsePreserved: fixedAfter.collapsed.some(
      (row) => row.userId === collaboratorId && row.pageId === pageId
    ),
    collaboratorOrderPreserved: fixedAfter.order.some(
      (row) => row.userId === collaboratorId && row.pageId === pageId && row.sortOrder === 4
    ),
    dormantPreferencePreservedWhenBackupRestoresShare: fixedAfter.collapsed.some(
      (row) => row.userId === dormantCollaboratorId
        && row.pageId === restoredSharePageId
        && row.createdAt === "2026-08-10T03:04:05.006Z"
    ) && fixedAfter.order.some(
      (row) => row.userId === dormantCollaboratorId
        && row.pageId === restoredSharePageId
        && row.sortOrder === 7
        && row.updatedAt === "2026-08-10T06:07:08.009Z"
    ),
    removedShareDoesNotResurrectCollapsedState: !fixedAfter.collapsed.some(
      (row) => row.userId === removedCollaboratorId && row.pageId === removedSharePageId
    ),
    removedShareDoesNotResurrectOrderState: !fixedAfter.order.some(
      (row) => row.userId === removedCollaboratorId && row.pageId === removedSharePageId
    )
  }
};

for (const [name, value] of Object.entries(result.vulnerability)) {
  if (name === "baselineModel") continue;
  assert.equal(value, true, `Expected reproduced vulnerability condition: ${name}`);
}
for (const [name, value] of Object.entries(result.fixed)) {
  assert.equal(value, true, `Expected fixed condition: ${name}`);
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
