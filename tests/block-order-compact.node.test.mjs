// A reorder of a large page is sent as two strings instead of one object per
// block, so its size no longer runs into the shared request validation budget.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "mariadb://report:unused@127.0.0.1:1/report";
const { compactBlockOrderSchema, expandCompactBlockOrder } = await import("../src/lib/block-order-request.ts");
const { isWithinRequestValidationBudget } = await import("../src/lib/request-validation-budget.ts");
const { pageResourceLimits } = await import("../src/lib/page-resource-limits.ts");

const routes = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const css = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

const ids = (count) => Array.from({ length: count }, (_, index) => `blk_${String(index).padStart(12, "0")}`);

test("the compact form expands to exactly the itemized snapshot", () => {
  const order = { parentBlockId: "blk_parent", ids: "blk_a,blk_b,blk_c", versions: "3,1,12" };
  assert.deepEqual(expandCompactBlockOrder(order, 10), [
    { id: "blk_a", sortOrder: 0, parentBlockId: "blk_parent", expectedVersion: 3 },
    { id: "blk_b", sortOrder: 1, parentBlockId: "blk_parent", expectedVersion: 1 },
    { id: "blk_c", sortOrder: 2, parentBlockId: "blk_parent", expectedVersion: 12 }
  ]);
  assert.equal(expandCompactBlockOrder({ parentBlockId: null, ids: "blk_a", versions: "1" }, 10)[0].parentBlockId, null);
});

test("malformed compact orders are refused", () => {
  const refuse = (order, max = 10) => assert.throws(() => expandCompactBlockOrder(order, max),
    (error) => error?.statusCode === 400 && error?.code === "INVALID_BLOCK_ORDER");
  refuse({ parentBlockId: null, ids: "blk_a,blk_b", versions: "1" });
  refuse({ parentBlockId: null, ids: "blk_a,,blk_b", versions: "1,1,1" });
  refuse({ parentBlockId: null, ids: "blk a", versions: "1" });
  refuse({ parentBlockId: null, ids: "blk_a", versions: "0" });
  refuse({ parentBlockId: null, ids: "blk_a", versions: "-1" });
  refuse({ parentBlockId: null, ids: "blk_a", versions: "1.5" });
  refuse({ parentBlockId: null, ids: "blk_a", versions: "99999999999999999" });
  refuse({ parentBlockId: null, ids: "blk_a,blk_b,blk_c", versions: "1,1,1" }, 2);
  const schema = compactBlockOrderSchema(10);
  assert.equal(schema.safeParse({ parentBlockId: "../x", ids: "blk_a", versions: "1" }).success, false);
  assert.equal(schema.safeParse({ parentBlockId: null, ids: "blk_a", versions: "1", extra: 1 }).success, false);
});

test("a full reorder of the largest page fits the request budget only in compact form", () => {
  const all = ids(pageResourceLimits.maxBlocks);
  const compact = { mutationId: "mut_x", order: { parentBlockId: null, ids: all.join(","), versions: all.map(() => "1").join(",") } };
  assert.equal(isWithinRequestValidationBudget(compact), true);
  assert.equal(compactBlockOrderSchema(pageResourceLimits.maxBlocks).safeParse(compact.order).success, true);
  // The whole body also fits the 5 MB JSON parser.
  assert.ok(Buffer.byteLength(JSON.stringify(compact)) < 5 * 1024 * 1024);
});

test("the route expands either form before validation and hashing", () => {
  const handler = routes.slice(routes.indexOf('"/pages/:pageId/blocks/reorder"'));
  const expand = handler.indexOf("expandCompactBlockOrder(body.order, pageResourceLimits.maxBlocks)");
  const hash = handler.indexOf("createMutationRequestHash({ pageId, items })");
  assert.ok(expand > 0 && hash > expand, "the idempotency hash covers the expanded items");
  assert.match(routes, /\.refine\(\(body\) => \(body\.items === undefined\) !== \(body\.order === undefined\)/);
  // Batched updates keep the per-row guards and fail on any row that did not change.
  assert.match(handler, /AND \(id, edit_version\) IN \(/);
  assert.match(handler, /Number\(result\.affectedRows\) !== batch\.length/);
});

test("the client always sends the compact form", () => {
  const submit = app.slice(app.indexOf("async function submitBlockOrderTask("), app.indexOf("async function requireBlockOrderRecoveryDurability("));
  assert.match(submit, /body: \{ mutationId: task\.mutationId, order: compactBlockOrder\(task\) \}/);
  assert.doesNotMatch(submit, /items: task\.items/);
});

test("large pages lay out only the rows near the viewport", () => {
  assert.match(css, /\.editor-block-row\.is-far \{\s*content-visibility: auto;\s*contain-intrinsic-size: auto 44px;/);
  assert.match(css, /@media print \{\s*\.editor-block-row\.is-far \{\s*content-visibility: visible;/);
  const render = app.slice(app.indexOf("function renderSelectedPage("), app.indexOf("function normalizePageTitle("));
  assert.match(render, /if \(deferFarRows\) markRowFarUntilVisible\(row\);/);
  const observer = app.slice(app.indexOf("const farRowObserver"), app.indexOf("function markRowFarUntilVisible("));
  assert.match(observer, /!row\.contains\(document\.activeElement\)/, "a row being edited is never contained");
  assert.match(app, /textarea\?\.isConnected && !textarea\.closest\("\.is-far"\)/, "far rows are fitted when they come near");
});
