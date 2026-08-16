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

test("cached persistence is revalidated and a later revocation fails closed", async () => {
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

test("best-effort storage must be promoted before editing becomes durable", async () => {
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

test("denied or unavailable persistence fails closed", async () => {
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

test("the app gates effective write mode and write transitions on persistent recovery storage", () => {
  assert.match(client, /function isPageReadOnly\(\) \{\n  return state\.pageMode !== pageModes\.WRITE \|\| !recoveryStoragePersistence\.isPersistent\(\);/);
  assert.match(client, /if \(normalizedMode === pageModes\.WRITE\) \{/);
  assert.match(client, /await recoveryStoragePersistence\.ensurePersistent\(\)/);
  assert.match(client, /recoveryStoragePersistence\.subscribe\(handleRecoveryStoragePersistenceChange\)/);
  assert.match(client, /state\.pageModeChanging = true;[\s\S]*flushPendingPageEdits\(\{ allowLocked: true, collaborationCompact: false \}\)[\s\S]*state\.pageMode = pageModes\.READ;/);
  assert.match(client, /window\.addEventListener\("focus", revalidateRecoveryStoragePersistence\)/);
  assert.match(client, /window\.addEventListener\("pageshow", revalidateRecoveryStoragePersistence\)/);
  assert.match(client, /await recoveryStoragePersistence\.monitorPermission\(\)/);
  assert.match(client, /state\.pageMode = pageModes\.READ;/);
  assert.match(client, /status\.durableRecoveryStorageUnavailable/);
  assert.match(client, /await recoveryStoragePersistence\.refresh\(\)/);
});
