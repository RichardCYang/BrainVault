import assert from "node:assert/strict";
import test from "node:test";
import { createHarness, makeBlock, measureEnter } from "./helpers/wan-editing-harness.mjs";

const methods = (ctx) => ctx.metrics.requests.map((item) => item.method);

test("clean Enter at tail performs one committed create, no PATCH/reorder/GET", async () => {
  const result = await measureEnter();
  assert.deepEqual(result.requests, ["POST /api/pages/p/blocks"]);
  assert.equal(result.committedCreates, 1);
  assert.equal(result.finalBlockIds.length, 2);
  assert.deepEqual(result.finalVersions, [1, 1]);
});
test("dirty Enter durably saves once, then creates once without a page reload", async () => {
  const result = await measureEnter({ dirty: true });
  assert.deepEqual(result.requests, ["PATCH /api/blocks/a", "POST /api/pages/p/blocks"]);
  assert.deepEqual(result.finalVersions, [2, 1]);
});
test("middle insertion keeps required reorder, avoids redundant full page GET", async () => {
  const result = await measureEnter({ middle: true });
  assert.deepEqual(result.requests, ["POST /api/pages/p/blocks", "POST /api/pages/p/blocks/reorder"]);
  assert.equal(result.finalBlockIds[1].startsWith("new-"), true);
  assert.deepEqual(result.finalVersions, [2, 2, 2]);
});
test("save-on-blur of an acknowledged block is a no-op even after the previous queue became idle", async () => {
  const ctx = createHarness(); const row = ctx.rows.get("a");
  row.payload.markdown = "edited"; row.classList.add("is-dirty");
  await ctx.saveBlockRow(row); await ctx.saveBlockRow(row); await ctx.saveBlockRow(row);
  assert.deepEqual(methods(ctx), ["PATCH"]);
  assert.equal(ctx.metrics.history, 1);
});
test("equal structured metadata with different key order does not create a redundant PATCH", async () => {
  const ctx = createHarness({ blocks: [makeBlock("a", 0, { metadata: { x: 1, y: ["😀", { z: 2 }] } })] });
  ctx.rows.get("a").payload.metadata = { y: ["😀", { z: 2 }], x: 1 };
  await ctx.saveBlockRow(ctx.rows.get("a")); assert.equal(ctx.metrics.requests.length, 0);
});
for (const [name, change] of Object.entries({
  "dirty row": (ctx, row) => row.classList.add("is-dirty"),
  "save error": (ctx, row) => row.classList.add("save-error"),
  "local visibility admission": (ctx, row) => row.classList.add("recovery-admission-pending"),
  "stored recovery draft": (ctx, row) => ctx.drafts.set("a", { payload: row.payload, revision: 1, expectedVersion: 1 }),
  "retained expected version": (ctx, row) => { row.dataset.draftExpectedVersion = "1"; },
  "retained source": (ctx, row) => { row.dataset.draftSourceId = "tab"; },
  "scheduled save": (ctx) => ctx.blockSaveTimers.set("a", 1),
  "authentication-bound pending edit": (ctx) => ctx.blockEditAuthenticationScopes.set("a", ctx.captureAuthenticatedSessionScope()),
  "changed text": (ctx, row) => { row.payload.markdown = "changed"; },
  "changed checkbox": (ctx, row) => { row.payload.checked = true; },
  "changed structured metadata": (ctx, row) => { row.payload.metadata = { lossless: [1, 2, 3] }; }
})) {
  test(`no-op optimization must not skip ${name}`, async () => {
    const ctx = createHarness(); const row = ctx.rows.get("a"); change(ctx, row);
    await ctx.saveBlockRow(row);
    assert.deepEqual(methods(ctx), ["PATCH"]);
    assert.ok(ctx.metrics.flushes > 0); assert.ok(ctx.metrics.drafts > 0);
  });
}
test("active save queue is not bypassed by payload equality", async () => {
  const ctx = createHarness(); let enqueued = 0;
  ctx.blockSaveQueues.set("a", { busy: true, async enqueue() { enqueued++; return { block: ctx.getBlockById("a") }; } });
  await ctx.saveBlockRow(ctx.rows.get("a")); assert.equal(enqueued, 1);
});
test("recovery conflict still persists locally and never overwrites server implicitly", async () => {
  const ctx = createHarness(); const row = ctx.rows.get("a"); row.dataset.draftConflict = "true";
  assert.equal(await ctx.saveBlockRow(row), null);
  assert.equal(ctx.metrics.requests.length, 0); assert.equal(ctx.metrics.drafts, 1); assert.equal(row.classList.contains("save-error"), true);
});
test("stale authentication is rejected even for clean unchanged text", async () => {
  const ctx = createHarness(); const authenticationScope = ctx.captureAuthenticatedSessionScope(); ctx.controls.authGeneration++;
  await assert.rejects(ctx.saveBlockRow(ctx.rows.get("a"), { authenticationScope }), /stale authentication/);
  assert.equal(ctx.metrics.requests.length, 0);
});
test("read-only and deleted rows are never saved", async () => {
  const ctx = createHarness(); ctx.controls.writable = false;
  assert.equal(await ctx.saveBlockRow(ctx.rows.get("a")), null);
  ctx.controls.writable = true; ctx.rows.get("a").dataset.deleting = "true";
  assert.equal(await ctx.saveBlockRow(ctx.rows.get("a")), null); assert.equal(ctx.metrics.requests.length, 0);
});
test("collaborative save stays on the existing Yjs path, not the direct no-op path", async () => {
  const ctx = createHarness({ collaborative: true });
  await ctx.saveBlockRow(ctx.rows.get("a"));
  assert.equal(ctx.metrics.collaborativeWrites, 1); assert.equal(ctx.metrics.requests.length, 0);
});
test("append on empty page uses one create and makes it visible", async () => {
  const ctx = createHarness({ blocks: [] }); await ctx.appendBlock();
  assert.equal(ctx.metrics.requests.length, 1); assert.equal(ctx.state.selectedPage.blocks.length, 1);
});
test("append button at root takes the same confirmed fast path as Enter", async () => {
  const ctx = createHarness(); await ctx.appendBlock();
  assert.deepEqual(methods(ctx), ["POST"]); assert.equal(ctx.state.selectedPage.blocks.length, 2);
});
test("non-authoritative create takes original canonical refresh and never attempts stale reorder", async () => {
  const ctx = createHarness(); ctx.controls.createAuthority = false;
  await ctx.appendBlock(ctx.rows.get("a"));
  assert.deepEqual(methods(ctx), ["POST", "GET"]); assert.equal(ctx.metrics.creates, 1);
});
test("an ambiguous create response replays the same mutation ID, no duplicate block", async () => {
  const ctx = createHarness(); ctx.controls.lostCreateResponses = 1;
  await ctx.appendBlock(ctx.rows.get("a"));
  assert.equal(ctx.metrics.requests.length, 2); assert.equal(ctx.metrics.creates, 1);
  assert.equal(ctx.metrics.requests[0].body.mutationId, ctx.metrics.requests[1].body.mutationId);
  assert.equal(ctx.state.selectedPage.blocks.length, 2);
});
test("reorder conflict retains original refresh behavior after committed create", async () => {
  const ctx = createHarness({ blocks: [makeBlock("a"), makeBlock("b", 1)] });
  ctx.controls.failReorder = Object.assign(new Error("conflict"), { status: 409 });
  await ctx.appendBlock(ctx.rows.get("a"));
  assert.deepEqual(methods(ctx), ["POST", "POST", "GET"]); assert.equal(ctx.metrics.creates, 1);
});
for (const status of [401, 403, 404]) {
  test(`canonical refresh ${status} cannot be converted into a successful local fallback`, async () => {
    const ctx = createHarness(); ctx.controls.createAuthority = false; ctx.controls.failGet = Object.assign(new Error(`HTTP ${status}`), { status });
    await assert.rejects(ctx.appendBlock(ctx.rows.get("a")), new RegExp(`HTTP ${status}`));
    assert.equal(ctx.metrics.renders, 0);
  });
}
test("pending local text is never replaced by a confirmed response fast path", async () => {
  const ctx = createHarness(); const context = ctx.captureDirectBlockInsertionContext(ctx.captureAuthenticatedSessionScope());
  const data = await ctx.createEmptyBlock("p", { sortOrder: 1 }); ctx.controls.pendingEdits = true;
  const oldBlocks = ctx.state.selectedPage.blocks;
  assert.equal(await ctx.tryRenderConfirmedBlockInsertion(context, data, null, ["a", data.block.id]), false);
  assert.equal(ctx.state.selectedPage.blocks, oldBlocks); assert.equal(ctx.metrics.renders, 0);
});
for (const [name, change] of Object.entries({
  logout: (ctx) => ctx.controls.authGeneration++,
  navigation: (ctx) => ctx.workspaceNavigationGeneration++,
  "same-page replacement": (ctx) => { ctx.state.selectedPage = structuredClone(ctx.state.selectedPage); },
  "permissions revoked": (ctx) => { ctx.controls.writable = false; },
  "collaboration enabled": (ctx) => { ctx.controls.collaborative = true; },
  "new local edit": (ctx) => { ctx.controls.pendingEdits = true; },
  "recovered title conflict": (ctx) => { ctx.pageTitleDraftConflict = true; },
  "recovered block conflict": (ctx) => { ctx.controls.unsafeRow = true; },
  "local storage failure": (ctx) => { ctx.controls.failStorage = true; }
})) {
  test(`confirmed rendering rechecks ${name} after asynchronous recovery cleanup`, async () => {
    const ctx = createHarness(); const context = ctx.captureDirectBlockInsertionContext(ctx.captureAuthenticatedSessionScope());
    const data = await ctx.createEmptyBlock("p", { sortOrder: 1 });
    ctx.controls.storagePending = true; ctx.controls.onFlush = () => change(ctx);
    assert.equal(await ctx.tryRenderConfirmedBlockInsertion(context, data, null, ["a", data.block.id]), false);
    assert.equal(ctx.metrics.renders, 0);
  });
}
test("navigation during new cleanup await cannot send a follow-up reorder or refresh", async () => {
  const ctx = createHarness(); ctx.controls.storagePending = true;
  ctx.controls.onFlush = () => ctx.workspaceNavigationGeneration++;
  await ctx.appendBlock(ctx.rows.get("a"));
  assert.deepEqual(methods(ctx), ["POST"]); assert.equal(ctx.metrics.renders, 0);
});
test("slow transport does not reintroduce additional network round trips", async () => {
  const result = await measureEnter({ latencyMs: 60 });
  assert.equal(result.requests.length, 1); assert.ok(result.elapsedMs >= 50);
});
