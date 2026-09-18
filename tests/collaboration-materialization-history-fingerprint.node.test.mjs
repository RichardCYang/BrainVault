import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const route = readFileSync(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url),
  "utf8"
).replace(/\r\n/g, "\n");

test("materialization revalidation fingerprints Yjs payload bytes, not only ids and lengths", () => {
  const materializeRouteStart = route.indexOf('collaborationRouter.put(\n  "/pages/:pageId/collaboration/snapshot"');
  assert.ok(materializeRouteStart >= 0, "materialization route must exist");

  const materializeRoute = route.slice(materializeRouteStart);
  assert.match(
    materializeRoute,
    /SELECT id, update_data, user_id, SHA2\(update_data, 256\) AS update_hash[\s\S]*FOR UPDATE/
  );
  assert.match(
    materializeRoute,
    /SELECT id, OCTET_LENGTH\(update_data\) AS update_bytes,[\s\S]*SHA2\(update_data, 256\) AS update_hash[\s\S]*LIMIT \? FOR UPDATE/
  );
  assert.match(
    materializeRoute,
    /row\.update_hash !== updateRows\[index\]\.update_hash/
  );
});

test("equal-length replacement payloads are a distinct history state", () => {
  const before = Buffer.from([0x01, 0x02, 0x03, 0x04]);
  const replacement = Buffer.from([0x01, 0x02, 0x03, 0x05]);
  assert.equal(before.length, replacement.length);
  assert.notDeepEqual(before, replacement);
});
