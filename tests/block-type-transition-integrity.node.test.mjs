import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

const normalize = (value) => value.replace(/\r\n/g, "\n");
const blockRoute = normalize(await readFile(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
));
const client = normalize(await readFile(new URL("../public/app.js", import.meta.url), "utf8"));

const structuredMetadataPolicies = [
  ["TABLE", "table", "getTableData"],
  ["KANBAN", "kanban", "getKanbanData"],
  ["DATABASE", "database", "getDatabaseData"],
  ["TREEVIEW", "treeView", "getTreeViewData"],
  ["ACCORDION", "accordion", "getAccordionData"],
  ["TIMETABLE", "timetable", "getTimetableData"],
  ["GANTT", "gantt", "getGanttData"],
  ["BOOKMARK", "bookmark", "getBookmarkData"],
  ["AI_CHAT", "aiChat", "getAiChatData"]
];
const structuredMetadataKeyByType = new Map(
  structuredMetadataPolicies.map(([type, key]) => [type, key])
);

function normalizeBookmarkModel(metadata) {
  const source = metadata?.bookmark;
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return { title: "Bookmarks", view: "gallery", listColumns: 1, items: [] };
  }
  return {
    title: typeof source.title === "string" ? source.title : "Bookmarks",
    view: source.view === "list" ? "list" : "gallery",
    listColumns: Number.isInteger(source.listColumns)
      ? Math.min(5, Math.max(1, source.listColumns))
      : 1,
    items: Array.isArray(source.items) ? source.items : []
  };
}

function vulnerableBookmarkWrite(existing, request) {
  const nextType = request.type ?? existing.type;
  const sourceMetadata = Object.hasOwn(request, "metadata")
    ? request.metadata
    : existing.metadata;
  let markdown = request.markdown ?? existing.markdown;

  if (nextType === "BOOKMARK") {
    const bookmark = normalizeBookmarkModel(sourceMetadata);
    const itemSummary = bookmark.items
      .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
      .join("\n\n");
    markdown = [bookmark.title, itemSummary].filter(Boolean).join("\n\n").slice(0, 20_000);
  }

  return { type: nextType, markdown, metadata: sourceMetadata };
}

function guardedStructuredWrite(existing, request) {
  const targetType = request.type ?? existing.type;
  const metadataKey = structuredMetadataKeyByType.get(targetType);
  const changesType = request.type !== undefined && request.type !== existing.type;
  const replacesMetadata = Object.hasOwn(request, "metadata") && request.metadata !== undefined;
  const metadata = request.metadata;

  if (metadataKey && (changesType || replacesMetadata)) {
    const model = metadata?.[metadataKey];
    const normalizer = targetType === "BOOKMARK" ? normalizeBookmarkModel : null;
    if (
      !metadata
      || typeof metadata !== "object"
      || Array.isArray(metadata)
      || !Object.hasOwn(metadata, metadataKey)
      || !model
      || typeof model !== "object"
      || Array.isArray(model)
      || !normalizer
      || !isDeepStrictEqual(model, normalizer(metadata))
    ) {
      const error = new Error("Structured writes require complete canonical metadata");
      error.code = "BLOCK_TYPE_METADATA_REQUIRED";
      throw error;
    }
  }

  return vulnerableBookmarkWrite(existing, request);
}

const populatedBookmark = {
  type: "BOOKMARK",
  markdown: "References\nOpenAI documentation\nhttps://example.com/docs",
  metadata: {
    bookmark: {
      title: "References",
      view: "gallery",
      listColumns: 1,
      items: [{
        id: "reference-1",
        url: "https://example.com/docs",
        title: "OpenAI documentation",
        description: "Primary reference",
        imageUrl: "",
        faviconUrl: "https://example.com/favicon.ico",
        siteName: "example.com"
      }]
    }
  }
};

test("reproduction: a type-only BOOKMARK conversion replaced existing note text with an implicit default", () => {
  const existing = {
    type: "MARKDOWN",
    markdown: "Recovery phrase: delta-echo-foxtrot",
    metadata: null
  };
  const vulnerable = vulnerableBookmarkWrite(existing, { type: "BOOKMARK" });

  assert.equal(vulnerable.type, "BOOKMARK");
  assert.equal(vulnerable.markdown, "Bookmarks");
  assert.notEqual(vulnerable.markdown, existing.markdown);
});

test("reproduction: nested empty or partial metadata also normalized into destructive defaults", () => {
  const plain = {
    type: "MARKDOWN",
    markdown: "Recovery phrase: delta-echo-foxtrot",
    metadata: null
  };
  for (const request of [
    { type: "BOOKMARK", metadata: { bookmark: {} } },
    { type: "BOOKMARK", metadata: { bookmark: { items: [] } } }
  ]) {
    const vulnerable = vulnerableBookmarkWrite(plain, request);
    assert.equal(vulnerable.markdown, "Bookmarks");
    assert.notEqual(vulnerable.markdown, plain.markdown);
  }

  for (const request of [
    { metadata: null },
    { metadata: {} },
    { metadata: { bookmark: null } },
    { metadata: { bookmark: {} } },
    { metadata: { bookmark: { items: [] } } }
  ]) {
    const vulnerable = vulnerableBookmarkWrite(populatedBookmark, request);
    assert.equal(vulnerable.type, "BOOKMARK");
    assert.equal(vulnerable.markdown, "Bookmarks");
    assert.notDeepEqual(vulnerable.metadata, populatedBookmark.metadata);
  }
});

