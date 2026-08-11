import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("backup v4 preserves page version history and owned-page navigation collapse state", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));
  const authRoutes = normalize(await readFile(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8"));

  assert.match(transfer, /const uploadedAssetBackupVersion = 3;\nconst backupVersion = 4;/);
  assert.match(transfer, /pageVersions: z\.array\(pageVersionSchema\)/);
  assert.match(transfer, /navigationCollapsedPageIds: z\.array\(idSchema\)/);
  assert.match(transfer, /Version 4 backups must declare page version history/);
  assert.match(transfer, /Version 4 backups must declare owned-page navigation preferences/);
  assert.match(transfer, /Page version edit version exceeds the current page version/);
  assert.match(transfer, /Page version content version exceeds the current page version/);
  assert.match(transfer, /FROM page_versions pv INNER JOIN pages p ON p\.id = pv\.page_id[\s\S]*?WHERE p\.owner_id = \?/);
  assert.match(transfer, /FROM user_navigation_collapsed_pages np[\s\S]*?WHERE np\.user_id = \? AND p\.owner_id = \?/);
  assert.match(transfer, /pageVersions: snapshot\.pageVersions/);
  assert.match(transfer, /navigationCollapsedPageIds: snapshot\.navigationCollapsedPageIds/);
  assert.match(transfer, /INSERT INTO page_versions[\s\S]*?page_edit_version[\s\S]*?change_summary[\s\S]*?changes/);
  assert.match(transfer, /INSERT INTO user_navigation_collapsed_pages \(user_id, page_id\) VALUES \(\?, \?\)/);
  assert.match(transfer, /function rebindPageVersionChangesJson/);
  assert.match(transfer, /function rebindPageVersionActorsJson/);
  assert.match(transfer, /hash\.update\([\s\S]*?`page-version\\0\$\{version\.page_id\}/);
  assert.match(transfer, /hash\.update\(`navigation-collapsed\\0\$\{pageId\}\\n`\)/);

  assert.match(
    authRoutes,
    /\/navigation-preferences[\s\S]*?transaction\(async \(client\) => \{[\s\S]*?SELECT id FROM users WHERE id = \? FOR UPDATE/
  );
});

test("standalone reproduction proves both pre-fix loss and corrected round trip", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-backup-workspace-state-loss.mjs", import.meta.url))],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "safe.directory",
        GIT_CONFIG_VALUE_0: fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")
      }
    }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerability.pageVersionHistoryLostAfterSuccessfulRestore, true);
  assert.equal(result.vulnerability.navigationCollapseStateLostAfterSuccessfulRestore, true);
  assert.equal(result.fixed.roundTripPreservesPageVersionCount, true);
  assert.equal(result.fixed.roundTripPreservesNavigationState, true);
  assert.equal(result.fixed.customIconHistoryReferenceRebound, true);
});
