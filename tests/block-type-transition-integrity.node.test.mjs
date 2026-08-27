import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");
const blockRoute = normalize(await readFile(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
));
const client = normalize(await readFile(new URL("../public/app.js", import.meta.url), "utf8"));

const structuredMetadataKeyByType = new Map([
  ["TABLE", "table"],
  ["KANBAN", "kanban"],
  ["DATABASE", "database"],
  ["TREEVIEW", "treeView"],
  ["ACCORDION", "accordion"],
  ["TIMETABLE", "timetable"],
  ["GANTT", "gantt"],
  ["BOOKMARK", "bookmark"],
  ["AI_CHAT", "aiChat"]
]);

function vulnerableBookmarkTransition(existing, request) {
  const nextType = request.type ?? existing.type;
  const sourceMetadata = Object.hasOwn(request, "metadata")
    ? request.metadata
    : existing.metadata;
  let markdown = request.markdown ?? existing.markdown;

  if (nextType === "BOOKMARK") {
    const bookmark = sourceMetadata?.bookmark ?? {
      title: "Bookmarks",
      view: "gallery",
      listColumns: 1,
      items: []
    };
    const itemSummary = bookmark.items
      .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
      .join("\n\n");
    markdown = [bookmark.title, itemSummary].filter(Boolean).join("\n\n").slice(0, 20_000);
  }

  return { type: nextType, markdown, metadata: sourceMetadata };
}

function guardedTransition(existing, request) {
  if (request.type !== undefined && request.type !== existing.type) {
    const metadataKey = structuredMetadataKeyByType.get(request.type);
    const metadata = request.metadata;
    if (
      metadataKey
      && (
        !metadata
        || typeof metadata !== "object"
        || Array.isArray(metadata)
        || !Object.hasOwn(metadata, metadataKey)
        || metadata[metadataKey] === null
        || metadata[metadataKey] === undefined
      )
    ) {
      const error = new Error("Changing a block to a structured type requires canonical metadata");
      error.code = "BLOCK_TYPE_METADATA_REQUIRED";
      throw error;
    }
  }
  return vulnerableBookmarkTransition(existing, request);
}

test("reproduction: a type-only BOOKMARK conversion replaced existing note text with an implicit default", () => {
  const existing = {
    type: "MARKDOWN",
    markdown: "Recovery phrase: delta-echo-foxtrot",
    metadata: null
  };
  const vulnerable = vulnerableBookmarkTransition(existing, { type: "BOOKMARK" });

  assert.equal(vulnerable.type, "BOOKMARK");
  assert.equal(vulnerable.markdown, "Bookmarks");
  assert.notEqual(vulnerable.markdown, existing.markdown);
});

test("the server rejects under-specified structured transitions before content preparation", () => {
  const patchStart = blockRoute.indexOf('blockRouter.patch("/blocks/:blockId"');
  const patchEnd = blockRoute.indexOf('blockRouter.post(\n  "/blocks/:blockId/move"', patchStart);
  const patchSource = blockRoute.slice(patchStart, patchEnd);

  const guardIndex = patchSource.indexOf(
    "assertSafeBlockTypeTransition(existing.type, body.type, body.metadata);"
  );
  const prepareIndex = patchSource.indexOf("const prepared = prepareBlockContent(");

  assert.ok(patchStart >= 0 && patchEnd > patchStart);
  assert.ok(guardIndex >= 0, "PATCH route must enforce the structured transition guard");
  assert.ok(prepareIndex > guardIndex, "guard must run before derived markdown is prepared");
  assert.match(blockRoute, /"BLOCK_TYPE_METADATA_REQUIRED"/);
  assert.match(blockRoute, /Object\.prototype\.hasOwnProperty\.call\(requestedMetadata, metadataKey\)/);

  const existing = {
    type: "MARKDOWN",
    markdown: "Recovery phrase: delta-echo-foxtrot",
    metadata: null
  };
  for (const request of [
    { type: "BOOKMARK" },
    { type: "BOOKMARK", metadata: null },
    { type: "BOOKMARK", metadata: {} },
    { type: "BOOKMARK", metadata: { bookmark: null } }
  ]) {
    assert.throws(
      () => guardedTransition(existing, request),
      (error) => error?.code === "BLOCK_TYPE_METADATA_REQUIRED"
    );
  }
});

test("the server guard covers the same metadata-backed types as the browser preservation policy", () => {
  for (const [type, key] of structuredMetadataKeyByType) {
    assert.match(blockRoute, new RegExp(`\\["${type}", "${key}"\\]`));
    assert.match(client, new RegExp(`structuredBlockTypes = new Set\\([^\\n]*"${type}"`));
  }
  assert.match(client, /Never reinterpret metadata-backed content as another block type in place/);
});

test("same-type edits, text-to-text conversions, and canonical structured conversions remain valid", () => {
  const existing = {
    type: "MARKDOWN",
    markdown: "Original",
    metadata: null
  };

  assert.doesNotThrow(() => guardedTransition(existing, {
    type: "MARKDOWN",
    markdown: "Edited"
  }));
  assert.doesNotThrow(() => guardedTransition(existing, {
    type: "QUOTE",
    markdown: "Quoted"
  }));
  assert.doesNotThrow(() => guardedTransition(existing, {
    type: "BOOKMARK",
    metadata: {
      bookmark: {
        title: "References",
        view: "gallery",
        listColumns: 1,
        items: []
      }
    }
  }));
});
