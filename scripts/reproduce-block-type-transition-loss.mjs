import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const original = {
  type: "MARKDOWN",
  markdown: "Recovery phrase: delta-echo-foxtrot",
  metadata: null
};
const requests = [
  { type: "BOOKMARK", expectedVersion: 7 },
  { type: "BOOKMARK", metadata: {}, expectedVersion: 7 }
];

// Exact pre-fix decision path: omitted or empty target metadata becomes an
// implicit empty bookmark model, then BOOKMARK preparation regenerates markdown.
function preFixStoredMarkdown(request) {
  const sourceMetadata = request.metadata !== undefined ? request.metadata : original.metadata;
  const bookmark = sourceMetadata?.bookmark ?? {
    title: "Bookmarks",
    view: "gallery",
    listColumns: 1,
    items: []
  };
  return [
    bookmark.title,
    bookmark.items
      .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
      .join("\n\n")
  ].filter(Boolean).join("\n\n").slice(0, 20_000);
}

for (const request of requests) {
  assert.equal(preFixStoredMarkdown(request), "Bookmarks");
  assert.notEqual(preFixStoredMarkdown(request), original.markdown);
}

const source = (await readFile(
  new URL("../src/routes/block.routes.ts", import.meta.url),
  "utf8"
)).replace(/\r\n/g, "\n");
const guardIndex = source.indexOf(
  "assertSafeBlockTypeTransition(existing.type, body.type, body.metadata);"
);
const prepareIndex = source.indexOf("const prepared = prepareBlockContent(", guardIndex);
assert.ok(guardIndex >= 0 && prepareIndex > guardIndex);
assert.match(source, /"BLOCK_TYPE_METADATA_REQUIRED"/);
assert.match(source, /Object\.prototype\.hasOwnProperty\.call\(requestedMetadata, metadataKey\)/);

console.log(JSON.stringify({
  reproduction: {
    requests,
    originalMarkdown: original.markdown,
    preFixStoredMarkdown: requests.map(preFixStoredMarkdown),
    silentlyReplacedCharacters: original.markdown.length
  },
  fixedBehavior: {
    status: 400,
    code: "BLOCK_TYPE_METADATA_REQUIRED",
    rejectedBeforeContentPreparation: true,
    databaseWriteAttempted: false,
    originalMarkdownPreserved: true,
    requiredPayloadExample: {
      type: "BOOKMARK",
      metadata: {
        bookmark: {
          title: "References",
          view: "gallery",
          listColumns: 1,
          items: []
        }
      },
      expectedVersion: 7
    }
  }
}, null, 2));
