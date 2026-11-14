// Version 7 backups keep the sections that grow with the workspace in bounded
// JSON shards, so a large workspace no longer hits the 16 MB manifest or the
// fixed row counts. Versions 1-6 keep their exact rules.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "mariadb://report:unused@127.0.0.1:1/report";
const { parseBackupManifest } = await import("../src/lib/data-transfer.ts");
const { computeBackupDataBudgetBytes, dataTransferResourceLimits } = await import("../src/lib/data-transfer-limits.ts");
const transfer = readFileSync(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8");

const MiB = 1024 * 1024;

function manifest(version, overrides = {}) {
  return {
    format: "brainvault-backup",
    version,
    exportedAt: "2026-11-14T07:49:19.332Z",
    source: { userId: "usr_source", username: "source" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "system", default_page_mode: "read" },
    data: {
      pages: [], blocks: [], tags: [], pageTags: [], pageShares: [], collectionShares: [],
      pageComments: [], pageVersions: [], navigationCollapsedPageIds: [], navigationPageOrder: []
    },
    attachments: [], retainedAttachments: [], pageCovers: [], customIcons: [], customIconLibraryRemovals: [],
    customIconPublications: [],
    ...(version >= 7 ? { shards: [] } : {}),
    ...overrides
  };
}

const rejects = (value) => assert.throws(() => parseBackupManifest(value), (error) => error?.statusCode === 400 && error?.code === "INVALID_DATA_BACKUP");

test("version 6 manifests still parse exactly as before", () => {
  assert.equal(parseBackupManifest(manifest(6)).version, 6);
  rejects(manifest(6, { shards: [] }));
});

test("version 7 manifests must declare shards and keep sharded sections out of the manifest", () => {
  assert.equal(parseBackupManifest(manifest(7)).version, 7);
  rejects(manifest(7, { shards: undefined }));
  const inline = manifest(7);
  inline.data.pageTags = [{ page_id: "pag_a", tag_id: "tag_a" }];
  rejects(inline);
});

test("shard paths are fixed to their section and unique", () => {
  const shard = { section: "blocks", path: "data-shards/blocks/000001.json", rows: 1 };
  assert.equal(parseBackupManifest(manifest(7, { shards: [shard] })).shards.length, 1);
  rejects(manifest(7, { shards: [{ ...shard, path: "data-shards/pageTags/000001.json" }] }));
  rejects(manifest(7, { shards: [shard, shard] }));
  rejects(manifest(7, { shards: [{ ...shard, path: "../evil.json" }] }));
  rejects(manifest(7, { shards: [{ ...shard, path: "attachments/blk_a" }] }));
  rejects(manifest(7, { shards: [{ ...shard, rows: 0 }] }));
});

test("the data budget follows the heap and never drops below the legacy manifest limit", () => {
  const base = { configuredBytes: 4096 * MiB, heapLimitBytes: 4096 * MiB, concurrentOperations: 5, minimumBytes: 16 * MiB };
  assert.equal(computeBackupDataBudgetBytes(base), Math.floor(4096 * MiB / 10));
  assert.equal(computeBackupDataBudgetBytes({ ...base, configuredBytes: 64 * MiB }), 64 * MiB);
  assert.equal(computeBackupDataBudgetBytes({ ...base, heapLimitBytes: 64 * MiB }), 16 * MiB);
  assert.equal(computeBackupDataBudgetBytes({ ...base, concurrentOperations: 0 }), Math.floor(4096 * MiB / 2));
});

test("each shard is read and validated on its own, within fixed bounds", () => {
  assert.equal(dataTransferResourceLimits.maxShardBytes, 16 * MiB);
  assert.ok(dataTransferResourceLimits.shardTargetBytes < dataTransferResourceLimits.maxShardBytes);
  const load = transfer.slice(transfer.indexOf("async function loadBackupShards("), transfer.indexOf("function shardBackupManifest("));
  assert.match(load, /readZipEntryBuffer\(zipPath, entry, dataTransferResourceLimits\.maxShardBytes\)/);
  assert.match(load, /assertManifestValidationBudget\(value\)/);
  assert.match(load, /totalBytes > dataBudget/);
  assert.match(load, /rows\.length !== shard\.rows/);
  // Both readers load shards before relations are validated, and accept shard entries only when declared.
  assert.equal(transfer.split("await loadBackupShards(zipPath, entryByName, manifest, manifestEntry.uncompressedSize, enforceConfiguredSizeLimits);\n  validateManifestRelations(manifest);").length - 1, 2);
  assert.equal(transfer.split("...(manifest.shards ?? []).map((item) => item.path)").length - 1, 2);
});

test("exports write version 7 and no longer cap sharded sections by row count", () => {
  assert.match(transfer, /const backupVersion = shardedBackupVersion;/);
  const exportSource = transfer.slice(transfer.indexOf("export async function prepareUserDataBackup("), transfer.indexOf("export async function writeUserDataBackup("));
  for (const label of ['"blocks"', '"page-tag relations"', '"page comments"', '"custom icon publications"']) {
    assert.doesNotMatch(exportSource, new RegExp(`assertExportCount\\(${label}`));
  }
  assert.match(exportSource, /shardBackupManifest\(manifest\)/);
  assert.match(exportSource, /maxCount: Number\.MAX_SAFE_INTEGER/);
});
