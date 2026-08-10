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
  const bootStart = appSource.indexOf("async function boot()");
  const bootEnd = appSource.indexOf("async function openHomeFromBrand", bootStart);
  assert.ok(bootStart >= 0 && bootEnd > bootStart);
  const bootSource = appSource.slice(bootStart, bootEnd);
  assert.match(bootSource, /const operation = beginAuthFlowOperation\(\);/);
  assert.match(bootSource, /const isCurrent = \(\) => isCurrentAuthFlowOperation\(operation\);/);
  assert.match(bootSource, /restoreSessionAtBoot\(state, \{[\s\S]*loadUser: loadMe,[\s\S]*isCurrent,[\s\S]*initializeAuthenticatedUi:/);
  assert.match(bootSource, /loadWorkspace: async \(\) => \{[\s\S]*fetchAllPageSummaries\(\)[\s\S]*if \(!isCurrent\(\)\) return;/);
  assert.match(bootSource, /result\.outcome === "superseded"[\s\S]*renderShell\(\);/);
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

test("authentication denials, including country-policy blocks, are classified as unauthenticated", async () => {
  for (const [status, code, expectedOutcome] of [
    [401, null, "unauthenticated"],
    [403, "COUNTRY_LOGIN_BLOCKED", "unauthenticated"],
    [403, "ORIGIN_NOT_ALLOWED", "session-unavailable"],
    [0, null, "session-unavailable"],
    [500, null, "session-unavailable"]
  ]) {
    const state = createState();
    let initialized = false;
    const result = await restoreSessionAtBoot(state, {
      loadUser: async () => {
        throw Object.assign(new Error(`session failure ${status}`), { status, code });
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

test("a boot restoration superseded before commit leaves current state untouched", async () => {
  const existingUser = { id: "usr_existing" };
  const state = { authenticated: true, user: existingUser };
  let current = true;

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => {
      current = false;
      return { id: "usr_boot" };
    },
    initializeAuthenticatedUi: async () => assert.fail("superseded boot must not initialize UI"),
    loadWorkspace: async () => assert.fail("superseded boot must not load workspace"),
    isCurrent: () => current
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(state.authenticated, true);
  assert.equal(state.user, existingUser);
});

test("a boot restoration superseded during UI initialization rolls back only its own user", async () => {
  const state = createState();
  let current = true;

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => ({ id: "usr_boot" }),
    initializeAuthenticatedUi: async () => {
      current = false;
    },
    loadWorkspace: async () => assert.fail("superseded boot must not load workspace"),
    isCurrent: () => current
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(state.authenticated, false);
  assert.equal(state.user, null);
});

test("a superseded boot never rolls back a newer login that already committed", async () => {
  const state = createState();
  const newerUser = { id: "usr_newer" };
  let current = true;

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => ({ id: "usr_boot" }),
    initializeAuthenticatedUi: async () => {
      state.authenticated = true;
      state.user = newerUser;
      current = false;
    },
    loadWorkspace: async () => assert.fail("superseded boot must not load workspace"),
    isCurrent: () => current
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(state.authenticated, true);
  assert.equal(state.user, newerUser);
});

test("a boot restoration superseded during workspace load removes its partial session", async () => {
  const state = createState();
  let current = true;

  const result = await restoreSessionAtBoot(state, {
    loadUser: async () => ({ id: "usr_boot" }),
    initializeAuthenticatedUi: async () => {},
    loadWorkspace: async () => {
      current = false;
    },
    isCurrent: () => current
  });

  assert.equal(result.outcome, "superseded");
  assert.equal(state.authenticated, false);
  assert.equal(state.user, null);
});
