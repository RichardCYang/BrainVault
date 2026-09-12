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

function assertBefore(source, first, second, message) {
  const firstIndex = source.indexOf(first);
  const secondIndex = source.indexOf(second);
  assert.ok(firstIndex >= 0, `missing first marker: ${first}`);
  assert.ok(secondIndex >= 0, `missing second marker: ${second}`);
  assert.ok(firstIndex < secondIndex, message);
}

test("recovery upload batches stay bound to the account and auth generation that selected them", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const reconciliation = section(
    source,
    "async function reconcileServerRecoveryCandidates()",
    "\nfunction getCollaborativePageDrafts"
  );

  assert.match(source, /let recoveryCandidateSyncTask = null;/);
  assert.doesNotMatch(source, /let recoveryCandidateSyncPromise = null;/);
  assert.match(reconciliation, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.match(reconciliation, /if \(!isCurrentAuthenticatedSessionScope\(authenticationScope\)\) return;/);
  assert.match(
    reconciliation,
    /existingTask\.accountId === accountId[\s\S]*isCurrentAuthenticatedSessionScope\(existingTask\.authenticationScope\)/
  );
  assert.match(
    reconciliation,
    /recoveryCandidateSyncTask === task[\s\S]*state\.user\?\.id === accountId[\s\S]*isCurrentAuthenticatedSessionScope\(authenticationScope\)/
  );
  assert.ok(
    (reconciliation.match(/if \(!isCurrentRecoveryCandidateSync\(\)\) return;/g) ?? []).length >= 7,
    "every async phase of recovery upload/list reconciliation must fail closed after an auth change"
  );
  assert.match(
    reconciliation,
    /\.finally\(\(\) => \{\s*if \(recoveryCandidateSyncTask === task\) recoveryCandidateSyncTask = null;/
  );
});

test("a newer login can start its own recovery sync while the older task self-cancels", () => {
  const accountA = { id: "account-a", generation: 4 };
  const accountB = { id: "account-b", generation: 5 };
  let current = accountA;
  let activeTask = null;

  function currentScope(scope) {
    return scope.id === current.id && scope.generation === current.generation;
  }

  function startFixedSync(account) {
    const existing = activeTask;
    if (existing && existing.accountId === account.id && currentScope(existing.scope)) {
      return existing;
    }
    const task = { accountId: account.id, scope: { ...account } };
    activeTask = task;
    task.isCurrent = () => activeTask === task && currentScope(task.scope);
    return task;
  }

  const oldTask = startFixedSync(accountA);
  current = accountB;
  const newTask = startFixedSync(accountB);

  assert.notEqual(newTask, oldTask, "the new account must not inherit the old account's in-flight promise");
  assert.equal(oldTask.isCurrent(), false, "the older upload loop must stop before dispatching another record");
  assert.equal(newTask.isCurrent(), true, "the new account must be able to reconcile immediately");
});

test("recovery candidate download fences credential dispatch, response bytes, digest, and click to one auth scope", async () => {
  const source = (await readFile(appUrl, "utf8")).replace(/\r\n/g, "\n");
  const download = section(
    source,
    "async function downloadServerRecoveryCandidate(candidate)",
    "\nfunction appendServerRecoveryCandidatePanel"
  );

  assert.match(download, /const authenticationScope = captureAuthenticatedSessionScope\(\);/);
  assert.ok(
    (download.match(/assertCurrentAuthenticatedSessionScope\(authenticationScope\)/g) ?? []).length >= 6,
    "download must revalidate the initiating auth scope around every yielding phase"
  );
  assertBefore(
    download,
    "await applyClientNetworkVerificationHeaders(headers)",
    "const response = await fetch(",
    "network verification must finish before the final pre-dispatch auth fence"
  );
  const verificationIndex = download.indexOf("await applyClientNetworkVerificationHeaders(headers)");
  const fetchIndex = download.indexOf("const response = await fetch(");
  const fenceBetweenVerificationAndFetch = download.indexOf(
    "assertCurrentAuthenticatedSessionScope(authenticationScope)",
    verificationIndex
  );
  assert.ok(
    fenceBetweenVerificationAndFetch > verificationIndex && fenceBetweenVerificationAndFetch < fetchIndex,
    "credentialed fetch must be fenced after asynchronous network-signal collection"
  );
  assertBefore(
    download,
    "const bytes = await response.arrayBuffer()",
    "const actualSha256 = await sha256BytesHex(bytes)",
    "response bytes must be read before integrity verification"
  );
  const digestIndex = download.indexOf("const actualSha256 = await sha256BytesHex(bytes)");
  const clickIndex = download.indexOf("download.click()");
  const finalFenceIndex = download.lastIndexOf("assertCurrentAuthenticatedSessionScope(authenticationScope)");
  assert.ok(digestIndex < finalFenceIndex && finalFenceIndex < clickIndex, "stale bytes must never reach the download sink");
});
