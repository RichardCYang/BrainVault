import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { shouldFlushCollaborationMaterialization } from "../public/collaboration-exit-guard.js";

const source = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

function sourceSection(startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start);
  assert.notEqual(start, -1, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source marker after ${startMarker}: ${endMarker}`);
  return source.slice(start, end);
}

function schedulerSource() {
  const start = source.indexOf("function schedulePageViewHydration(");
  const end = source.indexOf("\nfunction syncPageModeUi(", start);
  assert.notEqual(start, -1, "page-view hydration scheduler must exist");
  assert.ok(end > start, "page-view hydration scheduler must have a complete body");
  return source.slice(start, end);
}

function createHydrationHarness() {
  const factory = new Function(`
    const state = { selectedPage: { id: "page-1" }, workspaceView: "page" };
    const elements = { pageView: {} };
    let pageViewHydrationFrame = null;
    let pageViewHydrationRequest = {
      syncAiChatTextareaHeights: false,
      hydrateAccordionIcons: false,
      focusPendingBlock: false
    };
    let queuedFrame = null;
    const counts = {
      frames: 0,
      ai: 0,
      code: 0,
      math: 0,
      mermaid: 0,
      accordion: 0,
      focus: 0
    };
    const window = {
      requestAnimationFrame(callback) {
        counts.frames += 1;
        queuedFrame = callback;
        return counts.frames;
      }
    };
    function isPageReadOnly() { return true; }
    function syncAiChatTextareaHeights() { counts.ai += 1; }
    function hydrateHighlightedCodeBlocks() { counts.code += 1; }
    function hydrateMathExpressions() { counts.math += 1; }
    function hydrateMermaidPreviews() { counts.mermaid += 1; }
    function hydrateAccordionIcons() { counts.accordion += 1; }
    function focusPendingBlock() { counts.focus += 1; }
    ${schedulerSource()}
    return {
      schedule: schedulePageViewHydration,
      setWorkspaceView(value) { state.workspaceView = value; },
      flushFrame() {
        const callback = queuedFrame;
        queuedFrame = null;
        callback?.();
      },
      counts() { return { ...counts }; }
    };
  `);
  return factory();
}

test("page presentation hydration coalesces repeated render/status requests into one animation frame", () => {
  const harness = createHydrationHarness();
  for (let i = 0; i < 100; i += 1) {
    harness.schedule({
      syncAiChatTextareaHeights: true,
      hydrateAccordionIcons: true,
      focusPendingBlock: true
    });
  }

  assert.deepEqual(harness.counts(), {
    frames: 1,
    ai: 0,
    code: 0,
    math: 0,
    mermaid: 0,
    accordion: 0,
    focus: 0
  });

  harness.flushFrame();
  assert.deepEqual(harness.counts(), {
    frames: 1,
    ai: 0,
    code: 1,
    math: 1,
    mermaid: 1,
    accordion: 1,
    focus: 1
  });
});

test("stale scheduled page hydration becomes a no-op after leaving the page workspace", () => {
  const harness = createHydrationHarness();
  harness.schedule({ hydrateAccordionIcons: true, focusPendingBlock: true });
  harness.setWorkspaceView("home");
  harness.flushFrame();

  assert.deepEqual(harness.counts(), {
    frames: 1,
    ai: 0,
    code: 0,
    math: 0,
    mermaid: 0,
    accordion: 0,
    focus: 0
  });
});

test("mode/status synchronization no longer schedules an unconditional full-page hydration pass", () => {
  const sync = sourceSection("function syncPageModeUi(", "\nfunction hasPendingPageEdits(");
  assert.doesNotMatch(sync, /requestAnimationFrame\s*\(/);
  assert.match(sync, /if \(blockControlStateChanged\)/);
  assert.match(sync, /if \(readOnly && presentationHydrationChanged\)/);
  assert.match(sync, /if \(presentationHydrationChanged\)/);

  const render = sourceSection("function renderSelectedPage()", "\nfunction normalizePageTitle(");
  assert.match(render, /syncPageModeUi\(\{ contentRebuilt: true, focusPending: true \}\)/);
  assert.doesNotMatch(render, /requestAnimationFrame\s*\(\(\) => \{\s*hydrateMathExpressions/);
});

test("collaboration exit materialization is skipped when the synchronized snapshot is already clean", () => {
  assert.equal(shouldFlushCollaborationMaterialization(null), false);
  assert.equal(shouldFlushCollaborationMaterialization({ isReady: false, hasPendingChanges: true }), false);
  assert.equal(shouldFlushCollaborationMaterialization({ isReady: true, hasPendingChanges: false }), false);
  assert.equal(shouldFlushCollaborationMaterialization({ isReady: true, hasPendingChanges: true }), true);

  const flush = sourceSection("async function flushPendingPageEdits(", "\nfunction applyMaterializedHtmlCaches(");
  assert.match(flush, /shouldFlushCollaborationMaterialization\(session\)/);
  assert.doesNotMatch(flush, /const materialization = session\?\.isReady\s*\?/);
});
