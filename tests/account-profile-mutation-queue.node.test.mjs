import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAccountProfileMutationQueue } from "../public/account-profile-mutation-queue.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("profile mutations run in enqueue order even when a later operation can finish first", async () => {
  const targetKey = "user:user-one";
  const firstGate = deferred();
  const secondGate = deferred();
  const events = [];
  let currentTargetKey = targetKey;
  const queue = createAccountProfileMutationQueue({
    getCurrentTargetKey: () => currentTargetKey
  });

  const first = queue.enqueue(targetKey, async () => {
    events.push("first:start");
    await firstGate.promise;
    events.push("first:end");
    return "first";
  });
  const second = queue.enqueue(targetKey, async () => {
    events.push("second:start");
    await secondGate.promise;
    events.push("second:end");
    return "second";
  });

  await Promise.resolve();
  secondGate.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["first:start"]);

  firstGate.resolve();
  assert.deepEqual(await first, { applied: true, value: "first" });
  assert.deepEqual(await second, { applied: true, value: "second" });
  assert.deepEqual(events, ["first:start", "first:end", "second:start", "second:end"]);
  currentTargetKey = null;
});

test("a failed profile mutation does not block the next queued intent", async () => {
  const targetKey = "user:user-one";
  const queue = createAccountProfileMutationQueue({ getCurrentTargetKey: () => targetKey });
  const expected = new Error("rejected");

  await assert.rejects(queue.enqueue(targetKey, async () => {
    throw expected;
  }), expected);
  assert.deepEqual(
    await queue.enqueue(targetKey, async () => "latest"),
    { applied: true, value: "latest" }
  );
});

test("auth invalidation suppresses in-flight results and cancels queued old-account writes", async () => {
  const oldTargetKey = "user:user-one";
  let currentTargetKey = oldTargetKey;
  const gate = deferred();
  let queuedOperationRan = false;
  const queue = createAccountProfileMutationQueue({
    getCurrentTargetKey: () => currentTargetKey
  });

  const inFlight = queue.enqueue(oldTargetKey, async () => {
    await gate.promise;
    throw new Error("old-account-error");
  });
  const queued = queue.enqueue(oldTargetKey, async () => {
    queuedOperationRan = true;
    return "must-not-run";
  });

  await Promise.resolve();
  currentTargetKey = "user:user-two";
  queue.invalidate();
  gate.resolve();

  assert.deepEqual(await inFlight, { applied: false });
  assert.deepEqual(await queued, { applied: false });
  assert.equal(queuedOperationRan, false);
});

test("auth invalidation detaches a new account from a stalled old-account mutation", async () => {
  const oldTargetKey = "user:user-one";
  const newTargetKey = "user:user-two";
  let currentTargetKey = oldTargetKey;
  const oldGate = deferred();
  let newOperationRan = false;
  const queue = createAccountProfileMutationQueue({
    getCurrentTargetKey: () => currentTargetKey
  });

  const oldMutation = queue.enqueue(oldTargetKey, async () => {
    await oldGate.promise;
    return "old-account-result";
  });

  await Promise.resolve();
  currentTargetKey = newTargetKey;
  queue.invalidate();

  const newMutation = queue.enqueue(newTargetKey, async () => {
    newOperationRan = true;
    return "new-account-result";
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(newOperationRan, true);
  assert.deepEqual(await newMutation, { applied: true, value: "new-account-result" });

  oldGate.resolve();
  assert.deepEqual(await oldMutation, { applied: false });
});

test("account profile callers share one authenticated mutation queue", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  assert.match(app, /createAccountProfileMutationQueue/);
  assert.match(app, /const accountLanguageOperationGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /const accountThemeOperationGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /async function enqueueAccountProfilePatch\(/);
  assert.equal((app.match(/api\("\/api\/auth\/profile"/g) ?? []).length, 1);
  assert.ok((app.match(/enqueueAccountProfilePatch\(/g) ?? []).length >= 5);
  assert.match(app, /accountProfileMutationQueue\.invalidate\(\);/);

  const enqueueStart = app.indexOf("async function enqueueAccountProfilePatch");
  const enqueueEnd = app.indexOf("async function loadNavigationPreferences", enqueueStart);
  const enqueueSource = app.slice(enqueueStart, enqueueEnd);
  const captureScope = enqueueSource.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const beforeAwait = enqueueSource.indexOf('if (typeof before === "function") await before()');
  const postBeforeFence = enqueueSource.indexOf(
    "if (!isCurrentAuthenticatedSessionScope(authenticationScope)) return null;",
    beforeAwait
  );
  const profileRequest = enqueueSource.indexOf('return api("/api/auth/profile"', postBeforeFence);
  assert.ok(
    captureScope >= 0 && beforeAwait > captureScope && postBeforeFence > beforeAwait && profileRequest > postBeforeFence,
    "profile mutations must revalidate the initiating auth generation after queued pre-save waits and before sending the request"
  );
});

test("standalone reproduction proves the preference ordering regression and correction", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-preference-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.latestSelectionLost, true);
  assert.equal(result.vulnerable.finalTheme, "dark");
  assert.equal(result.fixed.latestSelectionPreserved, true);
  assert.equal(result.fixed.finalTheme, "light");
  assert.equal(result.fixed.laterWriteStartedBeforeEarlierCompleted, false);
});


test("standalone reproduction proves auth-boundary queue isolation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-profile-auth-boundary-stall.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newAccountStartedBeforeOldRelease, false);
  assert.equal(result.vulnerable.newAccountBlockedByOldGeneration, true);
  assert.equal(result.fixed.newAccountStartedBeforeOldRelease, true);
  assert.equal(result.fixed.newAccountBlockedByOldGeneration, false);
  assert.deepEqual(result.fixed.oldResult, { applied: false });
  assert.deepEqual(result.fixed.newResult, { applied: true, value: "new-account-result" });
});
