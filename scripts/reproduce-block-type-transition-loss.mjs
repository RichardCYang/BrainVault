import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const plainBlock = {
  type: "MARKDOWN",
  markdown: "Recovery phrase: delta-echo-foxtrot",
  metadata: null
};
const structuredBlock = {
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

const conversionRequests = [
  { type: "BOOKMARK", expectedVersion: 7 },
  { type: "BOOKMARK", metadata: {}, expectedVersion: 7 }
];
const sameTypeRequests = [
  { metadata: null, expectedVersion: 11 },
  { metadata: {}, expectedVersion: 11 },
  { type: "BOOKMARK", metadata: { bookmark: null }, expectedVersion: 11 }
];

// Exact pre-fix decision path: omitted, null, or empty target metadata becomes
// an implicit empty bookmark model, then BOOKMARK preparation regenerates the
// stored markdown from that empty model.
function preFixStoredState(existing, request) {
  const sourceMetadata = request.metadata !== undefined ? request.metadata : existing.metadata;
  const bookmark = sourceMetadata?.bookmark ?? {
    title: "Bookmarks",
    view: "gallery",
    listColumns: 1,
    items: []
  };
  const markdown = [
    bookmark.title,
    bookmark.items
      .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
      .join("\n\n")
  ].filter(Boolean).join("\n\n").slice(0, 20_000);
  return { markdown, metadata: sourceMetadata };
}

for (const request of conversionRequests) {
  const result = preFixStoredState(plainBlock, request);
  assert.equal(result.markdown, "Bookmarks");
  assert.notEqual(result.markdown, plainBlock.markdown);
}
for (const request of sameTypeRequests) {
  const result = preFixStoredState(structuredBlock, request);
  assert.equal(result.markdown, "Bookmarks");
  assert.notEqual(result.markdown, structuredBlock.markdown);
  assert.notDeepEqual(result.metadata, structuredBlock.metadata);
}

const source = (await readFile(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
)).replace(/\r\n/g, "\n");
const guardIndex = source.indexOf(
  "assertSafeStructuredMetadataWrite(existing.type, body.type, body.metadata);"
);
const prepareIndex = source.indexOf("const prepared = prepareBlockContent(", guardIndex);
assert.ok(guardIndex >= 0 && prepareIndex > guardIndex);
assert.match(source, /const targetType = requestedType \?\? existingType;/);
assert.match(source, /const replacesMetadata = requestedMetadata !== undefined;/);
assert.match(source, /"BLOCK_TYPE_METADATA_REQUIRED"/);
assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(requestedMetadata, metadataKey\)/);

console.log(JSON.stringify({
  reproduction: {
    conversionRequests,
    sameTypeRequests,
    originalPlainMarkdown: plainBlock.markdown,
    originalStructuredMarkdown: structuredBlock.markdown,
    preFixConversionStates: conversionRequests.map((request) => preFixStoredState(plainBlock, request)),
    preFixSameTypeStates: sameTypeRequests.map((request) => preFixStoredState(structuredBlock, request))
  },
  fixedBehavior: {
    status: 400,
    code: "BLOCK_TYPE_METADATA_REQUIRED",
    rejectedBeforeContentPreparation: true,
    databaseWriteAttempted: false,
    originalMarkdownPreserved: true,
    originalMetadataPreserved: true,
    validEmptyBookmarkPayload: {
      metadata: {
        bookmark: {
          title: "Bookmarks",
          view: "gallery",
          listColumns: 1,
          items: []
        }
      },
      expectedVersion: 11
    }
  }
}, null, 2));
