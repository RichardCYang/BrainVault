import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("backup v3 makes uploaded custom icons self-contained and restorable", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));
  const customIcons = normalize(await readFile(new URL("../src/lib/custom-icons.ts", import.meta.url), "utf8"));

  assert.match(transfer, /const pageCoverFileBackupVersion = 2;\nconst backupVersion = 3;/);
  assert.match(transfer, /customIcons: z\.array\(customIconFileSchema\)/);
  assert.match(transfer, /customIconLibraryRemovals: z\.array\(customIconLibraryRemovalSchema\)/);
  assert.match(transfer, /const customIconOwnerDir = path\.join\(customIconUploadRoot, userId\)/);
  assert.match(transfer, /customIconEntries = customIconEntries\.filter\(\(entry\) => entry\.name !== dataRestoreGenerationMarkerName\)/);
  assert.match(transfer, /path: `custom-icons\/\$\{entry\.name\}`/);
  assert.match(transfer, /for \(const item of customIconFiles\) \{[\s\S]*?writer\.add/);
  assert.match(transfer, /\.\.\.\(manifest\.customIcons \?\? \[\]\)\.map\(\(item\) => item\.path\)/);
  assert.match(transfer, /entry\.uncompressedSize > BigInt\(maxCustomIconBytes\)/);
  assert.match(transfer, /inspection\.sha256 !== customIcon\.sha256/);
  assert.match(transfer, /detectCustomIconFileType\(await readFile\(outputPath\)\)/);

  assert.match(transfer, /function rebindCustomIconValue\([\s\S]*?customIconPublicPath\(targetUserId, fileName\)/);
  assert.match(transfer, /restoreIconValue\(manifest\.account\.default_collection_icon\)/);
  assert.match(transfer, /page\.id, page\.title, restoreIconValue\(page\.icon\)/);
  assert.match(transfer, /DELETE FROM custom_icons WHERE user_id = \?/);
  assert.match(transfer, /INSERT INTO custom_icons \(id, user_id, file_path, last_used_at, created_at\)/);
  assert.match(transfer, /localRemovalHashMap[\s\S]*?customIconValueHash\(customIconValue\(userId, icon\.fileName\)\)/);
  assert.match(transfer, /createWorkspaceRestoreSnapshot[\s\S]*?FROM custom_icons[\s\S]*?ORDER BY id ASC\$\{lockClause\}/);
  assert.match(transfer, /createWorkspaceRestoreSnapshot[\s\S]*?FROM custom_icon_library_removals[\s\S]*?ORDER BY value_hash ASC\$\{lockClause\}/);
  assert.match(transfer, /hash\.update\([\s\S]*?`custom-icon\\0\$\{icon\.id\}/);
  assert.match(transfer, /custom-icon-removal\\0\$\{removal\.value_hash\}/);

  assert.match(transfer, /const restoreJournalV4Schema = z\.object\(/);
  assert.match(transfer, /hadPreviousCustomIcons: z\.boolean\(\)/);
  assert.match(transfer, /restoredCustomIconFiles: z\.array\(customIconFilenameSchema\)/);
  assert.match(transfer, /recoverTrackedRestoreAssets\(/);
  assert.match(transfer, /rename\(targetCustomIconDir, oldCustomIconDir\)/);
  assert.match(transfer, /rename\(stagedCustomIconDir, targetCustomIconDir\)/);

  assert.match(customIcons, /listCustomIcons[\s\S]*?withUserAttachmentLock/);
  assert.match(customIcons, /removeCustomIconFromLibrary[\s\S]*?withUserAttachmentLock/);
  assert.match(customIcons, /restoreCustomIconToLibrary[\s\S]*?withUserAttachmentLock/);
  assert.match(customIcons, /rememberCustomIconPaths[\s\S]*?withUserAttachmentLock/);
  assert.match(customIcons, /storeCustomIcon[\s\S]*?withUserAttachmentLock/);
});

test("backup v3 retains files removed from the picker instead of exporting active rows only", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));
  const rowQuery = transfer.indexOf("FROM custom_icons");
  const directoryRead = transfer.indexOf("readdir(customIconOwnerDir, { withFileTypes: true })");
  const rowLookup = transfer.indexOf("customIconRowsByFileName.get(entry.name) ?? null");
  const libraryNull = transfer.indexOf("library: row ? {");

  assert.ok(rowQuery >= 0);
  assert.ok(directoryRead > rowQuery, "filesystem enumeration must happen after the DB snapshot is captured");
  assert.ok(rowLookup > directoryRead, "every filesystem icon must be exported whether or not an active row exists");
  assert.ok(libraryNull > rowLookup);
  assert.match(transfer, /for \(const fileName of customIconRowsByFileName\.keys\(\)\) \{[\s\S]*?BACKUP_CUSTOM_ICON_MISSING/);
});
