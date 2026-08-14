import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

test("workspace restore preserves surviving collaborators' navigation preferences", async () => {
  const transfer = normalize(await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"));

  assert.match(transfer, /async function prepareRestoreCollaboratorNavigationPlan/);
  assert.match(
    transfer,
    /restoredCollaboratorIds[\s\S]*?FROM user_navigation_collapsed_pages np[\s\S]*?WHERE p\.owner_id = \? AND np\.user_id IN \(\$\{placeholders\}\)[\s\S]*?FOR UPDATE/
  );
  assert.match(
    transfer,
    /FROM user_navigation_page_order no[\s\S]*?WHERE p\.owner_id = \? AND no\.user_id IN \(\$\{placeholders\}\)[\s\S]*?FOR UPDATE/
  );
  assert.match(transfer, /DATE_FORMAT\(np\.created_at[\s\S]*?AS created_at/);
  assert.match(transfer, /DATE_FORMAT\(no\.updated_at[\s\S]*?AS updated_at/);
  assert.match(transfer, /restoredShareKeys\.has\(collaboratorNavigationKey\(row\.user_id, row\.page_id\)\)/);

  const captureIndex = transfer.indexOf("restoreCollaboratorNavigation = await prepareRestoreCollaboratorNavigationPlan(");
  const importIndex = transfer.indexOf("await importRows(", captureIndex);
  assert.ok(captureIndex >= 0 && importIndex > captureIndex, "collaborator navigation must be captured before destructive import");

  assert.match(transfer, /for \(const row of collaboratorNavigation\.collapsed\)[\s\S]*?INSERT INTO user_navigation_collapsed_pages[\s\S]*?created_at/);
  assert.match(transfer, /for \(const row of collaboratorNavigation\.order\)[\s\S]*?INSERT INTO user_navigation_page_order[\s\S]*?updated_at/);
});

test("standalone reproduction proves collaborator navigation loss before the fix and preservation after it", () => {
  const output = execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaborator-navigation-restore-loss.mjs", import.meta.url))],
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
  assert.equal(result.vulnerability.collaboratorCollapseLostAfterSuccessfulRestore, true);
  assert.equal(result.vulnerability.collaboratorOrderLostAfterSuccessfulRestore, true);
  assert.equal(result.fixed.collaboratorCollapsePreserved, true);
  assert.equal(result.fixed.collaboratorOrderPreserved, true);
  assert.equal(result.fixed.dormantPreferencePreservedWhenBackupRestoresShare, true);
  assert.equal(result.fixed.removedShareDoesNotResurrectCollapsedState, true);
  assert.equal(result.fixed.removedShareDoesNotResurrectOrderState, true);
});
