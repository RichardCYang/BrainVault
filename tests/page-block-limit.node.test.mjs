// A page may hold pageResourceLimits.maxBlocks blocks. Every operation that
// names all of a page's siblings must still be accepted at that size, or a
// block created or moved on a full page silently stays at the end.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

process.env.NODE_ENV ??= "test";
process.env.DATABASE_URL ??= "mariadb://report:unused@127.0.0.1:1/report";
const { pageResourceLimits } = await import("../src/lib/page-resource-limits.ts");
const {
  isWithinRequestValidationBudget,
  REQUEST_VALIDATION_MAX_ARRAY_ITEMS
} = await import("../src/lib/request-validation-budget.ts");
const { PAGE_MAX_BLOCKS } = await import("../public/editor-content-limits.js");

const blockRoutes = readFileSync(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function fullReorderBody(count) {
  return {
    mutationId: "mut_full_page_reorder",
    items: Array.from({ length: count }, (_, index) => ({
      id: `blk_${String(index).padStart(12, "0")}`,
      sortOrder: index,
      parentBlockId: null,
      expectedVersion: 1
    }))
  };
}

test("a full reorder of the largest page passes request validation in compact form", () => {
  // One object per block would not fit: that is why the client sends the compact form.
  assert.ok(pageResourceLimits.maxBlocks > REQUEST_VALIDATION_MAX_ARRAY_ITEMS);
  assert.equal(isWithinRequestValidationBudget(fullReorderBody(pageResourceLimits.maxBlocks)), false);
  const ids = fullReorderBody(pageResourceLimits.maxBlocks).items.map((item) => item.id);
  assert.equal(isWithinRequestValidationBudget({
    mutationId: "mut_full_page_reorder",
    order: { parentBlockId: null, ids: ids.join(","), versions: ids.map(() => "1").join(",") }
  }), true);
});

test("the reorder schema accepts every sibling a page can hold", () => {
  const schema = blockRoutes.slice(blockRoutes.indexOf("const reorderSchema = z.object({"), blockRoutes.indexOf("const attachmentFormSchema"));
  assert.match(schema, /\.max\(pageResourceLimits\.maxBlocks\)/);
  assert.doesNotMatch(schema, /\.max\(500\)/);
});

test("the client's page budget mirrors the server", () => {
  assert.equal(PAGE_MAX_BLOCKS, pageResourceLimits.maxBlocks);
});

test("opening a page fits all text areas with one layout, not one per block", () => {
  const fit = app.slice(app.indexOf("function fitTextareaHeights("), app.indexOf("function getBlockTableData("));
  // All heights are reset, then all measured, then all written.
  const reset = fit.indexOf('textarea.style.height = "auto"');
  const measure = fit.indexOf("textarea.scrollHeight");
  const write = fit.indexOf("textarea.style.height = `${heights[index]}px`");
  assert.ok(reset > 0 && measure > reset && write > measure);
  // Editors created while rendering queue their fit instead of fitting at once.
  const editor = app.slice(app.indexOf("function createTextBlockEditor("), app.indexOf("function createToggleBlockEditor("));
  assert.match(editor, /scheduleTextareaFit\(textarea\);/);
  assert.doesNotMatch(editor, /requestAnimationFrame\(\(\) => autoGrowTextarea/);
  // Width changes are fitted as one batch too.
  const observer = app.slice(app.indexOf("const autoGrowResizeObserver"), app.indexOf("function observeTextareaWidth("));
  assert.match(observer, /fitTextareaHeights\(resized\);/);
});

test("page budget errors are translated in every language", () => {
  const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
  const section = i18n.slice(i18n.indexOf("const pageLimitTranslations = {"), i18n.indexOf("for (const [language, entries] of ["));
  for (const code of ["PAGE_BLOCK_LIMIT_EXCEEDED", "PAGE_MARKDOWN_LIMIT_EXCEEDED", "PAGE_METADATA_LIMIT_EXCEEDED",
    "PAGE_HTML_CACHE_LIMIT_EXCEEDED", "PAGE_SOURCE_LIMIT_EXCEEDED", "PAGE_RESPONSE_TOO_LARGE", "PAGE_RENDER_LIMIT_EXCEEDED",
    "SHARED_PAGE_BLOCK_LIMIT_EXCEEDED"]) {
    assert.equal(section.split(`"errors.${code}":`).length - 1, 7, `${code} must be translated for every language`);
  }
  assert.match(i18n, /\.\.\.Object\.entries\(pageLimitTranslations\)/);
});

test("shared pages keep the smaller block limit at every point a page becomes shared", async () => {
  const { sharedPageResourceLimits } = await import("../src/lib/page-resource-limits.ts");
  const { SHARED_PAGE_MAX_BLOCKS } = await import("../public/editor-content-limits.js");
  assert.equal(SHARED_PAGE_MAX_BLOCKS, sharedPageResourceLimits.maxBlocks);
  // Ten structs per plain block must leave room under the 100,000-struct Yjs bound.
  const yjs = readFileSync(new URL("../src/lib/yjs-validation.ts", import.meta.url), "utf8");
  assert.match(yjs, /const maxYjsTotalStructs = 100_000;/);
  assert.ok(sharedPageResourceLimits.maxBlocks * 10 <= 100_000 / 2);
  const collaboration = readFileSync(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");
  const collection = readFileSync(new URL("../src/routes/collection-sharing.routes.ts", import.meta.url), "utf8");
  const pages = readFileSync(new URL("../src/routes/page.routes.ts", import.meta.url), "utf8");
  // Direct share, the live-editing session, collection share, and a move into a shared collection.
  assert.match(collaboration, /await assertPagesFitSharedDocument\(client, \[pageId\]\);\s*const shareGeneration = createId\("share"\);/);
  assert.match(collaboration, /await assertStoredPageResourceBudget\(client, pageId\);[\s\S]{0,200}await assertPagesFitSharedDocument\(client, \[pageId\]\);\s*const documentBlocks/);
  assert.match(collection, /await assertPagesFitSharedDocument\(client, firstSharePages\.map\(\(page\) => page\.id\)\);/);
  assert.match(pages, /if \(beforeShareCount === 0 && afterShareCount > 0\) \{\s*await assertPagesFitSharedDocument\(client, \[row\.id\]\);/);
  // The browser stops retrying and explains, instead of a reconnect loop.
  const live = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
  assert.match(live, /const pageTooLargeToShare = error\?\.code === "SHARED_PAGE_BLOCK_LIMIT_EXCEEDED";/);
  assert.match(app, /setStatus\(t\("errors\.SHARED_PAGE_BLOCK_LIMIT_EXCEEDED"\), true\);/);
});

test("a confirmed insertion on a large page adds one row instead of rebuilding them all", () => {
  const insertion = app.slice(app.indexOf("async function tryRenderConfirmedBlockInsertion("), app.indexOf("async function insertBlockRelative("));
  assert.match(insertion, /if \(!insertConfirmedBlockRowInPlace\(context\.page, plan\.createdBlock\.id\)\) renderSelectedPage\(\);/);
  const inPlace = insertion.slice(insertion.indexOf("function insertConfirmedBlockRowInPlace("));
  assert.match(inPlace, /if \(flatBlocks\.length <= farRowPageThreshold\) return false;/, "small pages keep the full render");
  assert.match(inPlace, /renderedRows\.length !== flatBlocks\.length - 1\) return false;/, "falls back unless every other row is in place");
  // Reorder answers update state in one pass.
  const submit = app.slice(app.indexOf("async function submitBlockOrderTask("), app.indexOf("async function requireBlockOrderRecoveryDurability("));
  assert.match(submit, /updateBlocksInState\(data\.blocks \?\? \[\]\);/);
});
