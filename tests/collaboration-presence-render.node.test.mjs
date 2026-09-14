import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const appSource = readFileSync(resolve(here, "../public/app.js"), "utf8");

test("collaboration presence callback avoids a full chrome rebuild for caret-only awareness changes", () => {
  const start = appSource.indexOf("onPresence: (presence) => {");
  const end = appSource.indexOf("onStatus: (status) => {", start);
  assert.notEqual(start, -1, "collaboration onPresence callback must exist");
  assert.notEqual(end, -1, "collaboration onStatus callback must follow onPresence");

  const callback = appSource.slice(start, end);
  assert.match(callback, /const previousPresence = state\.collaborationPresence;/);
  assert.match(callback, /hasRemotePresenceDecorationChanges\(previousPresence, presence\)/);
  assert.match(callback, /renderCollaborationChrome\(\);/);
  assert.match(callback, /scheduleRemoteCollaborationCaretRender\(\);/);
  assert.ok(
    callback.indexOf("hasRemotePresenceDecorationChanges") < callback.indexOf("renderCollaborationChrome();"),
    "full chrome rendering must be gated by the semantic presence comparison"
  );
});
