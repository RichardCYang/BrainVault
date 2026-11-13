// Runs the real Enter split / type-ahead functions from app.js inside the WAN
// editing harness. Like that harness, this is a protocol/interaction check,
// not a browser end-to-end test.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";
import { createHarness, makeBlock, makeRow } from "./helpers/wan-editing-harness.mjs";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");

function functionSource(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, "m").exec(appSource)?.index;
  assert.ok(start !== undefined, `missing ${name}`);
  return appSource.slice(start, appSource.indexOf("\n}", start) + 2);
}

function makeTextarea(row, value) {
  const textarea = {
    value,
    selectionStart: value.length,
    selectionEnd: value.length,
    setRangeText(text, start, end) {
      this.value = this.value.slice(0, start) + text + this.value.slice(end);
      this.selectionStart = this.selectionEnd = start + text.length;
    },
    setSelectionRange(start, end) {
      this.selectionStart = start;
      this.selectionEnd = end;
    },
    focus() {
      document.activeElement = textarea;
    }
  };
  row.textarea = textarea;
  return textarea;
}

const document = { activeElement: null };

function createSplitHarness({ markdown = "hello world", type = "MARKDOWN", latencyMs = 5 } = {}) {
  const ctx = createHarness({ latencyMs, blocks: [makeBlock("a", 0, { markdown, type })] });
  const source = ctx.rows.get("a");
  makeTextarea(source, markdown);
  ctx.document = document;
  ctx.pendingBlockSplits = new Map();
  ctx.splittableTextBlockTypes = new Set(["MARKDOWN", "HEADING_1", "TODO", "QUOTE"]);
  ctx.getBlockTextarea = (row) => row?.textarea ?? null;
  ctx.autoGrowTextarea = () => {};
  // Structural undo is covered by editor-structural-history; here a split only
  // has to be recorded once, after it has settled.
  ctx.recordedSplits = [];
  ctx.withBlockEditorHistorySuppressed = (task) => task();
  ctx.recordBlockSplitEditorHistory = (upperId, lowerId) => ctx.recordedSplits.push([upperId, lowerId]);
  // Typing marks the row dirty and its payload follows the textarea.
  ctx.scheduleBlockSave = (row) => {
    row.payload.markdown = row.textarea.value;
    row.classList.add("is-dirty");
    return true;
  };
  ctx.renderSelectedPage = () => {
    ctx.metrics.renders++;
    for (const block of ctx.state.selectedPage.blocks) {
      if (ctx.rows.has(block.id)) continue;
      const row = makeRow(block);
      makeTextarea(row, block.markdown);
      ctx.rows.set(block.id, row);
    }
    ctx.state.pendingFocusBlockId = null;
  };
  // Like the real openPage(): pending edits are saved before the reload.
  ctx.openPage = async (id) => {
    for (const row of ctx.rows.values()) {
      if (row.classList.contains("is-dirty")) await ctx.saveBlockRow(row, { quiet: true });
    }
    await ctx.requireDirectRecoveryDurability();
    const data = await ctx.api(`/api/pages/${id}`);
    ctx.state.selectedPage = data.page;
    ctx.workspaceNavigationGeneration++;
    ctx.renderSelectedPage();
  };
  vm.runInContext(
    ["placeCaretInBlock", "replaceBlockTextareaValue", "splitBlockAtCaret", "runBlockSplit", "settleBlockSplit"]
      .map(functionSource)
      .join("\n\n"),
    ctx
  );
  return { ctx, source };
}

const serverMarkdown = (ctx) => ctx.server.blocks
  .slice()
  .sort((left, right) => left.sortOrder - right.sortOrder)
  .map((block) => block.markdown);
const createdRow = (ctx) => [...ctx.rows.entries()].find(([id]) => id !== "a")?.[1];

test("Enter in the middle moves the text after the caret into the new block", async () => {
  const { ctx, source } = createSplitHarness();
  source.textarea.setSelectionRange(5, 5);
  await ctx.splitBlockAtCaret(source, source.textarea);

  assert.equal(source.textarea.value, "hello");
  assert.equal(createdRow(ctx).textarea.value, " world");
  assert.deepEqual(serverMarkdown(ctx), ["hello", " world"]);
  assert.equal(document.activeElement, createdRow(ctx).textarea);
  assert.equal(createdRow(ctx).textarea.selectionStart, 0);
  assert.equal(ctx.metrics.statuses.length, 0, "a routine Enter raises no notice");
  const createdId = [...ctx.rows.keys()].find((id) => id !== "a");
  assert.deepEqual(ctx.recordedSplits, [["a", createdId]], "the settled split is one undo step");
});

test("Enter at the end still creates one empty block with a single request", async () => {
  const { ctx, source } = createSplitHarness();
  await ctx.splitBlockAtCaret(source, source.textarea);

  assert.deepEqual(serverMarkdown(ctx), ["hello world", ""]);
  assert.deepEqual(ctx.metrics.requests.map((item) => item.method), ["POST"]);
});

