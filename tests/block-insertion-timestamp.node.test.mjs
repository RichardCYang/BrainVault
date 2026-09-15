import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createHarness, makeBlock } from "./helpers/wan-editing-harness.mjs";

const source = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const start = source.indexOf("async function advancePageContentVersion(");
const end = source.indexOf("\nfunction partialMutationVersionPayload", start);
assert.ok(start >= 0 && end > start);
const helper = stripTypeScriptTypes(source.slice(start, end));
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function load() {
  const context = { ApiError, notFound: () => new ApiError(404, "NOT_FOUND", "Page not found") };
  vm.createContext(context); vm.runInContext(helper, context);
  return context.advancePageContentVersion;
}

test("timestamp observer reuses the existing owner-scoped transaction read without extra SQL", async () => {
  const advance = load(); const calls = [];
  const page = { id: "p", owner_id: "owner", content_version: 21, updated_at: "2026-09-15T10:00:00.000Z" };
  const client = {
    async execute(sql, args) { calls.push({ sql, args: Array.from(args) }); return { affectedRows: 1 }; },
    async queryOne(sql, args) { calls.push({ sql, args: Array.from(args) }); return page; }
  };
  let observed;
  assert.equal(await advance(client, "p", "owner", (committed) => { observed = committed; }), 21);
  assert.equal(observed, page);
  assert.equal(calls.length, 2, "one UPDATE and the original SELECT, no metadata round trip");
  assert.deepEqual(calls[0].args, ["p", "owner", Number.MAX_SAFE_INTEGER]);
  assert.deepEqual(calls[1].args, ["p", "owner"]);
  assert.match(calls[0].sql, /owner_id = \?/); assert.match(calls[1].sql, /owner_id = \?/);
});
test("legacy three-argument mutation callers keep the same numeric return contract", async () => {
  assert.equal(await load()({ execute: async () => ({ affectedRows: 1 }), queryOne: async () => ({ content_version: 2 }) }, "p", "owner"), 2);
});
for (const [name, page, expected] of [
  ["wrong/missing owner page", null, "NOT_FOUND"],
  ["safe-integer content-version exhaustion", { id: "p" }, "PAGE_EDIT_CONFLICT"]
]) {
  test(`observer cannot bypass ${name}`, async () => {
    let called = false;
    const advance = load();
    await assert.rejects(advance({ execute: async () => ({ affectedRows: 0 }), queryOne: async () => page }, "p", "owner", () => { called = true; }), (error) => error.code === expected);
    assert.equal(called, false);
  });
}
test("failed committed-page read cannot expose unverified metadata", async () => {
  let called = false;
  await assert.rejects(load()({ execute: async () => ({ affectedRows: 1 }), queryOne: async () => null }, "p", "owner", () => { called = true; }), (error) => error.code === "NOT_FOUND");
  assert.equal(called, false);
});
test("both create and reorder responses carry transaction-confirmed timestamps, including replays", () => {
  const create = source.slice(source.indexOf('blockRouter.post("/pages/:pageId/blocks",'), source.indexOf('blockRouter.patch("/blocks/:blockId",'));
  const reorder = source.slice(source.indexOf('"/pages/:pageId/blocks/reorder",'));
  assert.match(create, /pageUpdatedAt: lockedAccess\.page\.updated_at/);
  assert.match(reorder, /pageUpdatedAt: lockedPage\.updated_at/);
  for (const body of [create, reorder]) {
    assert.match(body, /pageUpdatedAt = page\.updated_at/);
    assert.match(body, /pageUpdatedAt: result\.pageUpdatedAt/);
    assert.match(body, /assertCurrentAuthSessionBoundary/);
    assert.match(body, /assertDirectBlockMutationAllowed/);
    assert.match(body, /getPageAccess\(pageId, user\.id, client, \{ lockPage: true, lockAccess: true \}\)/);
  }
});
test("confirmed tail and middle insertions update page timestamp through the normal summary UI helper", async () => {
  for (const middle of [false, true]) {
    const ctx = createHarness({ blocks: middle ? [makeBlock("a"), makeBlock("b", 1)] : [makeBlock("a")] });
    await ctx.appendBlock(ctx.rows.get("a"));
    assert.equal(ctx.metrics.summaryUpdates, 1);
    assert.equal(ctx.state.selectedPage.updatedAt, middle ? "2026-09-15T10:00:01.000Z" : "2026-09-15T10:00:00.000Z");
  }
});
