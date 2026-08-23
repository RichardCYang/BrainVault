import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

function section(text, start, end) {
  const startIndex = text.indexOf(start);
  const endIndex = text.indexOf(end, startIndex);
  assert.notEqual(startIndex, -1, `missing source marker: ${start}`);
  assert.ok(endIndex > startIndex, `missing source marker after ${start}: ${end}`);
  return text.slice(startIndex, endIndex);
}

const client = source("../public/app.js");

test("block-delete retry cache keys bind the destructive snapshot scope", () => {
  const taskGetter = section(
    client,
    "function getBlockDeleteTask",
    "async function submitBlockDeleteTask"
  );
  const deleteFlow = section(
    client,
    "async function deleteBlockWithVersionCheck",
    "function updateBlockInState"
  );

  assert.match(
    taskGetter,
    /function getBlockDeleteTask\(authenticationScope, pageId, blockId, payload, deleteScope\)/
  );
  assert.match(
    taskGetter,
    /pageId,\s*blockId,\s*deleteScope\s*\]\.join/
  );
  assert.doesNotMatch(taskGetter, /payload\.preserveChildren \? "preserve" : "cascade"/);

  assert.match(
    deleteFlow,
    /const deleteScope = preserveChildren\s*\? "preserve-children"\s*:\s*\(options\.includeDescendants === false \? "root-only" : "subtree"\)/
  );
  assert.match(
    deleteFlow,
    /getBlockVersionSnapshot\(blockId, \{\s*includeDescendants: deleteScope !== "root-only"\s*\}\)/
  );
  assert.match(
    deleteFlow,
    /getBlockDeleteTask\(authenticationScope, pageId, blockId, \{[\s\S]*?\}, deleteScope\)/
  );
});

test("root-only cleanup cannot reuse an ambiguous subtree-delete snapshot", () => {
  const subtree = [
    { id: "blk_parent", version: 4 },
    { id: "blk_child", version: 9 }
  ];
  const rootOnly = [subtree[0]];

  function exactServerSnapshot(expectedVersions) {
    return (
      expectedVersions.length === subtree.length
      && subtree.every((row) => (
        expectedVersions.some((expected) => (
          expected.id === row.id && expected.version === row.version
        ))
      ))
    );
  }

  function reproduce({ scopeAware }) {
    const tasks = new Map();
    const key = (deleteScope) => (
      scopeAware
        ? `session\0page\0blk_parent\0${deleteScope}`
        : "session\0page\0blk_parent\0cascade"
    );

    // First request: the user explicitly chose subtree deletion, but both network
    // attempts failed ambiguously before the server committed anything. The
    // durable retry task therefore retains the full subtree snapshot.
    tasks.set(key("subtree"), { expectedVersions: subtree });

    // Later, attachment replacement asks for a root-only cleanup. That operation
    // intentionally sends only the source block so the server rejects the delete
    // if descendants exist.
    const rootOnlyKey = key("root-only");
    const task = tasks.get(rootOnlyKey) ?? { expectedVersions: rootOnly };
    const serverAcceptsDelete = exactServerSnapshot(task.expectedVersions);

    return {
      serverAcceptsDelete,
      childDeleted: serverAcceptsDelete
    };
  }

  assert.deepEqual(
    reproduce({ scopeAware: false }),
    { serverAcceptsDelete: true, childDeleted: true }
  );
  assert.deepEqual(
    reproduce({ scopeAware: true }),
    { serverAcceptsDelete: false, childDeleted: false }
  );
});
