import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { planCollaborativeBlockReplacement } from "../public/collaboration.js";

function block(id, parentBlockId, sortOrder, type = "MARKDOWN") {
  return {
    id,
    type,
    markdown: type === "ATTACHMENT" ? `${id}.txt` : "",
    checked: false,
    parentBlockId,
    sortOrder,
    metadata: type === "ATTACHMENT"
      ? { attachment: { originalName: `${id}.txt`, mimeType: "text/plain", size: 1 } }
      : null
  };
}

test("attachment replacement keeps promoted children and sibling order dense in one plan", () => {
  const snapshot = [
    block("before", null, 0),
    block("target", null, 1),
    block("child-a", "target", 0),
    block("grandchild", "child-a", 0),
    block("child-b", "target", 1),
    block("after", null, 2),
    // The upload response is preceded by a canonical-attachment broadcast, so the
    // replacement can already occupy the target sort slot before replacement starts.
    block("attachment", null, 1, "ATTACHMENT")
  ];

  const plan = planCollaborativeBlockReplacement(
    snapshot,
    "target",
    block("attachment", null, 1, "ATTACHMENT")
  );

  assert.ok(plan);
  assert.deepEqual(plan.children.map((item) => item.id), ["child-a", "child-b"]);
  assert.deepEqual(
    plan.updates.map((item) => [item.id, item.parentBlockId, item.sortOrder]),
    [
      ["before", null, 0],
      ["attachment", null, 1],
      ["child-a", null, 2],
      ["child-b", null, 3],
      ["after", null, 4]
    ]
  );
  assert.equal(
    new Set(plan.updates.map((item) => item.sortOrder)).size,
    plan.updates.length,
    "replacement must not leave duplicate sibling sort orders"
  );
  assert.equal(
    plan.updates.some((item) => item.id === "grandchild"),
    false,
    "descendants of promoted children keep their existing parent relationship"
  );
});

test("the attachment replacement UI uses the atomic prepared-document mutation", () => {
  const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const start = app.indexOf("async function uploadAttachmentFromRow");
  const end = app.indexOf("function requestAttachmentUpload", start);
  assert.notEqual(start, -1);
  assert.ok(end > start);
  const upload = app.slice(start, end);

  assert.match(upload, /replacementBlock:\s*\{/);
  assert.match(upload, /preserveChildren:\s*true/);
  assert.match(
    upload,
    /if \(shouldReplaceCurrentBlock\) \{[\s\S]*replacementBlock:[\s\S]*\} else \{[\s\S]*session\.upsertBlock\(/,
    "replacement must be atomic while ordinary insertion may keep the existing upsert path"
  );
});
