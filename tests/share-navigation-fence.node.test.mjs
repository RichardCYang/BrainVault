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

test("share dialog remains bound to the navigation that opened it", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const dialog = section(
    source,
    "function isCurrentSharePageRequest(",
    "async function setSelectedPageShareCount"
  );

  assert.match(source, /let sharePageNavigationGeneration = null;/);
  assert.match(dialog, /sharePageNavigationGeneration !== null/);
  assert.match(dialog, /isCurrentWorkspaceNavigation\(sharePageNavigationGeneration\)/);

  const open = section(dialog, "async function openSharePageDialog()", "function closeSharePageDialog");
  const navigationCapture = open.indexOf("const navigationGeneration = workspaceNavigationGeneration;");
  const flush = open.indexOf("await flushPendingPageEdits();");
  const postFlushFence = open.indexOf("!isCurrentWorkspaceNavigation(navigationGeneration)", flush);
  const bindDialog = open.indexOf("sharePageNavigationGeneration = navigationGeneration;", postFlushFence);
  assert.ok(navigationCapture >= 0 && flush > navigationCapture);
  assert.ok(postFlushFence > flush && bindDialog > postFlushFence);

  const close = section(source, "function closeSharePageDialog", "async function setSelectedPageShareCount");
  assert.match(close, /sharePageRequestGeneration \+= 1;/);
  assert.match(close, /sharePageNavigationGeneration = null;/);
});

test("share grants and revocations revalidate dialog, auth, and navigation intent through fetch preflight", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const add = section(
    source,
    'elements.sharePageForm.addEventListener("submit"',
    'elements.sharePageList.addEventListener("click"'
  );
  const remove = section(
    source,
    'elements.sharePageList.addEventListener("click"',
    'document.addEventListener("keydown"'
  );

  for (const handler of [add, remove]) {
    assert.match(handler, /const requestGeneration = sharePageRequestGeneration;/);
    assert.match(handler, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
    assert.match(handler, /const isShareMutationCurrent = \(\) =>/);
    assert.match(handler, /isCurrentAuthenticatedSessionScope\(authenticationScope\)/);
    assert.match(handler, /isCurrentSharePageRequest\(requestGeneration, pageId\)/);
    assert.match(handler, /if \(!isShareMutationCurrent\(\)\) return null;/);
    assert.match(handler, /beforeFetch: isShareMutationCurrent/);
    assert.match(handler, /data === skippedApiRequest \|\| !isShareMutationCurrent\(\)/);
  }

  const addFlush = add.indexOf("await flushPendingPageEdits({ allowLocked: true });");
  assert.ok(add.indexOf("if (!isShareMutationCurrent()) return null;", addFlush) > addFlush);

  const removeFlush = remove.indexOf(
    "await flushPendingPageEdits({ allowLocked: true, collaborationCompact: false });"
  );
  assert.ok(remove.indexOf("if (!isShareMutationCurrent()) return null;", removeFlush) > removeFlush);
  const destroy = remove.indexOf("await destroyPageCollaboration({ flush: false })");
  assert.ok(remove.indexOf("if (!isShareMutationCurrent()) return null;", destroy) > destroy);
  assert.match(remove, /catch \(error\) \{[\s\S]*?if \(!isShareMutationCurrent\(\)\) return;/);
  assert.match(
    remove,
    /finally \{[\s\S]*?button\.isConnected[\s\S]*?isCurrentAuthenticatedSessionScope\(authenticationScope\)[\s\S]*?state\.selectedPage\?\.id === pageId[\s\S]*?isCollaborativePage\(\)[\s\S]*?!state\.collaborationSession[\s\S]*?startPageCollaboration\(state\.selectedPage\)/
  );
});

test("reproduction: superseded sharing intents cannot release an unsent access mutation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-share-navigation-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.dialogOpenGap.vulnerable.dialogWouldOpen, true);
  assert.equal(result.dialogOpenGap.fixed.dialogWouldOpen, false);
  assert.equal(result.persistenceTransitionGap.vulnerable.requestWouldStart, true);
  assert.equal(result.persistenceTransitionGap.fixed.requestWouldStart, false);
  assert.equal(result.fetchPreflightGap.vulnerable.requestReachedFetch, true);
  assert.equal(result.fetchPreflightGap.fixed.requestReachedFetch, false);
});
