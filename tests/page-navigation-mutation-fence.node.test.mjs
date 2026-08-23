import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appUrl = new URL("../public/app.js", import.meta.url);

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start);
  assert.ok(start >= 0 && end > start, `missing source section: ${startNeedle}`);
  return source.slice(start, end);
}

test("page archive stays bound to the confirmed navigation through persistence and fetch preflight waits", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const click = section(
    source,
    'elements.archivePageButton.addEventListener("click"',
    'for (const eventName of ["focusin"'
  );
  const helper = section(
    source,
    "async function archivePageIdempotently",
    'elements.archivePageButton.addEventListener("click"'
  );

  const transitionIndex = click.indexOf('withPagePersistenceTransition(pageId, "page-archive"');
  assert.ok(transitionIndex >= 0);
  assert.match(click, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(click, /const isArchiveIntentCurrent = \(\) =>/);
  assert.match(click, /state\.selectedPage\?\.id === pageId/);

  const flushIndex = click.indexOf("await flushPendingPageEdits");
  const postFlushFenceIndex = click.indexOf("if (!isArchiveIntentCurrent()) return skippedApiRequest;", flushIndex);
  const expectedVersionIndex = click.indexOf("const expectedVersion = state.selectedPage.version;", postFlushFenceIndex);
  const archiveSubmitIndex = click.indexOf("archivePageWithReconciliation", expectedVersionIndex);
  assert.ok(
    flushIndex >= 0
      && postFlushFenceIndex > flushIndex
      && expectedVersionIndex > postFlushFenceIndex
      && archiveSubmitIndex > expectedVersionIndex
  );
  assert.match(click.slice(archiveSubmitIndex, archiveSubmitIndex + 260), /requestGuard: isArchiveIntentCurrent/);
  assert.match(click, /archiveResult === skippedApiRequest/);

  assert.match(helper, /beforeFetch:\s*\(\) => \{/);
  assert.match(helper, /requestGuard\?\.\(\) === false/);
  assert.match(helper, /task\.attempted = true;/);
});

test("sidebar page move cancels an unsubmitted structural write after navigation changes", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const submit = section(
    source,
    "async function submitPageMoveMutation(",
    "function applyPageMoveMutationResult"
  );
  const move = section(
    source,
    "async function moveNavigationPageToParent(",
    "function findPendingPageDeleteTask"
  );
  const form = section(
    source,
    'elements.pageMoveForm.addEventListener("submit"',
    'elements.blockContextMenu.addEventListener("click"'
  );

  assert.match(submit, /beforeFetch:\s*\(\) => \{/);
  assert.match(submit, /requestGuard\?\.\(\) === false/);
  assert.match(move, /navigationGeneration = null/);
  assert.match(move, /const isPageMoveNavigationCurrent = \(\) =>/);

  const unlockWaitIndex = move.indexOf("await assertWorkspacePersistenceUnlocked();");
  const firstFenceIndex = move.indexOf("!isPageMoveNavigationCurrent()", unlockWaitIndex);
  const submitIndex = move.indexOf("submitPageMoveMutation(", firstFenceIndex);
  assert.ok(unlockWaitIndex >= 0 && firstFenceIndex > unlockWaitIndex && submitIndex > firstFenceIndex);
  assert.match(move.slice(submitIndex, submitIndex + 280), /requestGuard: isPageMoveNavigationCurrent/);

  assert.match(form, /const navigationGeneration = workspaceNavigationGeneration;/);
  assert.match(
    form,
    /moveNavigationPageToParent\(sourcePageId, targetPageId, \{[\s\S]*authenticationScope,[\s\S]*navigationGeneration/
  );
  assert.match(form, /!isCurrentWorkspaceNavigation\(navigationGeneration\)/);
});

test("reproduction: equal edit versions let the old archive code archive the page the user already left", () => {
  function simulate({ fixed }) {
    let navigationGeneration = 1;
    let selectedPage = { id: "page-a", version: 1 };
    const pageVersions = new Map([["page-a", 1], ["page-b", 1]]);
    const archived = new Set();

    const pageId = selectedPage.id;
    const capturedNavigation = navigationGeneration;

    // The archive path waits for persistence. During that wait the user opens B.
    navigationGeneration += 1;
    selectedPage = { id: "page-b", version: 1 };

    const intentCurrent =
      navigationGeneration === capturedNavigation
      && selectedPage.id === pageId;
    if (fixed && !intentCurrent) {
      return { requestSent: false, archivedPageA: false, selectedPage: selectedPage.id };
    }

    // Both versions read after the wait; the fix first proves that the same
    // navigation/page is still current, so this read can no longer come from B.
    const expectedVersion = selectedPage.version;
    if (pageVersions.get(pageId) === expectedVersion) archived.add(pageId);
    return {
      requestSent: true,
      archivedPageA: archived.has("page-a"),
      selectedPage: selectedPage.id
    };
  }

  assert.deepEqual(simulate({ fixed: false }), {
    requestSent: true,
    archivedPageA: true,
    selectedPage: "page-b"
  });
  assert.deepEqual(simulate({ fixed: true }), {
    requestSent: false,
    archivedPageA: false,
    selectedPage: "page-b"
  });
});

test("reproduction: old page-move code can submit after the initiating navigation is superseded", () => {
  function simulate({ fixed }) {
    let navigationGeneration = 7;
    const capturedNavigation = navigationGeneration;
    const requests = [];

    // The move waits for workspace persistence / editor flush.
    navigationGeneration += 1;

    if (!fixed || navigationGeneration === capturedNavigation) {
      requests.push({ pageId: "page-a", targetPageId: "page-b" });
    }
    return requests;
  }

  assert.deepEqual(simulate({ fixed: false }), [{ pageId: "page-a", targetPageId: "page-b" }]);
  assert.deepEqual(simulate({ fixed: true }), []);
});
