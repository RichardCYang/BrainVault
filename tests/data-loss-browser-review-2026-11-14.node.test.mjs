// Regression guards for data loss reproduced in a real browser on 2026-11-14:
// overwritten long blocks missing from version history, autosave pushing
// deletions out of history, long text cut when turned into an AI chat, files
// and very large blocks deleted without warning, and text dropped into a
// nearly full field.
import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  boundPageVersionChanges,
  countRemovedHistoryCharacters,
  isCoalescibleBlockUpdate,
  isPageVersionOmittedValue,
  mergeCoalescedBlockUpdate,
  pageVersionCoalesceMaxRemovedCharacters,
  pageVersionMaxRetainedDeletionRowsPerPage,
  pageVersionMaxRowsPerPage,
  pageVersionPreviousValueInlineMaxBytes,
  prunePageVersionHistory,
  recordPageVersion
} from "../src/lib/page-version-history.ts";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8").then((text) => text.replace(/\r\n/g, "\n"));
const [app, i18n] = await Promise.all([read("public/app.js"), read("public/i18n.js")]);

function functionSource(source, name) {
  const start = source.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} must exist`);
  const next = source.slice(start + 1).search(/\n(?:async )?function |\n(?:const|let|document|window|elements)\b/);
  return next === -1 ? source.slice(start) : source.slice(start, start + 1 + next);
}

function markdownUpdate(before, after, blockId = "blk_note") {
  return [{ kind: "block-updated", blockId, blockType: "MARKDOWN", fields: [{ field: "markdown", before, after }] }];
}

// The longest block text, in Korean: about 60 KB of UTF-8.
const fullKoreanBlock = "회의록 중요한 결정".repeat(2_000).slice(0, 20_000);

test("an edit keeps the whole previous text of a full-length block in history", () => {
  const [bounded] = boundPageVersionChanges(markdownUpdate(fullKoreanBlock, "x"));
  assert.equal(bounded.fields[0].before, fullKoreanBlock, "the replaced text is the only copy and must stay readable");
  assert.equal(bounded.fields[0].after, "x");

  // Escaping cannot push a 20,000-character block past the limit either.
  const worstCase = "\u0001".repeat(20_000);
  assert.ok(Buffer.byteLength(JSON.stringify(worstCase), "utf8") < pageVersionPreviousValueInlineMaxBytes);

  // The value that is still in the block may stay summarized.
  const [grown] = boundPageVersionChanges(markdownUpdate("", fullKoreanBlock));
  assert.equal(isPageVersionOmittedValue(grown.fields[0].after), true);
});

test("autosaves of one block group into one entry, but a large removal starts a new one", () => {
  assert.equal(countRemovedHistoryCharacters("hello world", "hello brave world"), 0);
  assert.equal(countRemovedHistoryCharacters("hello world", "hello"), 6);
  assert.equal(countRemovedHistoryCharacters("abc", "xyz"), 3);

  assert.equal(isCoalescibleBlockUpdate(markdownUpdate("draft", "draft and more")), true);
  assert.equal(isCoalescibleBlockUpdate(markdownUpdate(fullKoreanBlock, "x")), false, "select-all and type keeps its own entry");
  const small = "a".repeat(pageVersionCoalesceMaxRemovedCharacters);
  assert.equal(isCoalescibleBlockUpdate(markdownUpdate(small, "")), true, "a few deleted characters still group");
  assert.equal(isCoalescibleBlockUpdate(markdownUpdate(`${small}a`, "")), false);
  assert.equal(isCoalescibleBlockUpdate([{
    kind: "block-updated", blockId: "blk_note", blockType: "HEADING_1",
    fields: [{ field: "type", before: "MARKDOWN", after: "HEADING_1" }]
  }]), false, "type and position changes are never grouped");

  const merged = mergeCoalescedBlockUpdate(markdownUpdate("", "first"), markdownUpdate("first", "first second"));
  assert.deepEqual(merged, markdownUpdate("", "first second"), "the oldest before and newest after are kept");
  assert.equal(mergeCoalescedBlockUpdate(markdownUpdate("", "a"), markdownUpdate("a", "ab", "blk_other")), null);
});

function historyClient({ latest, revision = 5 }) {
  const calls = [];
  return {
    calls,
    client: {
      execute: async (sql, params) => {
        calls.push({ sql, params });
        return sql.includes("INSERT") ? { insertId: 99, affectedRows: 1 } : { affectedRows: 1 };
      },
      queryOne: async (sql) => {
        if (sql.includes("SELECT edit_version, content_version")) return { edit_version: 3, content_version: 8 };
        if (sql.includes("SELECT MAX(revision)")) return { revision };
        if (sql.includes("FROM page_versions WHERE page_id = ? AND revision = ?")) return latest;
        return undefined;
      }
    }
  };
}

const owner = { id: "usr_owner", username: "owner", name: null };
const latestRow = (overrides = {}) => ({
  id: 41,
  revision: 5,
  source: "BLOCK_UPDATE",
  actors: JSON.stringify([owner]),
  changes: JSON.stringify(markdownUpdate("", "first")),
  recent: 1,
  ...overrides
});

test("recordPageVersion updates the latest entry in place when the save can be grouped", async () => {
  const { client, calls } = historyClient({ latest: latestRow() });
  const result = await recordPageVersion(client, {
    pageId: "pag_note", actors: [owner], source: "BLOCK_UPDATE", changes: markdownUpdate("first", "first second")
  });
  assert.deepEqual(result, { id: 41, revision: 5 });
  assert.equal(calls.some((call) => call.sql.includes("INSERT INTO page_versions")), false);
  const update = calls.find((call) => call.sql.includes("UPDATE page_versions"));
  assert.ok(update, "the grouped entry is rewritten");
  assert.deepEqual(JSON.parse(update.params[4]), markdownUpdate("", "first second"));
});

test("recordPageVersion starts a new entry when the latest one cannot absorb the save", async () => {
  for (const latest of [
    latestRow({ recent: 0 }),
    latestRow({ source: "BLOCK_REORDER" }),
    latestRow({ actors: JSON.stringify([{ id: "usr_peer", username: "peer", name: null }]) }),
    latestRow({ changes: JSON.stringify(markdownUpdate("", "x", "blk_other")) }),
    undefined
  ]) {
    const { client, calls } = historyClient({ latest });
    const result = await recordPageVersion(client, {
      pageId: "pag_note", actors: [owner], source: "BLOCK_UPDATE", changes: markdownUpdate("first", "first second")
    });
    assert.deepEqual(result, { id: 99, revision: 6 });
    assert.equal(calls.some((call) => call.sql.includes("UPDATE page_versions")), false);
  }

  const { client, calls } = historyClient({ latest: latestRow() });
  await recordPageVersion(client, {
    pageId: "pag_note", actors: [owner], source: "BLOCK_UPDATE", changes: markdownUpdate("first draft of the plan ".repeat(5), "x")
  });
  assert.ok(calls.some((call) => call.sql.includes("INSERT INTO page_versions")), "a large removal is its own entry");
});

test("leaving the revision window keeps recent block deletions", async () => {
  const calls = [];
  const client = {
    execute: async (sql, params) => { calls.push({ sql, params }); return { affectedRows: 0 }; },
    queryOne: async (sql) => (sql.includes("ORDER BY revision DESC LIMIT 1 OFFSET ?") ? { revision: 12 } : undefined)
  };
  await prunePageVersionHistory(client, "pag_note", pageVersionMaxRowsPerPage + 50);
  assert.match(calls[0].sql, /AND NOT \(COALESCE\(CAST\(JSON_VALUE\(change_summary, '\$\.blocksDeleted'\) AS UNSIGNED\), 0\) > 0\)/);
  assert.deepEqual(calls[0].params, ["pag_note", 50]);
  assert.deepEqual(calls[1].params, ["pag_note", 12], "only deletions older than the newest kept ones go");
  assert.equal(pageVersionMaxRetainedDeletionRowsPerPage, 200);
});

test("version history can bring replaced text back without touching the block", () => {
  const card = functionSource(app, "createPageVersionChangeCard");
  assert.match(card, /const previousText = getRestorablePreviousBlockText\(change\);/);
  assert.match(card, /restorePreviousBlockTextFromPageVersion\(change\.blockId, previousText\)/);
  const offered = functionSource(app, "getRestorablePreviousBlockText");
  assert.match(offered, /typeof markdown\?\.before !== "string"/, "a summarized (omitted) value is not offered");
  assert.match(offered, /isStructuredBlockType\(type\)/, "structured blocks keep their content in metadata");
  const restore = functionSource(app, "restorePreviousBlockTextFromPageVersion");
  assert.match(restore, /insertBlockRelative\(row, "after", options\)/, "the old text is added, the current text stays");
  assert.doesNotMatch(restore, /saveBlockRow|replaceBlockTextareaValue/);
});

test("turning long text into an AI chat keeps the text instead of cutting it", () => {
  const slash = functionSource(app, "applySlashCommand");
  const guard = slash.indexOf('if (type === "AI_CHAT" && markdown.length > aiChatLimits.questionLength) {');
  assert.ok(guard > -1);
  assert.ok(guard < slash.indexOf("setRowType(row, type, { markdown });"), "the guard runs before the block is converted");
  const branch = slash.slice(guard, slash.indexOf("return;", guard));
  assert.match(branch, /await saveBlockRow\(row, \{ quiet: true \}\);\s*await insertBlockRelative\(row, "after"/);
  assert.match(branch, /t\("status\.aiChatQuestionTooLong"/);
  assert.match(app, /\n  aiChatLimits,\n[^;]*\} from "\.\/ai-chat-block\.js";/);
});

test("deleting a file or a block too large for history says it cannot come back", () => {
  const message = functionSource(app, "getBlockDeletionConfirmMessage");
  assert.match(message, /=== "ATTACHMENT"\) \{[\s\S]*t\("confirm\.deleteAttachmentBlock", \{ name \}\)/);
  assert.match(message, /isBlockTooLargeForDeletionHistory\(block\)\) return t\("confirm\.deleteUnrestorableBlock"\)/);
  assert.match(app, /const deletedBlockHistoryMetadataMaxBytes = 128 \* 1024;/);
  assert.match(app, /message: getBlockDeletionConfirmMessage\(row, blockId\)/);
  assert.match(app, /t\("confirm\.deleteIncludesAttachments", \{ count: formatNumber\(subtreeAttachmentCount\) \}\)/);
  assert.match(functionSource(app, "countSubtreeAttachments"), /block\?\.type === "ATTACHMENT"/);
});

test("text dropped into a nearly full field is refused instead of cut", () => {
  const start = app.indexOf('document.addEventListener("drop", (event) => {');
  assert.ok(start > -1);
  const guard = app.slice(start, app.indexOf("}, true);", start));
  assert.match(guard, /getPasteLengthGuardField\(event\.target\)/);
  assert.match(guard, /if \(dataTransferHasFiles\(event\.dataTransfer\)\) return;/, "dropped files keep their own handling");
  assert.match(guard, /if \(nextLength <= field\.maxLength\) return;\s*event\.preventDefault\(\);\s*event\.stopImmediatePropagation\(\);/);
  assert.match(guard, /t\("status\.dropTooLong"/);
  assert.match(functionSource(app, "getLengthAfterDrop"), /field\.value\.slice\(start, end\) === dropped\) return length;/,
    "moving text inside the same field does not change its length");
});

test("every locale explains the new refusals and warnings", () => {
  const section = i18n.slice(i18n.indexOf("const dataLossBrowserReviewTranslations = {"));
  const block = section.slice(0, section.indexOf("\n};\n"));
  for (const language of ["en", "ja", "ko", "fr", "de", "es", "pt"]) {
    const start = block.indexOf(`\n  ${language}: {`);
    assert.ok(start > -1, `${language} entries must exist`);
    const entries = block.slice(start, block.indexOf("\n  }", start));
    for (const key of [
      "status.aiChatQuestionTooLong",
      "confirm.deleteAttachmentBlock",
      "confirm.deleteUnrestorableBlock",
      "confirm.deleteIncludesAttachments",
      "status.dropTooLong",
      "versions.restorePreviousText",
      "status.previousTextRestored"
    ]) assert.match(entries, new RegExp(`"${key.replace(".", "\\.")}": "`), `${language} ${key}`);
  }
  assert.match(i18n, /\.\.\.Object\.entries\(dataLossBrowserReviewTranslations\)/);
});
