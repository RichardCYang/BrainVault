import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const route = source("../src/routes/block.routes.ts");

test("page content-version writes remain owner-scoped at the final SQL sink", () => {
  const helper = section(
    route,
    "async function advancePageContentVersion",
    "function partialMutationVersionPayload"
  );

  assert.match(
    helper,
    /advancePageContentVersion\(client: DbClient, pageId: string, ownerId: string\)/
  );
  assert.match(
    helper,
    /UPDATE pages SET content_version = content_version \+ 1 WHERE id = \? AND owner_id = \?/
  );
  assert.match(helper, /\[pageId, ownerId\]/);
  assert.match(
    helper,
    /SELECT \* FROM pages WHERE id = \? AND owner_id = \?/
  );
  assert.doesNotMatch(
    helper,
    /UPDATE pages SET content_version = content_version \+ 1 WHERE id = \?(?=["`])/
  );
  assert.doesNotMatch(helper, /_userId/);
});

test("block mutation call sites pass the locked page owner instead of the actor id", () => {
  assert.doesNotMatch(
    route,
    /advancePageContentVersion\([^\n]*user\.id/
  );

  assert.match(route, /advancePageContentVersion\(client, pageId, ownerId\)/);
  assert.match(
    route,
    /advancePageContentVersion\(client, existing\.page_id, lockedAccess\.page\.owner_id\)/
  );
  assert.match(
    route,
    /advancePageContentVersion\(client, sourcePageId, sourceAccess\.page\.owner_id\)/
  );
  assert.match(
    route,
    /advancePageContentVersion\(client, body\.targetPageId, targetAccess\.page\.owner_id\)/
  );
  assert.match(
    route,
    /advancePageContentVersion\(client, block\.page_id, lockedAccess\.page\.owner_id\)/
  );
  assert.match(
    route,
    /advancePageContentVersion\(client, pageId, lockedAccess\.page\.owner_id\)/
  );
});
