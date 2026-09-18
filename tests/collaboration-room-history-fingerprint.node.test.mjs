import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

const server = readFileSync(
  new URL("../src/lib/collaboration-server.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

test("room loading fingerprints Yjs payload bytes across unlocked worker replay", () => {
  const roomLoaderStart = server.indexOf("room.loadPromise = (async () => {");
  const roomLoaderEnd = server.indexOf("\n    })().then((loaded) => {", roomLoaderStart);
  assert.ok(roomLoaderStart >= 0 && roomLoaderEnd > roomLoaderStart, "room loader must exist");
  const loader = server.slice(roomLoaderStart, roomLoaderEnd);

  assert.match(
    loader,
    /SELECT id, update_data, SHA2\(update_data, 256\) AS update_hash, is_snapshot[\s\S]*ORDER BY id ASC/
  );
  assert.match(
    loader,
    /SELECT id, OCTET_LENGTH\(update_data\) AS update_bytes,[\s\S]*SHA2\(update_data, 256\) AS update_hash[\s\S]*LIMIT \? FOR UPDATE/
  );
  assert.match(loader, /row\.update_hash !== snapshot\.history\[index\]\.update_hash/);
});

test("equal-length same-id payload replacement defeats the legacy aggregate checkpoint but not a hash fingerprint", () => {
  const before = Buffer.from([0x10, 0x20, 0x30, 0x40]);
  const replacement = Buffer.from([0x10, 0x20, 0x30, 0x41]);
  const legacyBefore = { count: 1, bytes: before.length, maxId: 41 };
  const legacyAfter = { count: 1, bytes: replacement.length, maxId: 41 };

  assert.deepEqual(legacyAfter, legacyBefore, "legacy metadata cannot distinguish the replacement");
  assert.notEqual(
    createHash("sha256").update(before).digest("hex"),
    createHash("sha256").update(replacement).digest("hex"),
    "content fingerprints distinguish equal-length replacement bytes"
  );
});
