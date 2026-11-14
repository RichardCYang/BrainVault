// A paste longer than one block holds continues in new blocks below instead
// of being refused, and the split never loses or reorders text.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  BLOCK_MARKDOWN_MAX_LENGTH,
  PAGE_MAX_BLOCKS,
  PAGE_MAX_MARKDOWN_BYTES,
  splitTextIntoBlockChunks
} from "../public/editor-content-limits.js";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const serverLimits = readFileSync(new URL("../src/lib/page-resource-limits.ts", import.meta.url), "utf8");
const withoutWhitespace = (value) => value.replace(/\s/g, "");
const fenceLines = (value) => (value.match(/^ {0,3}(`{3,}|~{3,})/gm) ?? []).length;

test("text that fits is one chunk, unchanged", () => {
  assert.deepEqual(splitTextIntoBlockChunks("short", 100), ["short"]);
  assert.deepEqual(splitTextIntoBlockChunks("", 100), [""]);
});

test("paragraphs split at blank lines and keep every character in order", () => {
  const text = Array.from({ length: 200 }, (_, index) => `Paragraph ${index} ${"word ".repeat(40)}`).join("\n\n");
  const chunks = splitTextIntoBlockChunks(text, 2_000);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.ok(chunk.length <= 2_000);
  for (const chunk of chunks) assert.match(chunk, /^Paragraph \d+ /, "each chunk starts at a paragraph");
  assert.equal(withoutWhitespace(chunks.join("")), withoutWhitespace(text));
});

test("text without any break is cut hard, never inside a surrogate pair", () => {
  const text = "a" + "😀".repeat(3_000);
  const chunks = splitTextIntoBlockChunks(text, 1_000);
  assert.equal(chunks.join(""), text);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 1_000);
    assert.doesNotMatch(chunk, /^[\udc00-\udfff]|[\ud800-\udbff]$/);
  }
});

test("a code fence open at a cut is closed and reopened, so each part renders as code", () => {
  const body = Array.from({ length: 600 }, (_, index) => `const value${index} = ${index};`).join("\n");
  const text = `Intro\n\n\`\`\`js\n${body}\n\`\`\`\n\nAfter`;
  const chunks = splitTextIntoBlockChunks(text, 2_000);
  assert.ok(chunks.length > 2);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 2_000);
    assert.equal(fenceLines(chunk) % 2, 0, "every chunk has balanced fences");
  }
  assert.ok(chunks.slice(1).every((chunk) => !chunk.includes("After") || chunk.endsWith("After")));
  const lines = chunks.join("\n").split("\n").filter((line) => line.startsWith("const value"));
  assert.deepEqual(lines, body.split("\n"), "every code line is kept, in order");
});

test("CRLF is normalized like the text area does", () => {
  const text = `${"x".repeat(150)}\r\n\r\n${"y".repeat(150)}`;
  assert.deepEqual(splitTextIntoBlockChunks(text, 200), ["x".repeat(150), "y".repeat(150)]);
});

test("client page budgets mirror the server", () => {
  assert.equal(BLOCK_MARKDOWN_MAX_LENGTH, 20_000);
  assert.match(serverLimits, new RegExp(`maxBlocks: ${PAGE_MAX_BLOCKS.toLocaleString("en").replace(",", "_")},`));
  assert.equal(PAGE_MAX_MARKDOWN_BYTES, 4 * 1024 * 1024);
  assert.match(serverLimits, /maxMarkdownBytes: 4 \* MiB,/);
});

test("an over-long paste in a text block is spread over new blocks, safely", () => {
  const guard = app.slice(app.indexOf('document.addEventListener("paste", (event) => {'));
  assert.match(guard, /event\.stopImmediatePropagation\(\);\s*\/\/[^\n]*\n\s*const splitRow = getSplitPasteRow\(field\);/);
  const paste = app.slice(app.indexOf("async function pasteAcrossBlocks("), app.indexOf("// Pasting an image or file adds it"));
  // Later parts are created before the first part replaces this block's text.
  assert.ok(paste.indexOf("insertBlockRelative(previousRow") < paste.indexOf("replaceBlockTextareaValue(sourceRow"));
  assert.match(paste, /sourceTextarea\.value !== original/, "a block edited meanwhile is never overwritten");
  assert.match(paste, /PAGE_MAX_BLOCKS/);
  assert.match(paste, /PAGE_MAX_MARKDOWN_BYTES/);
  const types = app.slice(app.indexOf("const splitPasteBlockTypes"), app.indexOf("const activeSplitPastes"));
  assert.doesNotMatch(types, /MATH|MERMAID/, "splitting would break Math and Mermaid");
});

test("a paste that does not fit the page is offered a new subpage", () => {
  const paste = app.slice(app.indexOf("async function pasteAcrossBlocks("), app.indexOf("async function pasteIntoNewSubpage("));
  assert.match(paste, /label: t\("status\.pasteSplitIntoSubpage"\)/);
  // Only the pasted text goes to the subpage, only when it fits an empty page, and never code.
  assert.match(paste, /const pasted = normalizeInsertedFieldText\(field, text\);/);
  assert.match(paste, /!isCode\s*&& pastedChunks\.length <= \(isCollaborativePage\(\) \? SHARED_PAGE_MAX_BLOCKS : PAGE_MAX_BLOCKS\)/);
  const subpage = app.slice(app.indexOf("async function pasteIntoNewSubpage("), app.indexOf("// Pasting an image or file adds it"));
  assert.match(subpage, /createWorkspacePage\([^;]*icon: "📄", parentPageId \}/);
  // The subpage is filled by the same no-loss split as any long paste.
  assert.match(subpage, /await pasteAcrossBlocks\(row, field, pasted\)/);
  assert.match(subpage, /state\.selectedPage\?\.id !== pageId/, "stops if the user navigates away");
});

test("every split-paste message exists in all seven languages", () => {
  const section = i18n.slice(i18n.indexOf("const splitPasteTranslations = {"), i18n.indexOf("for (const [language, entries] of ["));
  for (const key of [
    "status.pasteSplitting",
    "status.pasteSplitDone",
    "status.pasteSplitInterrupted",
    "status.pasteSplitSourceChanged",
    "status.pasteSplitPageFull",
    "status.pasteSplitIntoSubpage",
    "status.pasteSubpageTitle",
    "status.pasteSplitIntoSubpageDone"
  ]) {
    assert.equal(section.split(`"${key}":`).length - 1, 7, `${key} must be translated for every language`);
  }
  assert.match(i18n, /\.\.\.Object\.entries\(splitPasteTranslations\)/);
});
