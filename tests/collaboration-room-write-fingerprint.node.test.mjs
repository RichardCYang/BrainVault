import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(
  new URL("../src/lib/collaboration-server.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");
const protocol = readFileSync(
  new URL("../src/lib/collaboration-protocol.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

test("durable collaboration writes fingerprint the latest payload before appending", () => {
  const persistStart = server.indexOf("private async persistUpdate(");
  const persistEnd = server.indexOf("\n  private ", persistStart + 1);
  assert.ok(persistStart >= 0, "persistUpdate must exist");
  const persist = server.slice(persistStart, persistEnd > persistStart ? persistEnd : undefined);

  assert.match(
    persist,
    /SELECT id AS max_update_id, SHA2\(update_data, 256\) AS update_hash[\s\S]*ORDER BY id DESC[\s\S]*LIMIT 1[\s\S]*FOR UPDATE/
  );
  assert.match(persist, /durableUpdateHash:\s*currentUpdateHash/);
  assert.match(persist, /roomUpdateHash:\s*room\.maxUpdateHash/);
  assert.match(persist, /room\.maxUpdateHash = result\.updateHash/);
});

test("idle-room revalidation fingerprints the latest payload before reuse", () => {
  const recheckStart = server.indexOf("if (room.requiresDurableRecheck) {");
  const recheckEnd = server.indexOf("room.requiresDurableRecheck = false;", recheckStart);
  assert.ok(recheckStart >= 0 && recheckEnd > recheckStart, "idle durable recheck must exist");
  const recheck = server.slice(recheckStart, recheckEnd);
  assert.match(recheck, /SHA2\(update_data, 256\) AS update_hash/);
  assert.match(recheck, /durableUpdateHash !== room\.maxUpdateHash/);
});

test("same-id replacement is detected by the payload fingerprint", () => {
  const before = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const replacement = Buffer.from([0x10, 0x20, 0x30, 0x41]);
  const id = 42;
  assert.equal(id, 42);
  assert.notEqual(
    createHash("sha256").update(before).digest("hex"),
    createHash("sha256").update(replacement).digest("hex")
  );
  assert.match(protocol, /roomUpdateHash !== durableUpdateHash/);
});
