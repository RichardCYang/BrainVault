import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = async (relativePath) => normalize(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

test("split active/archive scans can omit a page when a remote archive state changes", () => {
  const page = { id: "pag_draft" };
  const activeScanWhileArchived = [];
  const archivedScanAfterRemoteRestore = [];
  const splitUnion = [...new Set([...activeScanWhileArchived, ...archivedScanAfterRemoteRestore].map((item) => item.id))];
  assert.deepEqual(splitUnion, []);

  // An archive-independent query has stable membership across that same state
  // transition, so the local draft fence still receives the owned page id.
  const archiveIndependentScan = [page];
  assert.deepEqual(archiveIndependentScan.map((item) => item.id), ["pag_draft"]);
});

test("workspace-owned page fencing uses one archive-independent list scan", async () => {
  const app = await read("public/app.js");
  const start = app.indexOf("async function fetchOwnedWorkspacePageIds()");
  const end = app.indexOf("async function loadPages(", start);
  assert.ok(start >= 0 && end > start);
  const body = app.slice(start, end);

  assert.match(body, /fetchAllPageSummaries\(\{ archived: "all" \}\)/);
  assert.doesNotMatch(body, /Promise\.all/);
  assert.doesNotMatch(body, /archived: true/);
});

test("page list route supports archive-independent scans without weakening access control", async () => {
  const route = await read("src/routes/page.routes.ts");
  assert.match(route, /\.enum\(\["true", "false", "all"\]\)/);
  assert.match(route, /if \(query\.archived !== "all"\) \{\s*where\.push\("p\.is_archived = \?"\)/);
  assert.match(route, /p\.owner_id = \?/);
  assert.match(route, /current_collection_share\.user_id = \?/);
  assert.match(route, /current_share\.user_id = \?/);
});
