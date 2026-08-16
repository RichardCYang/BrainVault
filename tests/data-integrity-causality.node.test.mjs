import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (relative) => readFileSync(new URL(relative, import.meta.url), "utf8").replace(/\r\n/g, "\n");

function section(source, startNeedle, endNeedle) {
  const start = source.indexOf(startNeedle);
  const end = source.indexOf(endNeedle, start + startNeedle.length);
  assert.ok(start >= 0, `missing start marker: ${startNeedle}`);
  assert.ok(end > start, `missing end marker: ${endNeedle}`);
  return source.slice(start, end);
}

function partialMutationVersionPayload(pageContentVersion, authoritative) {
  return {
    ...(authoritative ? { pageContentVersion } : {}),
    pageContentVersionAuthoritative: authoritative
  };
}

function isAuthoritativePartialMutationReplay(basePageContentVersion, currentVersion) {
  return basePageContentVersion !== undefined && currentVersion === basePageContentVersion + 1;
}

test("page PATCH materializes its acknowledgement before the transaction releases the page lock", () => {
  const pages = read("../src/routes/page.routes.ts");
  const route = section(
    pages,
    'pageRouter.patch("/:pageId"',
    "pageRouter.delete("
  );

  const transactionStart = route.indexOf("const page = await transaction(async (client) => {");
  const causalResponse = route.lastIndexOf("return getPageResponse(pageId, user.id, client);");
  const transactionEnd = route.indexOf("\n    });", causalResponse);
  const send = route.indexOf("res.json({ page });", transactionEnd);

  assert.ok(transactionStart >= 0);
  assert.ok(causalResponse > transactionStart);
  assert.ok(transactionEnd > causalResponse);
  assert.ok(send > transactionEnd);
  assert.doesNotMatch(route, /res\.json\(\{ page: await getPageResponse\(pageId, user\.id\) \}\)/);
  assert.match(route, /last_mutation_id = NULL/);
  assert.match(route, /last_mutation_hash = NULL/);
});

test("partial block mutations require a caller snapshot base before certifying the page-global content version", () => {
  const blocks = read("../src/routes/block.routes.ts");
  const client = read("../public/app.js");

  assert.match(blocks, /basePageContentVersion: safeVersionSchema\.optional\(\)/);
  assert.match(blocks, /pageContentVersion: authoritative \? pageContentVersion : undefined/);
  assert.match(blocks, /pageContentVersionAuthoritative: authoritative/);
  assert.match(blocks, /isAuthoritativePartialMutationReplay\(basePageContentVersion, currentContentVersion\)/);
  assert.match(client, /basePageContentVersion: getPositiveVersion\(state\.selectedPage\.contentVersion\)/);
  assert.match(client, /formData\.set\("basePageContentVersion", String\(task\.basePageContentVersion\)\)/);
  assert.match(client, /if \(data\?\.pageContentVersionAuthoritative !== true\) return;/);
  assert.equal((client.match(/applyAuthoritativePageContentVersion\(/g) ?? []).length, 4);
});

test("stale partial responses cannot make a stale page snapshot appear current", () => {
  const staleBase = 1;
  const lockedVersionAfterRemoteBlockEdit = 2;
  const committedVersion = 3;
  const authoritative = staleBase === lockedVersionAfterRemoteBlockEdit;
  const response = partialMutationVersionPayload(committedVersion, authoritative);

  assert.equal(response.pageContentVersionAuthoritative, false);
  assert.equal("pageContentVersion" in response, false);

  const currentBase = 1;
  const lockedCurrentVersion = 1;
  const currentResponse = partialMutationVersionPayload(2, currentBase === lockedCurrentVersion);
  assert.deepEqual(currentResponse, {
    pageContentVersion: 2,
    pageContentVersionAuthoritative: true
  });

  assert.equal(isAuthoritativePartialMutationReplay(1, 2), true);
  assert.equal(isAuthoritativePartialMutationReplay(1, 3), false);
});
