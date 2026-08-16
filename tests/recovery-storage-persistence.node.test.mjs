import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createRecoveryStoragePersistenceGuard } from "../public/recovery-storage-persistence.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

test("already-persistent origins do not request persistence again", async () => {
  let persistCalls = 0;
  const guard = createRecoveryStoragePersistenceGuard({
    async persisted() { return true; },
    async persist() { persistCalls += 1; return true; }
  });

  assert.equal(await guard.ensurePersistent(), true);
  assert.equal(guard.isPersistent(), true);
  assert.equal(persistCalls, 0);
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
  assert.match(client, /normalizedMode === pageModes\.WRITE && !recoveryStoragePersistence\.isPersistent\(\)/);
  assert.match(client, /await recoveryStoragePersistence\.ensurePersistent\(\)/);
  assert.match(client, /state\.pageMode = pageModes\.READ;/);
  assert.match(client, /status\.durableRecoveryStorageUnavailable/);
  assert.match(client, /await recoveryStoragePersistence\.refresh\(\)/);
});