test("the server rejects under-specified structured writes before content preparation", () => {
  const patchStart = blockRoute.indexOf('blockRouter.patch("/blocks/:blockId"');
  const patchEnd = blockRoute.indexOf('blockRouter.post(\n  "/blocks/:blockId/move"', patchStart);
  const patchSource = blockRoute.slice(patchStart, patchEnd);

  const guardIndex = patchSource.indexOf(
    "assertSafeStructuredMetadataWrite(existing.type, body.type, body.metadata);"
  );
  const prepareIndex = patchSource.indexOf("const prepared = prepareBlockContent(");

  assert.ok(patchStart >= 0 && patchEnd > patchStart);
  assert.ok(guardIndex >= 0, "PATCH route must enforce the structured-write guard");
  assert.ok(prepareIndex > guardIndex, "guard must run before derived markdown is prepared");
  assert.match(blockRoute, /const targetType = requestedType \?\? existingType;/);
  assert.match(blockRoute, /const replacesMetadata = requestedMetadata !== undefined;/);
  assert.match(blockRoute, /if \(!changesType && !replacesMetadata\) return;/);
  assert.match(blockRoute, /"BLOCK_TYPE_METADATA_REQUIRED"/);
  assert.match(blockRoute, /Object\.prototype\.hasOwnProperty\.call\(requestedMetadata, metadataKey\)/);
  assert.match(blockRoute, /assertLosslessStructuredMetadata\(targetType, requestedMetadata\)/);
  assert.match(blockRoute, /isDeepStrictEqual\(requestedModel, normalizer\(validatedMetadata\)\)/);
  assert.match(blockRoute, /complete canonical \$\{metadataKey\} model/);

  const plain = {
    type: "MARKDOWN",
    markdown: "Recovery phrase: delta-echo-foxtrot",
    metadata: null
  };
  for (const request of [
    { type: "BOOKMARK" },
    { type: "BOOKMARK", metadata: null },
    { type: "BOOKMARK", metadata: {} },
    { type: "BOOKMARK", metadata: { bookmark: null } },
    { type: "BOOKMARK", metadata: { bookmark: {} } },
    { type: "BOOKMARK", metadata: { bookmark: { items: [] } } }
  ]) {
    assert.throws(
      () => guardedStructuredWrite(plain, request),
      (error) => error?.code === "BLOCK_TYPE_METADATA_REQUIRED"
    );
  }

  for (const request of [
    { metadata: null },
    { metadata: {} },
    { type: "BOOKMARK", metadata: {} },
    { metadata: { bookmark: null } },
    { metadata: { bookmark: {} } },
    { metadata: { bookmark: { items: [] } } },
    { metadata: { bookmark: { title: "Partial", items: [] } } }
  ]) {
    assert.throws(
      () => guardedStructuredWrite(populatedBookmark, request),
      (error) => error?.code === "BLOCK_TYPE_METADATA_REQUIRED"
    );
  }
});

test("the server guard covers the same metadata-backed types as the browser preservation policy", () => {
  for (const [type, key, normalizer] of structuredMetadataPolicies) {
    assert.match(blockRoute, new RegExp(`\\["${type}", "${key}"\\]`));
    assert.match(blockRoute, new RegExp(`\\["${type}", ${normalizer}\\]`));
    assert.match(client, new RegExp(`structuredBlockTypes = new Set\\([^\\n]*"${type}"`));
  }
  assert.match(client, /Never reinterpret metadata-backed content as another block type in place/);
});

test("omitted metadata, text conversions, and complete canonical structured writes remain valid", () => {
  const plain = {
    type: "MARKDOWN",
    markdown: "Original",
    metadata: null
  };

  assert.doesNotThrow(() => guardedStructuredWrite(plain, {
    type: "MARKDOWN",
    markdown: "Edited"
  }));
  assert.doesNotThrow(() => guardedStructuredWrite(plain, {
    type: "QUOTE",
    markdown: "Quoted"
  }));
  assert.doesNotThrow(() => guardedStructuredWrite(plain, {
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
  assert.doesNotThrow(() => guardedStructuredWrite(populatedBookmark, {
    type: "BOOKMARK",
    markdown: "Derived text is regenerated from the existing metadata"
  }));
  assert.doesNotThrow(() => guardedStructuredWrite(populatedBookmark, {
    metadata: {
      bookmark: {
        title: "Empty references",
        view: "gallery",
        listColumns: 1,
        items: []
      }
    }
  }));
});
