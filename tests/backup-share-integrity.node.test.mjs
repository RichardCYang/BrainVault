import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const dataTransferUrl = new URL("../src/lib/data-transfer.ts", import.meta.url);

function simulatePatchedRestore({ currentShares, backupShares, importedPageIds, legacy }) {
  if (!legacy) return backupShares.map((share) => ({ ...share }));
  return currentShares.filter((share) => importedPageIds.has(share.pageId) && share.shareable);
}

test("complete backup includes and restores page sharing relationships", async () => {
  const source = (await readFile(dataTransferUrl, "utf8")).replace(/\r\n/g, "\n");
  const routeSource = (await readFile(new URL("../src/routes/data.routes.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");
  const clientSource = (await readFile(new URL("../public/app.js", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(source, /const pageShareSchema = z\.object\(/);
  assert.match(source, /ps\.user_id AS shared_user_id/);
  assert.match(source, /u\.username AS shared_username/);
  assert.match(source, /pageShares: snapshot\.pageShares/);
  assert.match(source, /INSERT INTO page_shares \(page_id, user_id, permission, shared_by, created_at\)/);
  assert.match(source, /Shared account identity does not match this server/);
  assert.match(source, /Legacy sharing grant cannot be verified against a current exact account grant/);
  assert.match(routeSource, /sharing: result\.sharing/);
  assert.match(clientSource, /shares: formatNumber\(counts\.shares \?\? 0\)/);
});

test("legacy backup cannot silently erase surviving current shares", () => {
  const share = {
    pageId: "pag_shared",
    userId: "usr_editor",
    permission: "EDIT",
    shareable: true
  };
  const restored = simulatePatchedRestore({
    currentShares: [share],
    backupShares: [],
    importedPageIds: new Set([share.pageId]),
    legacy: true
  });

  assert.deepEqual(restored, [share]);
});

test("new backup round-trip restores the backed-up collaborator", () => {
  const share = {
    pageId: "pag_shared",
    userId: "usr_editor",
    username: "editor",
    permission: "EDIT"
  };
  const restored = simulatePatchedRestore({
    currentShares: [],
    backupShares: [share],
    importedPageIds: new Set([share.pageId]),
    legacy: false
  });

  assert.deepEqual(restored, [share]);
});
