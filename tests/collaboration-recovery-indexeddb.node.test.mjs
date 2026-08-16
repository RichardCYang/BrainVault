import assert from "node:assert/strict";
import test from "node:test";
import { createCollaborationRecoveryStore } from "../public/collaboration-recovery-store.js";

class ObjectStorage {
  values = new Map();
  get length() { return this.values.size; }
  key(index) { return [...this.values.keys()][index] ?? null; }
  getItem(key) { return typeof this.values.get(key) === "string" ? this.values.get(key) : null; }
  getObject(key) { return this.values.has(key) ? structuredClone(this.values.get(key)) : null; }
  setItem(key, value) { this.values.set(key, String(value)); }
  setObject(key, value) { this.values.set(key, structuredClone(value)); }
  removeItem(key) { this.values.delete(key); }
  async flush() { await Promise.resolve(); }
}

test("collaboration recovery uses binary structured-clone storage and reloads the exact bytes", async () => {
  const storage = new ObjectStorage();
  const recovery = createCollaborationRecoveryStore(storage);
  const update = new Uint8Array(6 * 1024 * 1024);
  update[0] = 23;
  update[update.length - 1] = 77;

  const generation = await recovery.save("acct", "page", "tab", "epoch", update);
  assert.equal(typeof generation, "string");

  const records = recovery.loadAll("acct", "page");
  assert.equal(records.length, 1);
  assert.equal(records[0].generation, generation);
  assert.equal(records[0].update.byteLength, update.byteLength);
  assert.equal(records[0].update[0], 23);
  assert.equal(records[0].update[records[0].update.length - 1], 77);
  assert.equal(records[0].encodedUpdate, null);
});
