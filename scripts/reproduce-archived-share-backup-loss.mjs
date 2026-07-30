import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRestorablePageShareTarget } from "../src/lib/page-share-integrity.ts";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const transferSource = readFileSync(path.join(projectRoot, "src/lib/data-transfer.ts"), "utf8")
  .replace(/\r\n/g, "\n");
const pageRouteSource = readFileSync(path.join(projectRoot, "src/routes/page.routes.ts"), "utf8")
  .replace(/\r\n/g, "\n");

const archivedOrdinaryPage = {
  id: "pag_archived_shared",
  is_collection: 0,
  is_archived: 1
};
const grant = {
  page_id: archivedOrdinaryPage.id,
  shared_username: "collaborator",
  permission: "EDIT"
};

// This is the pre-fix import rule that rejected the exact relationship the
// exporter could emit after a shared page was archived.
const vulnerableImporterAccepts = (page) => Boolean(
  page && !page.is_collection && !page.is_archived
);

const archiveMutation = pageRouteSource.slice(
  pageRouteSource.indexOf("if (updates.isArchived !== undefined)"),
  pageRouteSource.indexOf("pageRouter.delete(")
);
const exportShareQuery = transferSource.slice(
  transferSource.indexOf("const pageShares = await client.query<BackupPageShare>"),
  transferSource.indexOf("const snapshot = { account, pages, blocks, tags, pageTags, pageShares }")
);

const archiveRetainsGrant = !archiveMutation.includes("DELETE FROM page_shares");
const exportIncludesArchivedGrant = exportShareQuery.includes("WHERE p.owner_id = ?")
  && !exportShareQuery.includes("p.is_archived");
const oldImporterRejectsArchivedGrant = !vulnerableImporterAccepts(archivedOrdinaryPage);
const fixedImporterAcceptsArchivedGrant = isRestorablePageShareTarget(archivedOrdinaryPage);
const fixedImporterRejectsCollection = !isRestorablePageShareTarget({ is_collection: 1 });
const sharedPolicyUses = transferSource.match(/isRestorablePageShareTarget\(page\)/g)?.length ?? 0;

const result = {
  vulnerability: {
    archiveRetainsGrant,
    exportIncludesArchivedGrant,
    oldImporterRejectsArchivedGrant,
    selfExportedBackupRejected: archiveRetainsGrant
      && exportIncludesArchivedGrant
      && oldImporterRejectsArchivedGrant,
    recoveryFalseSuccessReproduced: archiveRetainsGrant
      && exportIncludesArchivedGrant
      && oldImporterRejectsArchivedGrant
  },
  fixed: {
    importerAcceptsRetainedArchivedGrant: fixedImporterAcceptsArchivedGrant,
    collectionShareStillRejected: fixedImporterRejectsCollection,
    currentAndLegacyRestoreUseSamePolicy: sharedPolicyUses >= 2,
    selfExportedBackupRoundTrips: archiveRetainsGrant
      && exportIncludesArchivedGrant
      && fixedImporterAcceptsArchivedGrant,
    recoveryFalseSuccessClosed: fixedImporterAcceptsArchivedGrant
      && fixedImporterRejectsCollection
      && sharedPolicyUses >= 2
  },
  sample: { page: archivedOrdinaryPage, grant }
};

assert.equal(result.vulnerability.recoveryFalseSuccessReproduced, true);
assert.equal(result.fixed.recoveryFalseSuccessClosed, true);
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
