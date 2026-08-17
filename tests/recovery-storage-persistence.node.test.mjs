import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRecoveryStoragePersistenceGuard } from "../public/recovery-storage-persistence.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("already-persistent origins are revalidated without requesting persistence again", async () => {
  let persistedCalls = 0;
  let persistCalls = 0;
  const guard = createRecoveryStoragePersistenceGuard({
    async persisted() { persistedCalls += 1; return true; },
    async persist() { persistCalls += 1; return true; }
  });

  assert.equal(await guard.ensurePersistent(), true);
  assert.equal(await guard.ensurePersistent(), true);
  assert.equal(guard.isPersistent(), true);
  assert.equal(persistedCalls, 2);
  assert.equal(persistCalls, 0);
});

test("cached persistence is revalidated and a later revocation is reported", async () => {
  let persisted = true;
  let persistedCalls = 0;
  let persistCalls = 0;
  const guard = createRecoveryStoragePersistenceGuard({
    async persisted() { persistedCalls += 1; return persisted; },
    async persist() { persistCalls += 1; return false; }
  });

  assert.equal(await guard.ensurePersistent(), true);
  persisted = false;
  assert.equal(await guard.ensurePersistent(), false);
  assert.equal(guard.isPersistent(), false);
  assert.equal(persistedCalls, 2);
  assert.equal(persistCalls, 1);
});

test("permission changes refresh the cached persistence state when supported", async () => {
  let persisted = true;
  let changeListener = null;
  const guard = createRecoveryStoragePersistenceGuard(
    {
      async persisted() { return persisted; },
      async persist() { return false; }
    },
    {
      async query(descriptor) {
        assert.deepEqual(descriptor, { name: "persistent-storage" });
        return {
          addEventListener(type, listener) {
            assert.equal(type, "change");
            changeListener = listener;
          }
        };
      }
    }
  );

  await guard.refresh();
  assert.equal(guard.isPersistent(), true);
  assert.equal(await guard.monitorPermission(), true);
  persisted = false;
  changeListener();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.isPersistent(), false);
});

test("best-effort storage is promoted when the browser grants persistence", async () => {
  let persisted = false;
  let persistCalls = 0;
  const guard = createRecoveryStoragePersistenceGuard({
    async persisted() { return persisted; },
    async persist() { persistCalls += 1; persisted = true; return true; }
  });

  assert.equal(await guard.refresh(), false);
  assert.equal(guard.isPersistent(), false);
  assert.equal(await guard.ensurePersistent(), true);
  assert.equal(guard.isPersistent(), true);
  assert.equal(persistCalls, 1);
});

test("denied or unavailable persistence is reported without being misclassified as a write failure", async () => {
  const denied = createRecoveryStoragePersistenceGuard({
    async persisted() { return false; },
    async persist() { return false; }
  });
  assert.equal(await denied.ensurePersistent(), false);
  assert.equal(denied.isPersistent(), false);

  const unavailable = createRecoveryStoragePersistenceGuard({});
  assert.equal(await unavailable.ensurePersistent(), false);
  assert.equal(unavailable.isPersistent(), false);
});

test("the app allows session-scoped editing while still gating writes on strict recovery storage", () => {
  assert.match(
    client,
    /function isRecoveryStorageWritable\(\) \{[\s\S]*indexedDbRecoveryStorage && !recoveryStorageWriteFailure/
  );
  assert.match(
    client,
    /function isPageReadOnly\(\) \{[\s\S]*state\.pageMode !== pageModes\.WRITE \|\| !isRecoveryStorageWritable\(\)/
  );
  assert.match(client, /if \(normalizedMode === pageModes\.WRITE\) \{/);
  assert.match(client, /await recoveryStoragePersistence\.ensurePersistent\(\);[\s\S]*if \(!isRecoveryStorageWritable\(\)\)/);
  assert.match(client, /status\.sessionRecoveryStorageActive/);
  assert.match(client, /recoveryStoragePersistence\.subscribe\(handleRecoveryStoragePersistenceChange\)/);

  const persistStart = client.indexOf("function canPersistSelectedPage()");
  const persistEnd = client.indexOf("function canEditSelectedPage()", persistStart);
  const persistSource = client.slice(persistStart, persistEnd);
  assert.match(
    persistSource,
    /recoveryDrainAllowed = recoveryStorageFailureDrainInFlight && state\.pageModeChanging/
  );
  assert.match(persistSource, /recoveryWritable = isRecoveryStorageWritable\(\)/);
  assert.match(persistSource, /recoveryWritable \|\| recoveryDrainAllowed/);
  assert.doesNotMatch(persistSource, /recoveryStoragePersistence\.isPersistent/);

  const persistenceStart = client.indexOf("async function handleRecoveryStoragePersistenceChange");
  const persistenceEnd = client.indexOf("function handleDurableRecoveryStorageWriteError", persistenceStart);
  const persistenceSource = client.slice(persistenceStart, persistenceEnd);
  assert.match(persistenceSource, /nextState !== "persistent"/);
  assert.match(persistenceSource, /isRecoveryStorageWritable\(\)/);
  assert.doesNotMatch(persistenceSource, /drainRecoveryStorageFailure\(\)/);
  assert.doesNotMatch(persistenceSource, /state\.pageMode = pageModes\.READ/);

  const drainStart = client.indexOf("async function drainRecoveryStorageFailure()");
  const drainEnd = client.indexOf("async function handleRecoveryStoragePersistenceChange", drainStart);
  const drainSource = client.slice(drainStart, drainEnd);
  const flushIndex = drainSource.indexOf("flushPendingPageEdits({ allowLocked: true, collaborationCompact: false })");
  const pendingIndex = drainSource.indexOf("hasPendingPageEdits()");
  const readIndex = drainSource.indexOf("state.pageMode = pageModes.READ");
  assert.ok(flushIndex >= 0, "write failure must attempt the authoritative server drain");
  assert.ok(pendingIndex > flushIndex, "pending state must be checked after the drain attempt");
  assert.ok(readIndex > pendingIndex, "READ mode must become permanent only after pending edits are gone");
  assert.match(drainSource, /state\.pageModeChanging = true;[\s\S]*throw error;/);

  assert.match(client, /window\.addEventListener\("focus", revalidateRecoveryStoragePersistence\)/);
  assert.match(client, /window\.addEventListener\("pageshow", revalidateRecoveryStoragePersistence\)/);
  assert.match(client, /await recoveryStoragePersistence\.monitorPermission\(\)/);
  assert.match(client, /status\.durableRecoveryStorageUnavailable/);
  assert.match(client, /await recoveryStoragePersistence\.refresh\(\)/);
  assert.match(client, /window\.addEventListener\("online", \(\) => \{[\s\S]*drainRecoveryStorageFailure\(\)/);
});
