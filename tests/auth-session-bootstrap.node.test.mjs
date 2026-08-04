import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

import { restoreSessionAtBoot } from "../public/session-bootstrap.js";

function createState() {
  return { authenticated: false, user: null };
}

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

test("the browser boot path delegates session restoration before loading pages", () => {
  assert.match(appSource, /import \{ restoreSessionAtBoot \} from "\.\/session-bootstrap\.js";/);
  assert.match(
    appSource,
    /restoreSessionAtBoot\(state, \{[\s\S]*loadUser: loadMe,[\s\S]*initializeAuthenticatedUi:[\s\S]*loadWorkspace: loadPages[\s\S]*\}\)/
  );
  assert.doesNotMatch(
    appSource,
    /await loadMe\(\);[\s\S]{0,200}renderShell\(\);[\s\S]{0,100}await loadPages\(\)/
  );
});

test("restored cookie sessions enter the authenticated shell", async () => {
  const state = createState();
  const calls = [];
  const user = { id: "usr_boot", username: "restored-user" };

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => user,
    initializeAuthenticatedUi: async (restoredUser) => calls.push(["ui", restoredUser]),
    loadWorkspace: async () => calls.push(["workspace"])
  });

  assert.equal(result.outcome, "ready");
  assert.equal(state.authenticated, true);
  assert.equal(state.user, user);
  assert.deepEqual(calls, [["ui", user], ["workspace"]]);
});

test("a transient workspace failure does not discard a valid session", async () => {
  const state = createState();
  const user = { id: "usr_boot", username: "restored-user" };
  const workspaceError = Object.assign(new Error("pages temporarily unavailable"), { status: 503 });

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => user,
    initializeAuthenticatedUi: async () => {},
    loadWorkspace: async () => {
      throw workspaceError;
    }
  });

  assert.equal(result.outcome, "workspace-unavailable");
  assert.equal(result.error, workspaceError);
  assert.equal(state.authenticated, true);
  assert.equal(state.user, user);
});

test("only an explicit 401 is classified as an unauthenticated session", async () => {
  for (const [status, expectedOutcome] of [[401, "unauthenticated"], [0, "session-unavailable"], [500, "session-unavailable"]]) {
    const state = createState();
    let initialized = false;
    const result = await restoreSessionAtBoot(state, {
      loadUser: async () => {
        throw Object.assign(new Error(`session failure ${status}`), { status });
      },
      initializeAuthenticatedUi: async () => {
        initialized = true;
      },
      loadWorkspace: async () => {}
    });

    assert.equal(result.outcome, expectedOutcome);
    assert.equal(state.authenticated, false);
    assert.equal(state.user, null);
    assert.equal(initialized, false);
  }
});

test("failed authenticated UI initialization rolls back partial state", async () => {
  const state = createState();
  const initializationError = new Error("UI initialization failed");

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => ({ id: "usr_boot" }),
    initializeAuthenticatedUi: async () => {
      throw initializationError;
    },
    loadWorkspace: async () => assert.fail("workspace must not load after initialization failure")
  });

  assert.equal(result.outcome, "session-unavailable");
  assert.equal(result.error, initializationError);
  assert.equal(state.authenticated, false);
  assert.equal(state.user, null);
});
