import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("backup v3 preserves every per-account attachment file, including retained unlinked files", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));

  assert.match(transfer, /retainedAttachments: z\.array\(retainedAttachmentSchema\)/);
  assert.match(transfer, /Version 3 backups must declare retained attachment files/);
  assert.match(transfer, /const attachmentOwnerDir = path\.join\(attachmentUploadRoot, userId\)/);
  assert.match(transfer, /attachmentEntries = attachmentEntries\.filter\(\(entry\) => entry\.name !== dataRestoreGenerationMarkerName\)/);
  assert.match(transfer, /if \(activeAttachmentNames\.has\(entry\.name\)\) continue;/);
  assert.match(transfer, /retainedAttachmentFiles\.push\(\{[\s\S]*?path: `attachments\/\$\{entry\.name\}`/);
  assert.match(transfer, /retainedAttachments: retainedAttachmentFiles\.map/);
  assert.match(transfer, /for \(const item of retainedAttachmentFiles\) \{[\s\S]*?writer\.add/);
  assert.match(transfer, /\.\.\.retainedAttachments\.map\(\(item\) => item\.path\)/);
  assert.match(transfer, /Retained attachment size or CRC does not match/);
  assert.match(transfer, /Retained attachment SHA-256 does not match/);
  assert.match(transfer, /\.\.\.retainedAttachments\.map\(\(attachment\) => attachment\.fileName\)/);
  assert.match(transfer, /manifest\.attachments\.length \+ retainedAttachments\.length/);
});

test("restore conflict fencing includes live filesystem asset generations", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));

  assert.match(transfer, /async function listWorkspaceRestoreAssetFiles/);
  assert.match(transfer, /hash\.update\(`attachment-file\\0\$\{file\.name\}\\0\$\{file\.size\}\\n`\)/);
  assert.match(transfer, /hash\.update\(`custom-icon-file\\0\$\{file\.name\}\\0\$\{file\.size\}\\n`\)/);
  assert.match(transfer, /createWorkspaceRestoreSnapshot\(userId, client, false, restoresCustomIcons\)/);
  assert.match(transfer, /createWorkspaceRestoreSnapshot\([\s\S]*?true,[\s\S]*?restoresCustomIcons/);
  assert.match(transfer, /DATA_RESTORE_ASSET_STORAGE_INVALID/);
});

test("attachment final-file cleanup shares the backup/restore user asset lock", async () => {
  const blockRoutes = normalize(await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8"));

  assert.match(
    blockRoutes,
    /insertDefinitelyFailed && movedPath[\s\S]*?withUserAttachmentLock\(ownerId[\s\S]*?removeAttachmentPath\(failedMovedPath\)/
  );
});
