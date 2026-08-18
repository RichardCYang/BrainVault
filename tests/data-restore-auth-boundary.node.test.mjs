import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("workspace restore carries and revalidates its initiating authentication scope", async () => {
  const routes = await read("src/routes/data.routes.ts");
  const snapshotRoutes = await read("src/routes/snapshot.routes.ts");
  const snapshotLib = await read("src/lib/workspace-snapshots.ts");
  const transfer = await read("src/lib/data-transfer.ts");

  assert.match(routes, /const authVersion = Number\(req\.auth\?\.authVersion\)/);
  assert.match(routes, /const sessionId = req\.auth\?\.sessionId/);
  assert.match(
    routes,
    /importUserDataBackup\(user\.id, uploadPath, \{\s*authVersion,\s*sessionId\s*\}\)/
  );

  assert.match(snapshotRoutes, /const authVersion = Number\(req\.auth\?\.authVersion\)/);
  assert.match(snapshotRoutes, /const sessionId = req\.auth\?\.sessionId/);
  assert.match(
    snapshotRoutes,
    /restoreWorkspaceSnapshot\(user\.id, req\.params\.snapshotId, \{\s*authVersion,\s*sessionId\s*\}\)/
  );
  assert.match(
    snapshotLib,
    /return importUserDataBackup\(userId, filePath, authScope\)/
  );

  assert.match(transfer, /import \{ isAuthSessionActive \} from "\.\/auth-sessions\.js"/);
  assert.match(transfer, /async function assertCurrentDataRestoreAuthentication/);
  assert.match(
    transfer,
    /SELECT auth_version FROM users WHERE id = \? FOR UPDATE/
  );
  assert.match(
    transfer,
    /isAuthSessionActive\(\s*userId,\s*authScope\.sessionId,\s*authScope\.authVersion,\s*client,\s*\{ lock: true \}\s*\)/
  );

  const transactionStart = transfer.indexOf("await transaction(async (client) => {", transfer.indexOf("export async function importUserDataBackup"));
  const destructiveDelete = transfer.indexOf('await client.execute("DELETE FROM pages WHERE owner_id = ?", [userId])');
  assert.ok(transactionStart >= 0, "restore transaction is missing");
  assert.ok(destructiveDelete >= 0, "workspace page replacement is missing");

  const transactionSource = transfer.slice(transactionStart);
  const firstFence = transactionSource.indexOf("await assertCurrentDataRestoreAuthentication(client, userId, authScope)");
  const importRowsCall = transactionSource.indexOf("await importRows(");
  const secondFence = transactionSource.lastIndexOf(
    "await assertCurrentDataRestoreAuthentication(client, userId, authScope)",
    importRowsCall
  );

  assert.ok(firstFence >= 0, "restore must bind auth before workspace locks");
  assert.ok(secondFence > firstFence && secondFence < importRowsCall,
    "restore must revalidate auth immediately before destructive import");
});

test("standalone model reproduces stale-session restore and the durable-boundary fix", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-data-restore-auth-rotation.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.admitted, true);
  assert.equal(result.vulnerable.destructiveImportRan, true);
  assert.equal(result.fixed.admitted, true);
  assert.equal(result.fixed.durableAuthValid, false);
  assert.equal(result.fixed.destructiveImportRan, false);
});
