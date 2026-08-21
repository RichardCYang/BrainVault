import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { measureJsonUtf8BytesWithinLimit } from "../src/lib/data-transfer-limits.ts";

const manifestLimit = 16 * 1024 * 1024;
const timestamp = "2026-08-04T00:00:00.000Z";

function page(id, coverUrl) {
  return {
    id, title: id, icon: null, cover_url: coverUrl, cover_position_x: 50, cover_position_y: 50,
    is_archived: 0, is_collection: 0, parent_page_id: null, edit_version: 1, content_version: 1,
    created_at: timestamp, updated_at: timestamp
  };
}

function manifest(version, pages, pageCovers) {
  return {
    format: "brainvault-backup", version, exportedAt: timestamp,
    source: { userId: "usr_test", username: "tester" },
    account: { name: null, avatar_data: null, preferred_language: null, default_collection_icon: null, theme: "light" },
    data: { pages, blocks: [], tags: [], pageTags: [], pageShares: [] },
    attachments: [],
    ...(pageCovers === undefined ? {} : { pageCovers })
  };
}

test("external cover entries prevent valid custom images from exhausting the JSON manifest", () => {
  const encoded = Buffer.alloc(2 * 1024 * 1024).toString("base64");
  const inlinePages = Array.from({ length: 6 }, (_, index) => page(`page-${index}`, `data:image/png;base64,${encoded}`));
  const legacy = manifest(1, inlinePages);
  assert.equal(measureJsonUtf8BytesWithinLimit(legacy, manifestLimit), null);

  const externalPages = inlinePages.map((item) => ({ ...item, cover_url: null }));
  const descriptors = externalPages.map((item) => ({
    pageId: item.id, path: `page-covers/${item.id}`, mimeType: "image/png",
    size: String(2 * 1024 * 1024), sha256: "0".repeat(64), crc32: 0
  }));
  const current = manifest(2, externalPages, descriptors);
  const measured = measureJsonUtf8BytesWithinLimit(current, manifestLimit);
  assert.ok(measured !== null && measured < 32 * 1024);
});

test("backup v2/v3 cover files remain importable while current v4 preserves the same integrity checks", async () => {
  const transfer = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  assert.match(transfer, /const legacyBackupVersion = 1;\nconst pageCoverFileBackupVersion = 2;\nconst uploadedAssetBackupVersion = 3;\nconst backupVersion = 4;/);
  assert.match(transfer, /z\.literal\(legacyBackupVersion\),\n\s*z\.literal\(pageCoverFileBackupVersion\),\n\s*z\.literal\(uploadedAssetBackupVersion\),\n\s*z\.literal\(backupVersion\)/);
  assert.match(transfer, /CASE WHEN cover_url LIKE 'data:image\/%;base64,%' THEN \? ELSE cover_url END AS cover_url/);
  assert.match(transfer, /page\.cover_url = null;/);
  assert.match(transfer, /path: `page-covers\/\$\{page\.id\}`/);
  assert.match(transfer, /for \(const item of pageCoverFiles\) \{[\s\S]*?writer\.add/);
  assert.match(transfer, /\.\.\.\(manifest\.pageCovers \?\? \[\]\)\.map\(\(item\) => item\.path\)/);
  assert.match(transfer, /inspectCustomCoverBytes\(pageCover\.mimeType, await readFile\(outputPath\)\)/);
  assert.match(transfer, /if \(page\.cover_url !== null\) \{[\s\S]*?Page cover is declared both inline and as a ZIP entry/);
  assert.match(transfer, /createCustomCoverDataUrl\([\s\S]*?await readFile\(path\.join\(stagedPageCoverDir, page\.id\)\)/);
});


test("standalone reproduction proves the vulnerable and corrected backup states", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [
      "--import=tsx",
      fileURLToPath(new URL("../scripts/reproduce-page-cover-backup-manifest-loss.mjs", import.meta.url))
    ],
    { encoding: "utf8" }
  ));
  assert.equal(result.vulnerable.exceedsManifestLimit, true);
  assert.equal(result.fixed.fitsManifestLimit, true);
  assert.equal(result.fixed.coverBytesStoredAsZipEntries, true);
  assert.equal(result.fixed.legacyVersionOneImportRetained, true);
  assert.equal(result.vulnerable.ambiguousBuiltInAndZipCoverRejected, false);
  assert.equal(result.vulnerable.ambiguousBuiltInCoverSilentlyOverridden, true);
  assert.equal(result.fixed.ambiguousBuiltInAndZipCoverRejected, true);
});
