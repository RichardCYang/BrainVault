import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";
import { createPageDraftStore } from "../public/draft-store.js";
import { translationCatalogs } from "../public/i18n.js";
import { createPageTransitionLock } from "../public/page-transition-lock.js";
import { inspectStorageKeys } from "../public/storage-snapshot.js";
import {
  CollaborationRecoveryWriteError,
  commitPreparedCollaborationMutation
} from "../public/collaboration-durability.js";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  const endIndex = source.indexOf(end, startIndex);
  assert(startIndex >= 0, `Missing source marker: ${start}`);
  assert(endIndex > startIndex, `Missing source marker after ${start}: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertBefore(source, guard, mutation, label) {
  const guardIndex = source.indexOf(guard);
  const mutationIndex = source.indexOf(mutation);
  assert(guardIndex >= 0, `${label}: missing guard ${guard}`);
  assert(mutationIndex >= 0, `${label}: missing mutation ${mutation}`);
  assert(guardIndex < mutationIndex, `${label}: guard must run before the mutation`);
}

class MemoryStorage {
  values = new Map();
  shiftOnNextKey = false;
  failWrites = false;

  get length() {
    return this.values.size;
  }

  key(index) {
    const key = [...this.values.keys()][index] ?? null;
    if (this.shiftOnNextKey && index === 0 && key) {
      this.shiftOnNextKey = false;
      this.values.delete(key);
    }
    return key;
  }

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    if (this.failWrites) throw new Error("simulated storage write failure");
    this.values.set(key, value);
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

class MemoryLockManager {
  held = new Set();

  async request(name, options, callback) {
    if (options?.ifAvailable && this.held.has(name)) return callback(null);
    this.held.add(name);
    try {
      return await callback({ name, mode: options?.mode ?? "exclusive" });
    } finally {
      this.held.delete(name);
    }
  }
}

async function acquireTransitionLease(lock, pageId, kind, exclusiveId = pageId) {
  const result = await lock.runExclusive([pageId, exclusiveId], async () =>
    lock.acquire(pageId, kind, exclusiveId)
  );
  assert(result.acquired && result.value, `Could not acquire transition lease for ${pageId}`);
  return result.value;
}

class RepeatedShiftingStorage extends MemoryStorage {
  shiftsRemaining = 0;

  key(index) {
    const keys = [...this.values.keys()];
    const key = keys[index] ?? null;
    if (this.shiftsRemaining > 0 && keys.length > 1 && index === keys.length - 2) {
      this.values.delete(keys[0]);
      this.shiftsRemaining -= 1;
    }
    return key;
  }
}

class AlternatingDelimiterCollisionStorage {
  pass = -1;
  lengthReadInPass = 0;
  currentKeys = [];

  get length() {
    if (this.lengthReadInPass === 0) {
      this.pass += 1;
      this.currentKeys = this.pass % 2 === 0
        ? ["draft\u0000survivor"]
        : ["draft", "survivor"];
    }
    const length = this.currentKeys.length;
    this.lengthReadInPass = (this.lengthReadInPass + 1) % 3;
    return length;
  }

  key(index) {
    return this.currentKeys[index] ?? null;
  }
}

function oldThreePassForwardSnapshot(storage) {
  const keys = new Set();
  for (let pass = 0; pass < 3; pass += 1) {
    const length = storage.length;
    for (let index = 0; index < length; index += 1) {
      const key = storage.key(index);
      if (key) keys.add(key);
    }
  }
  return [...keys];
}

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const collaborationClientSource = readFileSync(
  new URL("../public/collaboration.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const attachmentReconcileSource = readFileSync(
  new URL("../public/collaboration-attachment-reconcile.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const transitionLockSource = readFileSync(
  new URL("../public/page-transition-lock.js", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const collaborationRouteSource = readFileSync(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const blockRouteSource = readFileSync(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const dataRouteSource = readFileSync(
  new URL("../src/routes/data.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const structuredMetadataIntegritySource = readFileSync(
  new URL("../src/lib/structured-metadata-integrity.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const attachmentMetadataIntegritySource = readFileSync(
  new URL("../src/lib/attachment-metadata-integrity.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const databaseSource = readFileSync(
  new URL("../src/lib/database.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const dbConnectionSource = readFileSync(
  new URL("../src/lib/db.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const schemaSource = readFileSync(
  new URL("../src/lib/schema.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const blockOrderIntegritySource = readFileSync(
  new URL("../src/lib/block-order-integrity.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const collaborationServerSource = readFileSync(
  new URL("../src/lib/collaboration-server.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const collaborationBootstrapSource = readFileSync(
  new URL("../src/lib/collaboration-bootstrap.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const pageRouteSource = readFileSync(
  new URL("../src/routes/page.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const dataTransferSource = readFileSync(
  new URL("../src/lib/data-transfer.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const zipSource = readFileSync(
  new URL("../src/lib/zip.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const collaborationProtocolSource = readFileSync(
  new URL("../src/lib/collaboration-protocol.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const materializationMigrationSource = readFileSync(
  new URL("../migrations/022_server_authoritative_collaboration_materialization.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const baselineSchemaSource = readFileSync(
  new URL("../migrations/001_init.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const blockParentIntegrityMigrationSource = readFileSync(
  new URL("../migrations/023_blocks_parent_page_integrity.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

const pageCreateMutationMigrationSource = readFileSync(
  new URL("../migrations/036_page_create_mutation_receipts.sql", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

assert(
  blockOrderIntegritySource.includes("max: 2_147_483_647")
    && blockRouteSource.includes(".max(blockSortOrderLimits.max)")
    && blockRouteSource.includes("getNextBlockSortOrder(lastBlock?.sort_order)")
    && dataTransferSource.includes(".max(blockSortOrderLimits.max)"),
  "A direct write, automatic append, or backup restore can exceed the blocks.sort_order INT range"
);
assert(
  dbConnectionSource.includes("initSql: strictTransactionalSqlMode")
    && dbConnectionSource.includes("STRICT_TRANS_TABLES"),
  "Database sessions can still inherit a permissive SQL mode that silently coerces invalid writes"
);
assert(
  dbConnectionSource.includes("executeText(sql: string): Promise<void>")
    && dbConnectionSource.includes("await target.query(sql);")
    && schemaSource.includes("await client.executeText(statement);")
    && !schemaSource.includes("await client.execute(statement);"),
  "Migration SQL can still nest SQL-level PREPARE inside the connector prepared-statement protocol"
);
assert(
  zipSource.includes('createHash("sha256")')
    && zipSource.includes("sourceCrc32 = updateCrc32(sourceCrc32, data)")
    && zipSource.includes("ZIP source checksum changed while exporting")
    && zipSource.includes("ZIP source SHA-256 changed while exporting")
    && dataTransferSource.includes("sha256: item.inspection.sha256"),
  "Backup ZIP creation can still trust stale pre-stream attachment checksums"
);

assert(
  baselineSchemaSource.includes("CREATE TABLE IF NOT EXISTS page_create_mutations")
    && pageCreateMutationMigrationSource.includes("PRIMARY KEY (owner_id, mutation_id)")
    && pageCreateMutationMigrationSource.includes("FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE")
    && !pageCreateMutationMigrationSource.includes("FOREIGN KEY (page_id)")
    && pageRouteSource.includes("createMutationRequestHash(creation)")
    && pageRouteSource.includes("INSERT INTO page_create_mutations")
    && pageRouteSource.includes("assessPageCreateMutationReceipt(receipt, mutationHash)")
    && pageRouteSource.indexOf("INSERT INTO page_create_mutations") < pageRouteSource.indexOf("INSERT INTO pages"),
  "Page creation can still duplicate a committed page after an ambiguous POST retry"
);

assert(
  baselineSchemaSource.includes("CONSTRAINT uq_blocks_id_page UNIQUE (id, page_id)")
    && baselineSchemaSource.includes(
      "CONSTRAINT fk_blocks_parent_page FOREIGN KEY (parent_block_id, page_id) REFERENCES blocks(id, page_id) ON DELETE CASCADE"
    )
    && !baselineSchemaSource.includes(
      "FOREIGN KEY (parent_block_id) REFERENCES blocks(id) ON DELETE CASCADE"
    )
    && blockParentIntegrityMigrationSource.indexOf("ADD CONSTRAINT fk_blocks_parent_page")
      < blockParentIntegrityMigrationSource.indexOf("DROP FOREIGN KEY fk_blocks_parent")
    && blockParentIntegrityMigrationSource.includes("information_schema.TABLE_CONSTRAINTS"),
  "A corrupted cross-page block parent can still cascade-delete unrelated page data"
);

const crossPageParentReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-cross-page-parent-cascade-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  crossPageParentReproduction.vulnerability.permanentCrossPageLossReproduced
    && crossPageParentReproduction.fixed.crossPageParentRejected
    && crossPageParentReproduction.fixed.validSamePageCascadePreserved
    && crossPageParentReproduction.fixed.permanentCrossPageLossClosed,
  "The cross-page parent cascade reproduction did not prove both vulnerable and fixed states"
);

const backupStreamIntegrityReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-backup-stream-integrity-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  backupStreamIntegrityReproduction.vulnerable.unusableBackupFalseSuccessReproduced
    && backupStreamIntegrityReproduction.fixed.streamTimeCrc32Verified
    && backupStreamIntegrityReproduction.fixed.streamTimeSha256Verified
    && backupStreamIntegrityReproduction.fixed.writerRejectedBeforeCentralDirectoryFinalization
    && backupStreamIntegrityReproduction.fixed.unusableBackupFalseSuccessClosed,
  "The backup stream-integrity reproduction did not prove both vulnerable and fixed states"
);

assert(
  zipSource.includes("export function calculateZipArchiveSize")
    && dataTransferSource.includes("const archiveSize = calculateZipArchiveSize")
    && dataTransferSource.includes("attachmentFiles")
    && dataTransferSource.includes("pageCoverFiles")
    && dataTransferSource.includes("archiveSize")
    && dataTransferSource.includes("operationRoot")
    && dataTransferSource.includes("...pageCoverFiles.map")
    && dataRouteSource.includes('res.setHeader("Content-Length", plan.archiveSize.toString())')
    && dataRouteSource.includes('res.setHeader("Cache-Control", "private, no-store, no-transform")')
    && dataRouteSource.includes("res.strictContentLength = true")
    && client.includes('const expectedLength = response.headers.get("content-length")')
    && client.includes("BigInt(blob.size) !== BigInt(expectedLength)"),
  "Backup export can still report success without end-to-end archive-length verification"
);

const backupTransportTruncationReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-backup-transport-truncation.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  backupTransportTruncationReproduction.vulnerable.truncatedBytesAcceptedAsComplete
    && backupTransportTruncationReproduction.vulnerable.unusableBackupFalseSuccessReproduced
    && backupTransportTruncationReproduction.fixed.exactArchiveLengthCalculated
    && backupTransportTruncationReproduction.fixed.truncatedTransferRejected
    && backupTransportTruncationReproduction.fixed.unusableBackupFalseSuccessClosed,
  "The backup transport-truncation reproduction did not prove both vulnerable and fixed states"
);

assert(
  dataTransferSource.includes("ps.user_id AS shared_user_id")
    && dataTransferSource.includes("u.username AS shared_username")
    && dataTransferSource.includes("pageShares: snapshot.pageShares")
    && dataTransferSource.includes("SELECT id, username FROM users WHERE id IN")
    && dataTransferSource.includes("isExactBackupPageShareIdentityMatch")
    && dataTransferSource.includes("isLegacyBackupPageShareCurrentMatch")
    && dataTransferSource.includes("Legacy sharing grant cannot be verified against a current exact account grant")
    && dataTransferSource.includes("The backup mixes ID-bound and legacy username-only sharing grants")
    && dataTransferSource.includes("INSERT INTO page_shares")
    && dataTransferSource.includes('mode: "legacy-preserved"')
    && dataRouteSource.includes("sharing: result.sharing")
    && client.includes("shares: formatNumber(counts.shares ?? 0)"),
  "Complete backup/restore can still erase shares or rebind them to an unrelated same-named account"
);

const backupShareLossReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-backup-share-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  backupShareLossReproduction.vulnerability.permanentSharingLossReproduced
    && backupShareLossReproduction.fixed.manifestExportsPageShares
    && backupShareLossReproduction.fixed.restoreReinsertsPageShares
    && backupShareLossReproduction.fixed.legacyManifestPreservesCurrentShares
    && backupShareLossReproduction.fixed.permanentSharingLossClosed,
  "The backup page-share loss reproduction did not prove both vulnerable and fixed states"
);

const backupShareIdentityReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-backup-share-identity-rebinding.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  backupShareIdentityReproduction.vulnerable.noteDataDeletedByWrongAccount
    && backupShareIdentityReproduction.vulnerable.integrityRiskReproduced
    && backupShareIdentityReproduction.fixed.newBackupBindsAccountId
    && backupShareIdentityReproduction.fixed.restoreLocksAccountsById
    && backupShareIdentityReproduction.fixed.unrelatedSameUsernameRejected
    && backupShareIdentityReproduction.fixed.exactIdentityAccepted
    && backupShareIdentityReproduction.fixed.legacyWithoutCurrentExactGrantRejected
    && backupShareIdentityReproduction.fixed.legacyCurrentExactGrantAccepted
    && backupShareIdentityReproduction.fixed.deletedAndReregisteredUsernameRejected
    && backupShareIdentityReproduction.fixed.mixedIdentityManifestRejected
    && backupShareIdentityReproduction.fixed.legacyRequiresCurrentExactGrant
    && backupShareIdentityReproduction.fixed.editorGrantCarriesWriteAuthority
    && backupShareIdentityReproduction.fixed.unrelatedAccountCannotDeleteAfterFix
    && backupShareIdentityReproduction.fixed.identityRebindingClosed,
  "The backup share identity-rebinding reproduction did not prove both vulnerable and fixed states"
);

assert(
  dataTransferSource.includes("isRestorablePageShareTarget")
    && dataTransferSource.includes('from "./page-share-integrity.js";')
    && dataTransferSource.includes("if (!isRestorablePageShareTarget(page))")
    && dataTransferSource.includes("return isRestorablePageShareTarget(page);")
    && !dataTransferSource.includes("page.is_collection || page.is_archived")
    && !dataTransferSource.includes("!page.is_collection && !page.is_archived"),
  "A backup exported after archiving a shared page can still reject its own retained grant during restore"
);

const archivedShareBackupLossReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-archived-share-backup-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  archivedShareBackupLossReproduction.vulnerability.recoveryFalseSuccessReproduced
    && archivedShareBackupLossReproduction.fixed.importerAcceptsRetainedArchivedGrant
    && archivedShareBackupLossReproduction.fixed.collectionShareStillRejected
    && archivedShareBackupLossReproduction.fixed.currentAndLegacyRestoreUseSamePolicy
    && archivedShareBackupLossReproduction.fixed.recoveryFalseSuccessClosed,
  "The archived-share backup reproduction did not prove both vulnerable and fixed states"
);

const backupMetadataLossReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-backup-metadata-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  backupMetadataLossReproduction.vulnerability.permanentStructuredDataLossReproduced
    && backupMetadataLossReproduction.fixed.rejectedBeforeRestoreDatabaseWork
    && backupMetadataLossReproduction.fixed.lossClosed,
  "The backup structured-metadata loss reproduction did not prove both vulnerable and fixed states"
);

const backupAttachmentMetadataLossReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-backup-attachment-metadata-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  backupAttachmentMetadataLossReproduction.vulnerability.effectiveDataLossReproduced
    && backupAttachmentMetadataLossReproduction.fixed.malformedMetadataRejectedBeforeDatabaseWork
    && backupAttachmentMetadataLossReproduction.fixed.metadataFileSizeMismatchRejected
    && backupAttachmentMetadataLossReproduction.fixed.corruptExistingAttachmentCannotBeExportedAsHealthyBackup
    && backupAttachmentMetadataLossReproduction.fixed.failClosed,
  "The backup attachment-metadata loss reproduction did not prove both vulnerable and fixed states"
);
assert(
  attachmentMetadataIntegritySource.includes("assertLosslessAttachmentMetadata")
    && attachmentMetadataIntegritySource.includes("does not match the attachment file byte count")
    && dataTransferSource.includes("assertLosslessAttachmentMetadata(block.metadata, attachment.size)")
    && dataTransferSource.includes("assertLosslessAttachmentMetadata(block.metadata, inspection.size)")
    && dataTransferSource.indexOf("assertLosslessAttachmentMetadata(block.metadata, attachment.size)")
      < dataTransferSource.indexOf("await assertNoForeignIdConflicts(userId, manifest)"),
  "Backup restore or export can still accept attachment metadata that makes stored bytes unreachable"
);

const blockOrderReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-block-sort-order-overflow-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  blockOrderReproduction.vulnerability.silentOrderingLossReproduced
    && blockOrderReproduction.fixedBehavior.directApiRejectsOutOfRangeBeforeSql
    && blockOrderReproduction.fixedBehavior.backupRestoreRejectsOutOfRangeBeforeSql
    && blockOrderReproduction.fixedBehavior.automaticAppendFailsClosedAtIntMax
    && blockOrderReproduction.fixedBehavior.pooledConnectionsForceStrictTransactionalWrites
    && blockOrderReproduction.fixedBehavior.silentOrderingLossClosed,
  "The block sort-order overflow reproduction did not prove both vulnerable and fixed states"
);

assert(
  dataTransferSource.includes("assertLosslessBackupBlockMetadata(block)")
    && dataTransferSource.indexOf("validateManifestRelations(manifest)")
      < dataTransferSource.indexOf("await assertNoForeignIdConflicts(userId, manifest)"),
  "Backup restore can accept structured metadata that the editor will silently truncate"
);

const structuredSaveSources = [blockRouteSource, collaborationRouteSource];
for (const source of structuredSaveSources) {
  assert(
    source.includes("assertLosslessStructuredMetadata")
      && source.includes("summarizeBookmarkData(getBookmarkData(metadata))")
      && source.includes("summarizeAiChatData(getAiChatData(metadata))"),
    "Structured block saves are missing the lossless pre-write guard or source-preserving derivation"
  );
  assert(
    !source.includes("normalizeBookmarkMetadata(metadata)")
      && !source.includes("normalizeAiChatMetadata(metadata)"),
    "A structured block save can still replace authoritative metadata with a truncating projection"
  );
}
assert(
  structuredMetadataIntegritySource.includes("return root;")
    && blockRouteSource.includes("return validated === undefined ? metadata : validated")
    && collaborationRouteSource.includes("return validated === undefined ? metadata : validated"),
  "Structured JSON metadata can be double-encoded instead of serialized exactly once"
);
assert(
  blockRouteSource.includes('if (body.metadata !== undefined) {\n        fields.push("metadata = ?")')
    && !blockRouteSource.includes('body.metadata !== undefined || (contentChanged && (nextType === "BOOKMARK" || nextType === "AI_CHAT"))'),
  "A direct content update can rewrite unchanged JSON metadata through a second serialization"
);
assert(
  structuredMetadataIntegritySource.includes("answerLength: 12_000")
    && structuredMetadataIntegritySource.includes("rows: 50")
    && structuredMetadataIntegritySource.includes("columns: 12")
    && structuredMetadataIntegritySource.includes("rows: 200")
    && structuredMetadataIntegritySource.includes("items: 50"),
  "Structured metadata integrity limits are missing or incomplete"
);
assert(
  databaseSource.includes("const fallbackViews = fallback.views.map")
    && databaseSource.includes("propertyById.has(propertyId)")
    && databaseSource.includes("const normalizedViews = views.length ? views : fallbackViews"),
  "Database fallback views can retain references to properties that do not exist"
);
const directStructuredCreate = section(
  blockRouteSource,
  'blockRouter.post("/pages/:pageId/blocks"',
  'blockRouter.patch("/blocks/:blockId"'
);
assertBefore(
  directStructuredCreate,
  "assertLosslessStructuredMetadata(body.type, body.metadata)",
  "INSERT INTO blocks",
  "direct structured block create"
);
const collaborationSnapshotStart = collaborationRouteSource.indexOf(
  '"/pages/:pageId/collaboration/snapshot"'
);
assert(collaborationSnapshotStart >= 0, "Missing collaboration snapshot route");
const collaborationSnapshotSource = collaborationRouteSource.slice(collaborationSnapshotStart);
assertBefore(
  collaborationSnapshotSource,
  "assertLosslessStructuredMetadata(block.type, block.metadata)",
  "DELETE FROM blocks",
  "collaboration structured materialization"
);

assert(
  collaborationRouteSource.includes("materializeCollaborationUpdates")
    && collaborationRouteSource.includes("SELECT id, update_data")
    && collaborationRouteSource.includes("FOR UPDATE"),
  "Collaboration SQL state is not rebuilt from the locked durable Yjs log"
);
assert(
  !/body\.(?:title|blocks|deletedAttachmentIds)/.test(collaborationRouteSource),
  "A browser-supplied duplicate snapshot can still become relational truth"
);
assert(
  materializationMigrationSource.includes("materialization_version")
    && materializationMigrationSource.includes("NOT NULL DEFAULT 0"),
  "Legacy unbound materialization checkpoints are not fenced by provenance"
);
assert(
  collaborationProtocolSource.includes("latestUpdateId !== state.materializedUpdateId")
    && collaborationProtocolSource.includes(
      "state.materializationVersion !== currentCollaborationMaterializationVersion"
    ),
  "Destructive guards do not require an exact server-authoritative checkpoint"
);
assert(
  collaborationRouteSource.includes("needsCollaborationMaterialization")
    && pageRouteSource.includes("needsCollaborationMaterialization")
    && dataTransferSource.includes("needsCollaborationMaterialization"),
  "Final-share, page, export, or restore paths are missing the materialization provenance guard"
);

assert(
  collaborationServerSource.includes("assessCollaborationWriteCheckpoint")
    && collaborationServerSource.includes("roomUpdateId: room.maxUpdateId")
    && collaborationServerSource.includes('result.reason === "room-stale"')
    && collaborationProtocolSource.includes("roomUpdateId !== durableUpdateId"),
  "A stale process-local collaboration room can still append or compact remote durable updates"
);

const attachmentReconciliationSource = section(
  collaborationClientSource,
  "  reconcileServerAttachments(blocks",
  "  clearMaterializedAttachmentTombstones(ids)"
);
assert(
  collaborationClientSource.includes('from "./collaboration-attachment-reconcile.js"')
    && attachmentReconciliationSource.includes("normalizeBlock({ id: candidate.id, ...readYValue(this.Y, map) })")
    && attachmentReconciliationSource.includes("reconcileCanonicalAttachment(candidate, current, availableIds)"),
  "A reconnect can still replace an acknowledged Yjs attachment location with stale relational fields"
);
assert(
  attachmentReconciliationSource.includes("!this.deletedAttachments.has(id)")
    && attachmentReconciliationSource.includes("!this.deletedAttachments.has(block.id)"),
  "Attachment reconciliation can still treat a tombstoned parent as available"
);
assert(
  attachmentReconcileSource.includes("Existing Yjs location wins")
    && attachmentReconcileSource.includes("currentMatchesCanonical ? currentAttachment : canonicalAttachment")
    && attachmentReconcileSource.includes("...canonicalAttachment"),
  "The attachment merge does not preserve Yjs location while retaining canonical server content"
);

assert(
  collaborationServerSource.includes("if (currentUpdateId === 0)")
    && collaborationServerSource.includes("assessInitialCollaborationBootstrap({")
    && collaborationServerSource.includes('reason: "bootstrap-mismatch"')
    && collaborationServerSource.includes("client.socket.close(4012")
    && collaborationBootstrapSource.includes("candidate.title !== pageTitle")
    && collaborationBootstrapSource.includes("missingBlockCount")
    && collaborationBootstrapSource.includes("changedBlockCount")
    && collaborationBootstrapSource.includes("candidate.deletedAttachmentIds.length"),
  "The first Yjs document can still become durable without matching the locked SQL page"
);
assert(
  collaborationClientSource.includes("resetForCanonicalBootstrapRetry")
    && collaborationClientSource.includes("replaceLiveDocument(new this.Y.Doc())")
    && collaborationClientSource.includes("event.code === 4012"),
  "A rejected bootstrap can still loop on the same incomplete process-local Yjs document"
);

const preparedMutationSource = section(
  collaborationClientSource,
  "  commitLocalMutation(mutator",
  "  clearLocalRecovery()"
);
assert(
  collaborationClientSource.includes('from "./collaboration-durability.js"')
    && collaborationClientSource.includes("PREPARED_LOCAL_ORIGIN")
    && collaborationClientSource.includes("if (origin !== PREPARED_LOCAL_ORIGIN) this.persistLocalRecovery()"),
  "Prepared collaboration updates can still be persisted only after they are exposed to the live document"
);
assert(
  preparedMutationSource.includes("this.Y.encodeStateAsUpdate(prepared.doc)")
    && preparedMutationSource.includes("commitPreparedCollaborationMutation({")
    && preparedMutationSource.includes("persistRecovery: (update) => this.persistRecoveryState(update)")
    && preparedMutationSource.includes("applyLiveUpdate: (update) => this.Y.applyUpdate(this.doc, update, PREPARED_LOCAL_ORIGIN)"),
  "Collaboration edits are not staged as a full recovery candidate before live application"
);
assertBefore(
  preparedMutationSource,
  "persistRecovery: (update) => this.persistRecoveryState(update)",
  "applyLiveUpdate: (update) => this.Y.applyUpdate(this.doc, update, PREPARED_LOCAL_ORIGIN)",
  "prepared collaboration durability"
);
const collaborationMutationSections = [
  ["setTitle(value)", section(collaborationClientSource, "  setTitle(value)", "  upsertBlock(block")],
  ["upsertBlock(block)", section(collaborationClientSource, "  upsertBlock(block", "  upsertBlocks(blocks")],
  ["upsertBlocks(blocks)", section(collaborationClientSource, "  upsertBlocks(blocks", "  deleteBlock(blockId")],
  ["deleteBlock(blockId)", section(collaborationClientSource, "  deleteBlock(blockId", "  adoptAttachment(block")]
];
for (const [methodName, methodSource] of collaborationMutationSections) {
  assert(
    methodSource.includes("this.commitLocalMutation("),
    `${methodName} bypasses the durable staging path`
  );
}

const markBlockDirtySource = section(client, "function markBlockDirty(", "function getBlockSaveQueue(");
assert(
  markBlockDirtySource.includes("if (!persistBlockDraft(row))")
    && markBlockDirtySource.includes("rejectLocalBlockMutation(row, error)"),
  "Block edits can still remain visible when their browser recovery write fails"
);
const durableBlockRestoreSource = section(
  client,
  "function cancelScheduledBlockSave(",
  "function rejectLocalBlockMutation("
);
assert(
  durableBlockRestoreSource.includes("cancelScheduledBlockSave(blockId);")
    && durableBlockRestoreSource.includes("blockSaveTimers.delete(blockId)")
    && durableBlockRestoreSource.includes("blockSaveRows.delete(blockId)"),
  "A rejected block mutation can still be committed later by a stale autosave timer"
);
const saveBlockRowSource = section(client, "async function saveBlockRow(", "function scheduleBlockSave(");
assertBefore(
  saveBlockRowSource,
  "if (!persistBlockDraft(row, payload))",
  "const data = await queue.enqueue(task)",
  "direct block durability"
);
const scheduleTitleSource = section(client, "function schedulePageTitleSave(", "function normalizeRecoveredBlockPayload(");
assertBefore(
  scheduleTitleSource,
  "if (!persistPageTitleDraft())",
  "applyPageSummaryUpdate(state.selectedPage.id, { title })",
  "direct title durability"
);

let helperAppliedAfterRejectedWrite = false;
let helperRejectedWithDurabilityError = false;
try {
  commitPreparedCollaborationMutation({
    recoveryUpdate: new Uint8Array([1]),
    liveUpdate: new Uint8Array([2]),
    persistRecovery: () => null,
    applyLiveUpdate: () => { helperAppliedAfterRejectedWrite = true; }
  });
} catch (error) {
  helperRejectedWithDurabilityError = error instanceof CollaborationRecoveryWriteError;
}
assert(
  helperRejectedWithDurabilityError && !helperAppliedAfterRejectedWrite,
  "A failed collaboration recovery write can still expose an unprotected live edit"
);

const materializationReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-collaboration-materialization-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  materializationReproduction.vulnerable.permanentLossWindowReproduced
    && materializationReproduction.fixed.legacyCheckpointRequiresRematerialization
    && materializationReproduction.fixed.permanentLossWindowClosed,
  "The collaboration materialization loss reproduction did not prove both vulnerable and fixed states"
);

const bootstrapReproduction = JSON.parse(execFileSync(
  process.execPath,
  [
    "--experimental-strip-types",
    fileURLToPath(new URL("./reproduce-collaboration-bootstrap-loss.mjs", import.meta.url))
  ],
  { encoding: "utf8" }
));
assert(
  bootstrapReproduction.vulnerable.permanentLossWindowReproduced
    && bootstrapReproduction.fixed.bootstrapAccepted === false
    && bootstrapReproduction.fixed.relationalBlockCountAfterRejectedBootstrap === 2
    && bootstrapReproduction.fixed.permanentLossWindowClosed,
  "The first-document bootstrap loss reproduction did not prove both vulnerable and fixed states"
);

const crossInstanceReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-cross-instance-compaction-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  crossInstanceReproduction.vulnerable.permanentLossWindowReproduced
    && crossInstanceReproduction.fixed.staleNormalWriteRejected
    && crossInstanceReproduction.fixed.staleRoomInvalidated
    && crossInstanceReproduction.fixed.permanentLossWindowClosed,
  "The cross-instance compaction reproduction did not prove both vulnerable and fixed states"
);

const attachmentPositionReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-attachment-position-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  attachmentPositionReproduction.vulnerable.permanentLossWindowReproduced
    && !attachmentPositionReproduction.vulnerable.acknowledgedMoveSurvived
    && attachmentPositionReproduction.fixed.acknowledgedMoveSurvived
    && attachmentPositionReproduction.fixed.canonicalImmutableContentPreserved
    && attachmentPositionReproduction.fixed.missingAttachmentUsesSqlLocation
    && attachmentPositionReproduction.fixed.permanentLossWindowClosed,
  "The attachment-position loss reproduction did not prove both vulnerable and fixed states"
);

const recoveryWriteReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-collaboration-recovery-write-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  recoveryWriteReproduction.vulnerable.permanentLossWindowReproduced
    && recoveryWriteReproduction.fixed.storageFailure.rejectedWithDurabilityError
    && !recoveryWriteReproduction.fixed.storageFailure.unprotectedEditBecameVisible
    && recoveryWriteReproduction.fixed.success.durableBeforeVisible
    && recoveryWriteReproduction.fixed.permanentLossWindowClosed,
  "The recovery-write loss reproduction did not prove both vulnerable and fixed states"
);

const recoveredDraftActivation = section(
  client,
  "function activatePersistedPageDraft(recovery)",
  "async function createCollection()"
);
assert(
  recoveredDraftActivation.includes("pageTitleDraftSourceId = pageDraftSourceId;"),
  "Recovered titles are still edited through the origin tab's storage source"
);
assert(
  recoveredDraftActivation.includes("row.dataset.draftSourceId = pageDraftSourceId;"),
  "Recovered blocks are still edited through the origin tab's storage source"
);
assert(
  recoveredDraftActivation.includes("persistPageTitleDraft();")
    && recoveredDraftActivation.includes("persistBlockDraft(row);"),
  "Recovered title/block content is not cloned into the current tab before editing"
);
assert(
  recoveredDraftActivation.includes("sourceId: pageDraftSourceId,")
    && recoveredDraftActivation.includes("recoveredOrigin: { sourceId, mutationId: draft.mutationId }"),
  "Recovered block-order retries are not isolated from the origin tab"
);
assert(
  !recoveredDraftActivation.includes("recovery.title.conflict ? recovery.title.sourceId")
    && !recoveredDraftActivation.includes("recovered.conflict ? recovered.sourceId"),
  "Conflict recovery can still alias another tab's durable draft key"
);

const blockOrderAcknowledgement = section(
  client,
  "function acknowledgeBlockOrderDraft(task)",
  "async function submitBlockOrderTask"
);
assert(
  blockOrderAcknowledgement.includes("sourceId: task.recoveredOrigin.sourceId")
    && blockOrderAcknowledgement.includes("mutationId: task.recoveredOrigin.mutationId"),
  "Recovered block-order origin is not cleaned up with an exact mutation guard"
);

for (const [locale, catalog] of Object.entries(translationCatalogs)) {
  const message = catalog?.status?.destructiveLocalDraftsPending;
  assert(
    typeof message === "string" && message.includes("{count}"),
    `Missing destructiveLocalDraftsPending translation for ${locale}`
  );
  assert(
    typeof catalog?.status?.localRecoveryInspectionFailed === "string",
    `Missing localRecoveryInspectionFailed translation for ${locale}`
  );
  assert(
    typeof catalog?.status?.exclusiveTransitionLockUnavailable === "string",
    `Missing exclusiveTransitionLockUnavailable translation for ${locale}`
  );
  assert(
    typeof catalog?.account?.importComplete === "string"
      && catalog.account.importComplete.includes("{shares}"),
    `Missing restored sharing-count translation for ${locale}`
  );
}

assert(
  client.includes("assertBrowserRecoveryInspectionSafe(inspection)"),
  "Destructive guards do not fail closed when browser recovery inspection is uncertain"
);
assert(
  client.includes("let transitionInspection = pageTransitionLock.inspectActive()")
    && client.includes("transition.expiresAt <= Date.now()")
    && client.includes("pageTransitionLock.releaseExpired(transition.pageId)"),
  "Workspace transitions do not inspect and safely reap durable leases"
);
assert(
  client.includes("const exclusiveTransitionId = workspaceTransitionId ?? pageId;")
    && client.includes("const exclusiveTransitionIds = [...new Set([pageId, exclusiveTransitionId])];")
    && client.includes("pageTransitionLock.runExclusive(exclusiveTransitionIds")
    && client.includes("pageTransitionLock.acquire(pageId, kind, exclusiveTransitionId)"),
  "Page and workspace transitions do not share owner/page authoritative browser locks"
);
assert(
  transitionLockSource.includes('? { status: "expired", record }')
    && transitionLockSource.includes("function releaseExpired(pageId)")
    && transitionLockSource.includes("|| !isExclusiveHeld(exclusiveId)")
    && !transitionLockSource.includes("record.expiresAt <= now()) {\n      return removeIfOwned"),
  "Expired durable leases can still be deleted by an uncoordinated reader"
);
assert(
  client.includes("function inspectPageTransitionForUi(pageId)")
    && client.includes("return { locked: true, record: null };")
    && client.includes("async function reapExpiredPageTransition(transition, page = null)"),
  "Transition storage failures or expiry can still reopen editing without authoritative cleanup"
);
assert(
  client.includes("status.exclusiveTransitionLockUnavailable"),
  "Unsupported browser locking does not surface a fail-closed explanation"
);

const permanentDelete = section(client, "async function deleteNavigationTarget()", "function renderCollectionView");
assertBefore(
  permanentDelete,
  "assertNoPendingLocalPageDraftsForPages(serverPageIds",
  "await api(`/api/pages/${target.id}?permanent=true`",
  "permanent page deletion"
);
assertBefore(
  permanentDelete,
  "assertNoPendingLocalCollaborationRecoveryForPages(serverPageIds)",
  "await api(`/api/pages/${target.id}?permanent=true`",
  "permanent page deletion Yjs recovery"
);

const restore = section(client, "async function restoreUserDataBackup(file,", "function getUserInitials");
assertBefore(
  restore,
  "assertNoPendingLocalPageDraftsForPages(ownedPageIds",
  'await api("/api/data/import"',
  "workspace restore"
);
assertBefore(
  restore,
  "assertNoPendingLocalCollaborationRecoveryForPages(ownedPageIds)",
  'await api("/api/data/import"',
  "workspace restore Yjs recovery"
);

const archive = section(
  client,
  'elements.archivePageButton.addEventListener("click"',
  'for (const eventName of ["focusin"'
);
assertBefore(
  archive,
  "assertNoPendingLocalPageDrafts(pageId",
  "await api(`/api/pages/${pageId}`",
  "page archive"
);
assertBefore(
  archive,
  "assertNoPendingLocalCollaborationRecovery(pageId)",
  "await api(`/api/pages/${pageId}`",
  "page archive Yjs recovery"
);

const collaborativeDestructiveTransition = section(
  client,
  "async function withCollaborativeDestructiveTransition",
  "async function deleteBlockWithVersionCheck"
);
assert(
  collaborativeDestructiveTransition.includes("withPagePersistenceTransition(pageId, kind"),
  "Collaborative block deletion lacks owner-scoped cross-tab exclusion"
);
assertBefore(
  collaborativeDestructiveTransition,
  "await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })",
  "assertNoPendingLocalCollaborationRecovery(pageId)",
  "collaborative block deletion peer flush"
);
assertBefore(
  collaborativeDestructiveTransition,
  "assertNoPendingLocalCollaborationRecovery(pageId)",
  "const result = await action(session)",
  "collaborative block deletion recovery guard"
);
assertBefore(
  collaborativeDestructiveTransition,
  "const result = await action(session)",
  "await session.flushMaterialization({ compact: false })",
  "collaborative block deletion durable completion"
);

const blockDelete = section(client, "async function deleteBlockWithVersionCheck", "function updateBlockInState");
assert(blockDelete.includes('withPagePersistenceTransition(pageId, "block-delete"'), "Block deletion lacks a page transition");
assert(
  blockDelete.includes('withCollaborativeDestructiveTransition(pageId, "block-delete"'),
  "Collaborative block deletion can still bypass the browser recovery fence"
);
assertBefore(
  blockDelete,
  "assertNoPendingLocalBlockDrafts(",
  "await api(`/api/blocks/${blockId}`",
  "direct block deletion"
);
assert(
  blockDelete.includes("{ excludeSourceId: pageDraftSourceId }"),
  "Block deletion must exclude only the deleting tab's own source"
);

const attachmentUpload = section(
  client,
  "async function uploadAttachmentFromRow",
  "function requestAttachmentUpload"
);
assert(
  attachmentUpload.includes("await deleteBlockWithVersionCheck(blockId, { includeDescendants: false })")
    && !attachmentUpload.includes("session.deleteBlock("),
  "Attachment replacement can still bypass the collaborative block-deletion recovery fence"
);

const collaborationBlockDeleteReproduction = JSON.parse(execFileSync(
  process.execPath,
  [fileURLToPath(new URL("./reproduce-collaboration-block-delete-recovery-loss.mjs", import.meta.url))],
  { encoding: "utf8" }
));
assert(
  collaborationBlockDeleteReproduction.vulnerable.permanentLossWindowReproduced
    && collaborationBlockDeleteReproduction.fixed.permanentLossWindowClosed
    && collaborationBlockDeleteReproduction.sourceVerification.crossTabTransitionPresent
    && collaborationBlockDeleteReproduction.sourceVerification.peerRecoveryCheckedBeforeDelete
    && collaborationBlockDeleteReproduction.sourceVerification.deleteMaterializedBeforeUnlock
    && collaborationBlockDeleteReproduction.sourceVerification.collaborativeDeleteUsesGuard
    && collaborationBlockDeleteReproduction.sourceVerification.attachmentReplacementUsesGuardedDelete
    && collaborationBlockDeleteReproduction.verified,
  "The collaborative block-delete recovery reproduction did not prove both vulnerable and fixed states"
);

const draftStorage = new MemoryStorage();
const draftBase = { userId: "user", pageId: "page", expectedVersion: 1, revision: 1 };
createPageDraftStore(draftStorage, { sourceId: "tab-a" }).saveBlock({
  ...draftBase,
  blockId: "block-a",
  payload: { type: "MARKDOWN", markdown: "acknowledged elsewhere" }
});
createPageDraftStore(draftStorage, { sourceId: "tab-b" }).saveBlock({
  ...draftBase,
  blockId: "block-b",
  payload: { type: "MARKDOWN", markdown: "must remain visible" }
});
draftStorage.shiftOnNextKey = true;
const drafts = createPageDraftStore(draftStorage, { sourceId: "reader" }).loadUserDrafts("user");
assert(drafts.length === 1 && drafts[0].sourceId === "tab-b", "A surviving direct draft was skipped after a key shift");

const recoveryIsolationStorage = new MemoryStorage();
const recoveryOriginStore = createPageDraftStore(recoveryIsolationStorage, { sourceId: "tab-origin" });
const recoveryCurrentStore = createPageDraftStore(recoveryIsolationStorage, { sourceId: "tab-current" });
recoveryOriginStore.saveTitle({
  userId: "user",
  pageId: "page",
  value: "origin title",
  expectedVersion: 1,
  revision: 1
});
recoveryOriginStore.saveBlock({
  userId: "user",
  pageId: "page",
  blockId: "block",
  payload: { type: "MARKDOWN", markdown: "origin block" },
  expectedVersion: 1,
  revision: 1
});
recoveryOriginStore.saveBlockOrder({
  userId: "user",
  pageId: "page",
  parentBlockId: null,
  orderedIds: ["block"],
  previousIds: ["block"],
  mutationId: "origin-order",
  items: [{ id: "block", sortOrder: 0, parentBlockId: null, expectedVersion: 1 }]
});
recoveryCurrentStore.saveTitle({
  userId: "user",
  pageId: "page",
  value: "edited in current tab",
  expectedVersion: 1,
  revision: 2
});
recoveryCurrentStore.saveBlock({
  userId: "user",
  pageId: "page",
  blockId: "block",
  payload: { type: "MARKDOWN", markdown: "edited in current tab" },
  expectedVersion: 1,
  revision: 2
});
recoveryCurrentStore.saveBlockOrder({
  userId: "user",
  pageId: "page",
  parentBlockId: null,
  orderedIds: ["block"],
  previousIds: ["block"],
  mutationId: "origin-order",
  items: [{ id: "block", sortOrder: 0, parentBlockId: null, expectedVersion: 1 }]
});
const untouchedOrigin = recoveryOriginStore.loadPage("user", "page", "tab-origin");
assert(untouchedOrigin?.title?.value === "origin title", "Current-tab title edits overwrite the recovery origin");
assert(
  untouchedOrigin?.blocks?.block?.payload?.markdown === "origin block",
  "Current-tab block edits overwrite the recovery origin"
);
assert(
  untouchedOrigin?.blockOrder?.mutationId === "origin-order",
  "Current-tab order retries overwrite the recovery origin"
);

const recoveryStorage = new MemoryStorage();
const recoveryStore = createCollaborationRecoveryStore(recoveryStorage);
recoveryStore.save("user", "page", "tab-a", "epoch", new Uint8Array([1]));
recoveryStore.save("user", "page", "tab-b", "epoch", new Uint8Array([2]));
recoveryStorage.shiftOnNextKey = true;
const recovery = recoveryStore.loadPageRecords("page");
assert(
  recovery.length === 1 && recovery[0].sourceId === "tab-b",
  "A surviving collaboration recovery record was skipped after a key shift"
);

let unsupportedLockActionExecuted = false;
const unsupportedLockResult = await createPageTransitionLock(
  new MemoryStorage(),
  { sourceId: "unsupported-browser" }
).runExclusive("__workspace__:user", async () => {
  unsupportedLockActionExecuted = true;
  return "unsafe";
});
assert(
  !unsupportedLockResult.acquired
    && unsupportedLockResult.reason === "lock-manager-unavailable"
    && !unsupportedLockActionExecuted,
  "A destructive transition still runs without an atomic browser lock manager"
);

const expiryFenceStorage = new MemoryStorage();
const expiryFenceLockManager = new MemoryLockManager();
let expiryFenceClock = 1_000;
const expiryFenceOwner = createPageTransitionLock(expiryFenceStorage, {
  sourceId: "tab-owner",
  ttlMs: 1_000,
  now: () => expiryFenceClock,
  lockManager: expiryFenceLockManager
});
const expiryFenceContender = createPageTransitionLock(expiryFenceStorage, {
  sourceId: "tab-contender",
  ttlMs: 1_000,
  now: () => expiryFenceClock,
  lockManager: expiryFenceLockManager
});
let releaseExpiryFenceAction;
let expiryFenceLease = null;
const expiryFenceAction = expiryFenceOwner.runExclusive(
  ["page", "__workspace__:user"],
  async () => {
    expiryFenceLease = expiryFenceOwner.acquire(
      "page",
      "page-delete",
      "__workspace__:user"
    );
    await new Promise((resolve) => { releaseExpiryFenceAction = resolve; });
    return "deleted";
  }
);
await Promise.resolve();
assert(expiryFenceLease, "The expiry-fence reproduction could not acquire its initial lease");
expiryFenceStorage.failWrites = true;
expiryFenceClock = 1_400;
assert(
  expiryFenceOwner.renew(expiryFenceLease) === null,
  "The expiry-fence reproduction did not simulate a failed renewal"
);
expiryFenceClock = 2_001;
const expiredFence = expiryFenceContender.inspect("page");
const blockedExpiryReaper = await expiryFenceContender.runExclusive(
  ["page", "__workspace__:user"],
  async () => expiryFenceContender.releaseExpired("page")
);
assert(
  expiredFence.status === "expired"
    && expiryFenceContender.read("page")?.token === expiryFenceLease.token
    && expiryFenceStorage.getItem("brainvault.pageTransition.v1:page") !== null
    && !blockedExpiryReaper.acquired,
  "An expired lease can still disappear while its destructive Web Lock is held"
);
expiryFenceStorage.failWrites = false;
releaseExpiryFenceAction();
await expiryFenceAction;
const recoveredExpiryFence = await expiryFenceContender.runExclusive(
  ["page", "__workspace__:user"],
  async () => expiryFenceContender.releaseExpired("page")
);
assert(
  recoveredExpiryFence.acquired
    && recoveredExpiryFence.value
    && expiryFenceContender.inspect("page").status === "missing",
  "An expired lease cannot be safely recovered after its authoritative Web Lock is released"
);

const delimiterCollisionInspection = inspectStorageKeys(
  new AlternatingDelimiterCollisionStorage(),
  { maxPasses: 6, stablePasses: 3 }
);
assert(
  !delimiterCollisionInspection.reliable
    && delimiterCollisionInspection.keys.includes("draft\u0000survivor")
    && delimiterCollisionInspection.keys.includes("draft")
    && delimiterCollisionInspection.keys.includes("survivor"),
  "Delimiter-colliding storage key sets can still be mistaken for one stable snapshot"
);

const transitionStorage = new MemoryStorage();
const transitionLockManager = new MemoryLockManager();
const firstLock = createPageTransitionLock(transitionStorage, {
  sourceId: "tab-a",
  lockManager: transitionLockManager
});
const secondLock = createPageTransitionLock(transitionStorage, {
  sourceId: "tab-b",
  lockManager: transitionLockManager
});
await acquireTransitionLease(firstLock, "page", "share-add");
await acquireTransitionLease(secondLock, "__workspace__:user", "data-restore");
transitionStorage.shiftOnNextKey = true;
const activeTransitions = firstLock.loadActive();
assert(
  activeTransitions.length === 1 && activeTransitions[0].pageId === "__workspace__:user",
  "A surviving transition lease was skipped after a key shift"
);

const repeatedShiftProbe = new RepeatedShiftingStorage();
for (const key of ["draft-a", "draft-b", "draft-c", "draft-survivor"]) {
  repeatedShiftProbe.setItem(key, key);
}
repeatedShiftProbe.shiftsRemaining = 3;
const oldSnapshot = oldThreePassForwardSnapshot(repeatedShiftProbe);
assert(
  !oldSnapshot.includes("draft-survivor") && repeatedShiftProbe.getItem("draft-survivor"),
  "The adversarial storage probe no longer reproduces the bounded forward-scan omission"
);

const repeatedDraftStorage = new RepeatedShiftingStorage();
for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
  createPageDraftStore(repeatedDraftStorage, { sourceId }).saveBlock({
    ...draftBase,
    blockId: sourceId,
    payload: { type: "MARKDOWN", markdown: sourceId }
  });
}
repeatedDraftStorage.shiftsRemaining = 3;
const draftInspection = createPageDraftStore(repeatedDraftStorage, { sourceId: "reader" })
  .inspectUserDrafts("user");
assert(
  draftInspection.reliable
  && draftInspection.records.length === 1
  && draftInspection.records[0].sourceId === "tab-survivor",
  "Repeated key shifts can still hide a surviving direct draft"
);

const repeatedRecoveryStorage = new RepeatedShiftingStorage();
const repeatedRecoveryStore = createCollaborationRecoveryStore(repeatedRecoveryStorage);
for (const sourceId of ["tab-a", "tab-b", "tab-c", "tab-survivor"]) {
  repeatedRecoveryStore.save("user", "page", sourceId, "epoch", new Uint8Array([sourceId.length]));
}
repeatedRecoveryStorage.shiftsRemaining = 3;
const recoveryInspection = repeatedRecoveryStore.inspectPageRecords("page");
assert(
  recoveryInspection.reliable
  && recoveryInspection.records.length === 1
  && recoveryInspection.records[0].sourceId === "tab-survivor",
  "Repeated key shifts can still hide a surviving collaboration recovery"
);

const repeatedTransitionStorage = new RepeatedShiftingStorage();
const repeatedTransitionLockManager = new MemoryLockManager();
const repeatedLock = createPageTransitionLock(repeatedTransitionStorage, {
  sourceId: "tab",
  lockManager: repeatedTransitionLockManager
});
for (const pageId of ["page-a", "page-b", "page-c", "page-survivor"]) {
  await acquireTransitionLease(repeatedLock, pageId, "delete");
}
repeatedTransitionStorage.shiftsRemaining = 3;
const transitionInspection = repeatedLock.inspectActive();
assert(
  transitionInspection.reliable
  && transitionInspection.records.length === 1
  && transitionInspection.records[0].pageId === "page-survivor",
  "Repeated key shifts can still hide a surviving transition lease"
);

const corruptDraftStorage = new MemoryStorage();
corruptDraftStorage.setItem("brainvault.pageDraft.v2:user:page:tab-corrupt", "{not-json");
assert(
  createPageDraftStore(corruptDraftStorage, { sourceId: "reader" })
    .inspectPageDrafts("user", "page").unreadableKeys.length === 1,
  "An undecodable target draft is still treated as safely absent"
);

const partialDraftStorage = new MemoryStorage();
const partialDraftKey = "brainvault.pageDraft.v2:user:page:tab-corrupt";
const partialDraftRaw = JSON.stringify({
  schemaVersion: 2,
  userId: "user",
  pageId: "page",
  sourceId: "tab-corrupt",
  updatedAt: 1,
  title: { value: "recoverable", expectedVersion: 1, revision: 1, updatedAt: 1 },
  blocks: { broken: { payload: "not-an-object", expectedVersion: 1, revision: 1, updatedAt: 1 } },
  blockOrder: null
});
partialDraftStorage.setItem(partialDraftKey, partialDraftRaw);
const partialDraftStore = createPageDraftStore(partialDraftStorage, { sourceId: "tab-corrupt" });
assert(
  partialDraftStore.inspectPageDrafts("user", "page").unreadableKeys.includes(partialDraftKey),
  "A partially malformed draft is still accepted after silently dropping one component"
);
assert(
  !partialDraftStore.saveTitle({
    userId: "user",
    pageId: "page",
    sourceId: "tab-corrupt",
    value: "replacement",
    expectedVersion: 1,
    revision: 2
  }) && partialDraftStorage.getItem(partialDraftKey) === partialDraftRaw,
  "A partially malformed draft can still be overwritten by the next title save"
);

const emptyDraftStorage = new MemoryStorage();
const emptyDraftKey = "brainvault.pageDraft.v2:user:page:tab-empty";
emptyDraftStorage.setItem(emptyDraftKey, "");
const emptyDraftStore = createPageDraftStore(emptyDraftStorage, { sourceId: "tab-empty" });
assert(
  emptyDraftStore.inspectPageDrafts("user", "page").unreadableKeys.includes(emptyDraftKey)
  && !emptyDraftStore.saveBlock({
    userId: "user",
    pageId: "page",
    sourceId: "tab-empty",
    blockId: "block",
    payload: { type: "MARKDOWN", markdown: "replacement" },
    expectedVersion: 1,
    revision: 1
  })
  && emptyDraftStorage.getItem(emptyDraftKey) === "",
  "An empty-string draft value is still treated as an absent, overwritable key"
);

const emptyRecoveryStorage = new MemoryStorage();
const emptyRecoveryKey = "brainvault.collaborationRecovery.v1:user:page:epoch:tab";
emptyRecoveryStorage.setItem(emptyRecoveryKey, "");
const emptyRecoveryStore = createCollaborationRecoveryStore(emptyRecoveryStorage);
assert(
  emptyRecoveryStore.inspectPageRecords("page").unreadableKeys.includes(emptyRecoveryKey)
  && emptyRecoveryStore.save("user", "page", "tab", "epoch", new Uint8Array([1])) === null
  && emptyRecoveryStorage.getItem(emptyRecoveryKey) === "",
  "An empty-string collaboration recovery can still be overwritten"
);

const emptyTransitionStorage = new MemoryStorage();
const emptyTransitionKey = "brainvault.pageTransition.v1:page";
emptyTransitionStorage.setItem(emptyTransitionKey, "");
const emptyTransitionLock = createPageTransitionLock(emptyTransitionStorage, {
  sourceId: "tab",
  lockManager: new MemoryLockManager()
});
const emptyTransitionAttempt = await emptyTransitionLock.runExclusive("page", async () =>
  emptyTransitionLock.acquire("page", "delete")
);
assert(
  emptyTransitionLock.inspect("page").status === "invalid"
  && emptyTransitionAttempt.acquired
  && emptyTransitionAttempt.value === null
  && emptyTransitionStorage.getItem(emptyTransitionKey) === "",
  "An empty-string transition lease is still treated as safely missing"
);

const brokenStorage = {
  get length() { throw new Error("disabled"); },
  key() { throw new Error("disabled"); },
  getItem() { throw new Error("disabled"); },
  setItem() { throw new Error("disabled"); },
  removeItem() { throw new Error("disabled"); }
};
assert(
  !createPageDraftStore(brokenStorage, { sourceId: "reader" }).inspectUserDrafts("user").reliable,
  "Storage enumeration failure is still treated as a reliable empty draft set"
);
assert(
  !createCollaborationRecoveryStore(brokenStorage).inspectPageRecords("page").reliable,
  "Storage enumeration failure is still treated as a reliable empty collaboration recovery set"
);
assert(
  !createPageTransitionLock(brokenStorage, { sourceId: "reader" }).inspectActive().reliable,
  "Storage enumeration failure is still treated as a reliable empty transition set"
);

console.log(
  "[verify-data-loss-guards] OK: durable-before-visible browser edits, destructive ordering, server-authoritative collaboration materialization, SQL-fenced first-document bootstrap, cross-instance durable-room freshness fencing, stale-SQL attachment-position fencing, provenance-fenced checkpoints, owner-scoped atomic browser exclusion, expiry-safe transition fencing, cross-tab recovery isolation, lossless malformed-record handling, seven locale messages, boundary-safe convergent storage snapshots, fail-closed block-order range preservation, strict transactional SQL sessions, stream-verified and length-framed backup ZIP integrity, identity-bound page-share backup/restore, archived-share backup round-trip integrity, fail-closed backup metadata restoration, attachment metadata/file binding, fail-closed structured metadata preservation, page-scoped parent cascade fencing, database fallback reference integrity, collaboration block-delete recovery fencing, and fail-closed recovery inspection, plus owner-scoped idempotent page creation and authentication-scoped download completion."
);
