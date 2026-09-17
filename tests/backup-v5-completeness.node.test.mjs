import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

async function transferSource() {
  return normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));
}

test("backup v5 closes current-format optional-section completeness gaps", async () => {
  const transfer = await transferSource();

  assert.match(
    transfer,
    /const uploadedAssetBackupVersion = 3;\nconst completeWorkspaceBackupVersion = 4;\nconst explicitWorkspaceBackupVersion = 5;\nconst backupVersion = 6;/
  );
  assert.match(
    transfer,
    /z\.literal\(uploadedAssetBackupVersion\),\n\s*z\.literal\(completeWorkspaceBackupVersion\),\n\s*z\.literal\(explicitWorkspaceBackupVersion\),\n\s*z\.literal\(backupVersion\)/
  );
  assert.match(transfer, /manifest\.version >= explicitWorkspaceBackupVersion[\s\S]*Version 5 backups must declare page sharing grants/);
  assert.match(transfer, /Version 5 backups must declare collection sharing grants/);
  assert.match(transfer, /Version 5 backups must declare page comments/);
  assert.match(transfer, /Version 5 backups must declare owned-page navigation order/);
  assert.match(transfer, /Version 5 backups must declare the account theme/);
  assert.match(transfer, /Version 5 pages must preserve both cover position coordinates/);
  assert.match(transfer, /Version 5 page shares must bind the collaborator account ID/);

  // v4 remains importable for archives written before these sections became
  // unconditionally present, while v5 and later retain the strict completeness contract.
  assert.match(transfer, /manifest\.version >= completeWorkspaceBackupVersion && !manifest\.data\.pageVersions/);
  assert.match(transfer, /manifest\.version >= completeWorkspaceBackupVersion && !manifest\.data\.navigationCollapsedPageIds/);
  assert.match(transfer, /if \(manifest\.version >= completeWorkspaceBackupVersion\) \{[\s\S]*INSERT INTO page_versions/);
});

test("backup v5 round-trips mutable collection-share and navigation-order timestamps", async () => {
  const transfer = await transferSource();

  assert.match(transfer, /const collectionShareSchema = z\.object\([\s\S]*updated_at: timestampSchema\.optional\(\)/);
  assert.match(transfer, /Version 5 collection shares must preserve their update timestamp/);
  assert.match(
    transfer,
    /SELECT cs\.collection_id, cs\.user_id AS shared_user_id[\s\S]*DATE_FORMAT\(cs\.updated_at, '%Y-%m-%d %H:%i:%s\.%f'\) AS updated_at/
  );
  assert.match(
    transfer,
    /SELECT cs\.collection_id, cs\.user_id, cs\.permission, cs\.shared_by, cs\.generation,[\s\S]*DATE_FORMAT\(cs\.updated_at, '%Y-%m-%d %H:%i:%s\.%f'\) AS updated_at/
  );
  assert.match(transfer, /collection-share\\0\$\{share\.collection_id\}[\s\S]*\\0\$\{share\.updated_at\}/);
  assert.match(transfer, /updatedAt: share\.updated_at \?\? share\.created_at/);
  assert.match(transfer, /share\.createdAt, share\.updatedAt/);

  assert.match(transfer, /const navigationPageOrderSchema = z\.object\([\s\S]*updated_at: timestampSchema\.optional\(\)/);
  assert.match(transfer, /Version 5 navigation order entries must preserve their update timestamp/);
  assert.match(
    transfer,
    /SELECT no\.page_id, no\.sort_order,[\s\S]*DATE_FORMAT\(no\.updated_at, '%Y-%m-%d %H:%i:%s\.%f'\) AS updated_at/
  );
  assert.match(transfer, /navigation-order\\0\$\{item\.page_id\}[\s\S]*\$\{item\.updated_at\}/);
  assert.match(
    transfer,
    /INSERT INTO user_navigation_page_order \(user_id, page_id, sort_order, updated_at\) VALUES \(\?, \?, \?, \?\)/
  );
});

test("portable restore keeps anti-impersonation identity hardening explicit", async () => {
  const transfer = await transferSource();
  assert.match(transfer, /user-controlled backup cannot prove[\s\S]*Rebind every imported actor to the importing account/i);
  assert.match(transfer, /Backup bytes are controlled by the importer[\s\S]*every imported[\s\S]*comment to the importer/i);
});
