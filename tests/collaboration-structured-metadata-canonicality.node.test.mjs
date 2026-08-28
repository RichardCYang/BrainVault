import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { isDeepStrictEqual } from "node:util";

const normalizeSource = (value) => value.replace(/\r\n/g, "\n");
const materializationSource = normalizeSource(await readFile(
  new URL("../src/lib/collaboration-materialization.ts", import.meta.url),
  "utf8"
));
const canonicalPolicySource = normalizeSource(await readFile(
  new URL("../src/lib/structured-metadata-canonical.ts", import.meta.url),
  "utf8"
).catch(() => ""));

function normalizeComparableJsonValue(value) {
  if (Array.isArray(value)) return value.map(normalizeComparableJsonValue);
  if (value && typeof value === "object") {
    const result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      result[key] = normalizeComparableJsonValue(value[key]);
    }
    return result;
  }
  return value;
}

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

function legacyBookmarkIntegrityCheck(metadata) {
  const root = metadata && typeof metadata === "object" && !Array.isArray(metadata)
    ? metadata
    : null;
  const bookmark = root?.bookmark;
  if (!bookmark || typeof bookmark !== "object" || Array.isArray(bookmark)) return false;
  const allowed = new Set(["title", "view", "listColumns", "items"]);
  return Object.keys(bookmark).every((key) => allowed.has(key))
    && (bookmark.items === undefined || Array.isArray(bookmark.items));
}

function summarizeBookmark(metadata) {
  const bookmark = normalizeBookmarkModel(metadata);
  const itemSummary = bookmark.items
    .map((item) => `${item.title ?? ""}\n${item.description ?? ""}\n${item.url ?? ""}`.trim())
    .join("\n\n");
  return [bookmark.title, itemSummary].filter(Boolean).join("\n\n").slice(0, 20_000);
}

function isCanonicalBookmarkMetadata(metadata) {
  const model = metadata?.bookmark;
  return Boolean(
    model
    && typeof model === "object"
    && !Array.isArray(model)
    && isDeepStrictEqual(
      normalizeComparableJsonValue(model),
      normalizeComparableJsonValue(normalizeBookmarkModel(metadata))
    )
  );
}

test("reproduction: a partial collaborative bookmark model passed integrity checks and materialized destructive defaults", () => {
  const durableBefore = {
    markdown: "References\nPrimary runbook\nhttps://example.com/runbook",
    metadata: {
      bookmark: {
        title: "References",
        view: "gallery",
        listColumns: 1,
        items: [{
          id: "runbook-1",
          url: "https://example.com/runbook",
          title: "Primary runbook",
          description: "Recovery instructions",
          imageUrl: "",
          faviconUrl: "https://example.com/favicon.ico",
          siteName: "example.com"
        }]
      }
    }
  };
  const malformedCollaborationMetadata = { bookmark: { items: [] } };

  assert.equal(legacyBookmarkIntegrityCheck(malformedCollaborationMetadata), true);
  assert.equal(isCanonicalBookmarkMetadata(malformedCollaborationMetadata), false);

  const vulnerableAfter = {
    markdown: summarizeBookmark(malformedCollaborationMetadata),
    metadata: malformedCollaborationMetadata
  };
  assert.equal(vulnerableAfter.markdown, "Bookmarks");
  assert.notEqual(vulnerableAfter.markdown, durableBefore.markdown);
  assert.notDeepEqual(vulnerableAfter.metadata, durableBefore.metadata);
});

test("collaboration decoding rejects non-canonical structured metadata before any SQL materialization", () => {
  const validationIndex = materializationSource.indexOf(
    "const validatedMetadata = assertStructuredBlockMetadataIntegrity(parsed.data.type, parsed.data.metadata);"
  );
  const canonicalIndex = materializationSource.indexOf(
    "assertCanonicalStructuredMetadataModel(parsed.data.type, validatedMetadata);",
    validationIndex
  );
  const returnIndex = materializationSource.indexOf(
    "return { ...parsed.data, metadata: validatedMetadata }",
    validationIndex
  );

  assert.ok(validationIndex >= 0, "collaboration blocks must retain lossless metadata validation");
  assert.ok(canonicalIndex > validationIndex, "canonicality must be checked after lossless validation");
  assert.ok(returnIndex > canonicalIndex, "a partial model must be rejected before it enters materialization");
  assert.match(
    materializationSource,
    /error instanceof StructuredMetadataIntegrityError[\s\S]*error instanceof StructuredMetadataCanonicalityError/
  );
});

test("the shared canonicality policy covers every metadata-backed editor and ignores object prototypes", () => {
  const policies = [
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
  for (const [type, key, normalizer] of policies) {
    assert.match(canonicalPolicySource, new RegExp(`\["${type}", \{ metadataKey: "${key}", normalize: ${normalizer} \}\]`));
  }
  assert.match(canonicalPolicySource, /normalizeComparableJsonValue/);
  assert.match(canonicalPolicySource, /Object\.create\(null\)/);
  assert.match(canonicalPolicySource, /isDeepStrictEqual/);

  const hostileKeyRecord = Object.create(null);
  hostileKeyRecord.__proto__ = { polluted: true };
  const normalizedHostileKeyRecord = normalizeComparableJsonValue(hostileKeyRecord);
  assert.equal(Object.getPrototypeOf(normalizedHostileKeyRecord), null);
  assert.deepEqual(Object.keys(normalizedHostileKeyRecord), ["__proto__"]);
  assert.equal({}.polluted, undefined);

  const plain = { title: "Bookmarks", view: "gallery", listColumns: 1, items: [] };
  const nullPrototype = Object.assign(Object.create(null), plain);
  assert.equal(
    isDeepStrictEqual(
      normalizeComparableJsonValue(nullPrototype),
      normalizeComparableJsonValue(plain)
    ),
    true
  );
});

test("complete structured models and non-structured blocks remain valid", () => {
  assert.equal(isCanonicalBookmarkMetadata({
    bookmark: {
      title: "Bookmarks",
      view: "gallery",
      listColumns: 1,
      items: []
    }
  }), true);
  assert.equal(isCanonicalBookmarkMetadata({ bookmark: { items: [] } }), false);
});
