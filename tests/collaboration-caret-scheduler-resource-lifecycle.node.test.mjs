import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
const start = source.indexOf("function scheduleRemoteCollaborationCaretRender() {");
assert.notEqual(start, -1, "remote collaboration caret scheduler must exist");
const schedulerMatch = /^function scheduleRemoteCollaborationCaretRender\(\) \{[\s\S]*?^\}/m.exec(source.slice(start));
assert.ok(schedulerMatch, "remote collaboration caret scheduler must have a complete body");
const schedulerSource = schedulerMatch[0];

function createHarness({ workspaceView = "page", collaborationEnabled = false, selectedPage = true } = {}) {
  const factory = new Function(`
    const state = {
      workspaceView: ${JSON.stringify(workspaceView)},
      selectedPage: ${selectedPage ? `{ collaboration: { enabled: ${collaborationEnabled} } }` : "null"}
    };
    let collaborationCaretRenderFrame = null;
    let queuedFrame = null;
    let requestAnimationFrameCalls = 0;
    let renderCalls = 0;
    const window = {
      requestAnimationFrame(callback) {
        requestAnimationFrameCalls += 1;
        queuedFrame = callback;
        return requestAnimationFrameCalls;
      }
    };
    function isCollaborativePage(page = state.selectedPage) {
      return Boolean(page?.collaboration?.enabled);
    }
    function renderRemoteCollaborationCarets() {
      collaborationCaretRenderFrame = null;
      renderCalls += 1;
    }
    ${schedulerSource}
    return {
      schedule: scheduleRemoteCollaborationCaretRender,
      flushFrame() {
        const callback = queuedFrame;
        queuedFrame = null;
        callback?.();
      },
      counts() { return { requestAnimationFrameCalls, renderCalls }; }
    };
  `);
  return factory();
}

test("non-collaborative scroll/resize traffic does not schedule remote-caret animation frames", () => {
  const harness = createHarness({ collaborationEnabled: false });
  for (let frame = 0; frame < 3_600; frame += 1) {
    harness.schedule();
    harness.flushFrame();
  }
  assert.deepEqual(harness.counts(), { requestAnimationFrameCalls: 0, renderCalls: 0 });
});

test("remote-caret scheduling remains active on collaborative pages and still coalesces within a frame", () => {
  const harness = createHarness({ collaborationEnabled: true });
  for (let frame = 0; frame < 120; frame += 1) {
    for (let event = 0; event < 8; event += 1) harness.schedule();
    harness.flushFrame();
  }
  assert.deepEqual(harness.counts(), { requestAnimationFrameCalls: 120, renderCalls: 120 });
});

test("non-page workspace views do not schedule remote-caret frames even if the selected page is collaboration-enabled", () => {
  const harness = createHarness({ workspaceView: "collection", collaborationEnabled: true });
  for (let frame = 0; frame < 240; frame += 1) {
    harness.schedule();
    harness.flushFrame();
  }
  assert.deepEqual(harness.counts(), { requestAnimationFrameCalls: 0, renderCalls: 0 });
});
