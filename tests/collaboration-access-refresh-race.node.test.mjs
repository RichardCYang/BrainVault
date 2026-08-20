import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("collaboration access refresh stays bound to the session generation that requested it", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
  const start = app.indexOf("async function handleCollaborationAccessChanged");
  const end = app.indexOf("async function startPageCollaboration", start);
  assert.ok(start >= 0 && end > start);
  const source = app.slice(start, end);

  const capture = source.indexOf("const refreshGeneration = generation + 1;");
  const teardown = source.indexOf("await destroyPageCollaboration({ flush: false });");
  const firstFence = source.indexOf(
    "if (refreshGeneration !== state.collaborationGeneration || state.selectedPage?.id !== pageId) return;",
    teardown
  );
  const request = source.indexOf("const data = await api(", firstFence);
  const resultFence = source.indexOf(
    "if (refreshGeneration !== state.collaborationGeneration || state.selectedPage?.id !== pageId) return;",
    request
  );
  const catchStart = source.indexOf("} catch {", resultFence);
  const failureFence = source.indexOf(
    "if (refreshGeneration !== state.collaborationGeneration || state.selectedPage?.id !== pageId) return;",
    catchStart
  );
  const reload = source.indexOf("await loadPages(", failureFence);
  const postReloadFence = source.indexOf(
    "if (refreshGeneration !== state.collaborationGeneration || state.selectedPage?.id !== pageId) return;",
    reload
  );
  const home = source.indexOf("await showHome({ skipFlush: true });", postReloadFence);

  assert.ok(capture >= 0 && capture < teardown, "capture the expected successor before teardown can yield");
  assert.ok(firstFence > teardown && firstFence < request, "stop stale refreshes after teardown");
  assert.ok(resultFence > request && resultFence < catchStart, "stop stale successful responses");
  assert.ok(failureFence > catchStart && failureFence < reload, "stop stale failures before list refresh");
  assert.ok(postReloadFence > reload && postReloadFence < home, "stop navigation that races the list refresh");
});

test("standalone reproduction proves page-id-only access refreshes can clobber a same-page reopen", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-collaboration-access-refresh-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.staleRefreshOverwroteNewerSnapshot, true);
  assert.equal(result.vulnerable.staleSessionStarted, true);
  assert.equal(result.vulnerable.staleFailureForcedHome, true);
  assert.equal(result.vulnerable.staleRequestSurvivedNewerNavigation, true);

  assert.equal(result.fixed.newerSnapshotPreserved, true);
  assert.equal(result.fixed.staleSessionSuppressed, true);
  assert.equal(result.fixed.staleFailureSuppressed, true);
  assert.equal(result.fixed.staleRequestSuppressedAfterTeardown, true);
});
