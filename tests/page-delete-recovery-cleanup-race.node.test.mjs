import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("page delete never clears recovery created after its destructive boundary", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const deletion = section(source, "async function deleteNavigationTarget()", "\nfunction renderCollectionView");

  const recoveryFenceIndex = deletion.indexOf(
    'assertNoPendingLocalPageDraftsForPages(serverPageIds, "status.destructiveLocalDraftsPending");'
  );
  const submitIndex = deletion.indexOf(
    "return submitPageDeleteTask(task, authenticationScope, {",
    recoveryFenceIndex
  );
  const responseFenceIndex = deletion.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return;",
    submitIndex
  );

  assert.ok(recoveryFenceIndex >= 0, "page delete must fail closed on pre-existing local recovery");
  assert.ok(
    submitIndex > recoveryFenceIndex,
    "the empty-recovery fence must run immediately before the destructive request"
  );
  assert.ok(
    responseFenceIndex > submitIndex,
    "response application must remain behind the authentication-generation fence"
  );
  assert.doesNotMatch(
    deletion.slice(submitIndex),
    /pageDraftStore\.removePage(?:s|IfUnchanged)?\(/,
    "any page recovery visible after dispatch is newer than the delete intent and must be preserved"
  );
});

test("standalone reproduction preserves a page draft created after delete dispatch", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-delete-recovery-cleanup-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newerDraftPreserved, false);
  assert.equal(result.vulnerable.title, null);
  assert.equal(result.fixed.newerDraftPreserved, true);
  assert.equal(result.fixed.title, "recovery written after page delete dispatch");
});