test("text typed while the new block is being created ends up in the new block", async () => {
  const { ctx, source } = createSplitHarness({ latencyMs: 10 });
  source.textarea.setSelectionRange(5, 5);
  ctx.controls.beforeResponse = (path, options) => {
    if (path !== "/api/pages/p/blocks" || options.method !== "POST") return;
    ctx.controls.beforeResponse = null;
    // The caret is still in the old block while the request is in flight.
    source.textarea.setRangeText("NEW", 5, 5);
    ctx.scheduleBlockSave(source);
  };
  await ctx.splitBlockAtCaret(source, source.textarea);

  const created = createdRow(ctx);
  assert.equal(source.textarea.value, "hello");
  assert.equal(created.textarea.value, "NEW world");
  assert.equal(created.textarea.selectionStart, 3, "the caret follows the typed text");
  assert.deepEqual(serverMarkdown(ctx), ["hello", "NEW world"]);
});

test("a second Enter pressed before the first block arrives splits at the right place", async () => {
  const { ctx, source } = createSplitHarness({ markdown: "ab", latencyMs: 10 });
  let typed = false;
  ctx.controls.beforeResponse = async (path, options) => {
    if (typed || path !== "/api/pages/p/blocks" || options.method !== "POST") return;
    typed = true;
    // "c", Enter, "d" typed while the first create is still in flight.
    source.textarea.setRangeText("c", 2, 2);
    ctx.scheduleBlockSave(source);
    await ctx.splitBlockAtCaret(source, source.textarea);
    source.textarea.setRangeText("d", 3, 3);
    ctx.scheduleBlockSave(source);
  };
  await ctx.splitBlockAtCaret(source, source.textarea);

  assert.deepEqual(serverMarkdown(ctx), ["ab", "c", "d"]);
  assert.equal(ctx.metrics.creates, 2);
});

test("a failed create leaves the original text untouched", async () => {
  const { ctx, source } = createSplitHarness();
  source.textarea.setSelectionRange(5, 5);
  ctx.controls.beforeResponse = (path, options) => {
    if (path === "/api/pages/p/blocks" && options.method === "POST") {
      throw Object.assign(new Error("offline"), { status: 503 });
    }
  };
  await assert.rejects(ctx.splitBlockAtCaret(source, source.textarea), /offline/);

  assert.equal(source.textarea.value, "hello world");
  assert.deepEqual(serverMarkdown(ctx), ["hello world"]);
  assert.equal(ctx.pendingBlockSplits.size, 0);
});

test("non-text blocks keep their text and get an empty block below", async () => {
  const { ctx, source } = createSplitHarness({ markdown: "x = 1", type: "CODE" });
  source.textarea.setSelectionRange(2, 2);
  await ctx.splitBlockAtCaret(source, source.textarea);

  assert.deepEqual(serverMarkdown(ctx), ["x = 1", ""]);
});

test("Enter in a multi-line editor types a newline; Ctrl/Cmd+Enter leaves it", () => {
  const handler = appSource.slice(
    appSource.indexOf('if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {\n    // Code, math')
  );
  assert.match(handler, /multilineTextBlockTypes\.has\(row\.dataset\.blockType\) && !\(event\.ctrlKey \|\| event\.metaKey\)\) return;/);
  assert.match(handler, /await splitBlockAtCaret\(row, textarea\);/);
  assert.match(appSource, /const multilineTextBlockTypes = new Set\(\["CODE", "MATH", "MERMAID", "TOGGLE"\]\);/);
});

test("keyboard reordering reuses the fenced drag commit and a numeric pointer id", () => {
  assert.match(functionSource("moveBlockRowByStep"), /return moveBlockRowToIndex\(row, availability\.index \+ step, \{ keepSelection \}\)/);
  const move = functionSource("moveBlockRowToIndex");
  assert.match(move, /await finishBlockDrag\(\{ pointerId, preventDefault\(\) \{\} \}\)/);
  assert.match(appSource, /const keyboardBlockMovePointerId = -2;/);
  const navigationMove = functionSource("moveNavigationItemByStep");
  assert.match(navigationMove, /await finishNavigationDrag\(\{ pointerId: keyboardNavigationMovePointerId/);
});

test("joining blocks saves the combined text before the lower block is removed", () => {
  const merge = functionSource("mergeBlockRowsIntoPrevious");
  const saveTarget = merge.indexOf("await saveBlockRow(target");
  const empty = merge.indexOf('replaceBlockTextareaValue(row, textarea, "")');
  const remove = merge.indexOf("await deleteEmptyBlock(row)");
  assert.ok(saveTarget >= 0 && empty > saveTarget && remove > empty);
});
