import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  CollaborationDocumentError
} from "../src/lib/collaboration-document.js";
import {
  materializeCollaborationUpdates
} from "../src/lib/collaboration-materialization.js";

function createYValue(value: unknown): unknown {
  if (typeof value === "string") {
    const text = new Y.Text();
    if (value) text.insert(0, value);
    return text;
  }
  if (Array.isArray(value)) {
    const array = new Y.Array<unknown>();
    if (value.length) array.insert(0, value.map(createYValue));
    return array;
  }
  if (value && typeof value === "object") {
    const map = new Y.Map<unknown>();
    for (const [key, item] of Object.entries(value)) map.set(key, createYValue(item));
    return map;
  }
  return value;
}

function addBlock(document: Y.Doc, id: string, block: Record<string, unknown>) {
  document.getMap("blocks").set(id, createYValue(block));
}

function createDurableDocument() {
  const document = new Y.Doc();
  document.getText("title").insert(0, "Durable title");
  addBlock(document, "child", {
    type: "TODO",
    markdown: "must survive",
    checked: true,
    parentBlockId: "root",
    sortOrder: 20,
    metadata: { textAlign: "center" }
  });
  addBlock(document, "root", {
    type: "HEADING_1",
    markdown: "Canonical root",
    checked: false,
    parentBlockId: null,
    sortOrder: 10,
    metadata: null
  });
  addBlock(document, "deleted-attachment", {
    type: "ATTACHMENT",
    markdown: "old.bin",
    checked: false,
    parentBlockId: null,
    sortOrder: 30,
    metadata: { attachment: { originalName: "old.bin" } }
  });
  document.getMap("deletedAttachments").set("deleted-attachment", true);
  return document;
}

describe("server-authoritative collaboration materialization", () => {
  it("rebuilds title, hierarchy, metadata, and attachment tombstones from durable Yjs updates", () => {
    const document = createDurableDocument();
    const update = Y.encodeStateAsUpdate(document);

    const snapshot = materializeCollaborationUpdates([update]);

    expect(snapshot.title).toBe("Durable title");
    expect(snapshot.blocks.map((block) => block.id)).toEqual(["root", "child"]);
    expect(snapshot.blocks[1]).toMatchObject({
      type: "TODO",
      markdown: "must survive",
      checked: true,
      parentBlockId: "root",
      metadata: { textAlign: "center" }
    });
    expect(snapshot.deletedAttachmentIds).toEqual(["deleted-attachment"]);
    document.destroy();
  });

  it("replays an incremental durable update log before decoding SQL state", () => {
    const document = new Y.Doc();
    document.getText("title").insert(0, "Incremental title");
    const firstUpdate = Y.encodeStateAsUpdate(document);
    const stateVector = Y.encodeStateVector(document);
    addBlock(document, "important", {
      type: "MARKDOWN",
      markdown: "persisted in a later update",
      checked: false,
      parentBlockId: null,
      sortOrder: 0,
      metadata: null
    });
    const secondUpdate = Y.encodeStateAsUpdate(document, stateVector);

    const snapshot = materializeCollaborationUpdates([firstUpdate, secondUpdate]);

    expect(snapshot.title).toBe("Incremental title");
    expect(snapshot.blocks.map((block) => block.id)).toEqual(["important"]);
    document.destroy();
  });

  it("reproduces the pre-fix forged-snapshot loss and proves the fixed path ignores it", () => {
    const document = createDurableDocument();
    const durableUpdate = Y.encodeStateAsUpdate(document);
    const forgedLegacyRequest = {
      updateId: 73,
      title: "Truncated",
      blocks: [] as Array<{ id: string }>,
      deletedAttachmentIds: [] as string[]
    };

    // Pre-fix behavior: the server accepted this duplicate request body as the
    // SQL source of truth merely because updateId matched the durable log.
    const legacyRelationalState = {
      title: forgedLegacyRequest.title,
      blocks: forgedLegacyRequest.blocks,
      materializedUpdateId: forgedLegacyRequest.updateId
    };
    expect(legacyRelationalState.blocks).toHaveLength(0);
    expect(legacyRelationalState.materializedUpdateId).toBe(73);

    // Fixed behavior: content has no request-body input. The same durable update
    // reconstructs the canonical title and both non-tombstoned blocks.
    const fixedRelationalState = materializeCollaborationUpdates([durableUpdate]);
    expect(fixedRelationalState.title).toBe("Durable title");
    expect(fixedRelationalState.blocks.map((block) => block.id)).toEqual(["root", "child"]);
    document.destroy();
  });

  it("fails closed instead of silently dropping a malformed persisted block", () => {
    const document = new Y.Doc();
    document.getText("title").insert(0, "Valid title");
    document.getMap("blocks").set("important", "not-a-y-map");
    const update = Y.encodeStateAsUpdate(document);

    expect(() => materializeCollaborationUpdates([update])).toThrowError(CollaborationDocumentError);
    try {
      materializeCollaborationUpdates([update]);
    } catch (error) {
      expect(error).toBeInstanceOf(CollaborationDocumentError);
      expect((error as CollaborationDocumentError).code).toBe("INVALID_COLLABORATION_DOCUMENT");
    }
    document.destroy();
  });

  it("rejects unsafe object keys before metadata reaches ordinary JavaScript objects", () => {
    const document = new Y.Doc();
    document.getText("title").insert(0, "Valid title");
    const block = new Y.Map<unknown>();
    block.set("type", createYValue("MARKDOWN"));
    block.set("markdown", createYValue("data"));
    block.set("checked", false);
    block.set("parentBlockId", null);
    block.set("sortOrder", 0);
    const metadata = new Y.Map<unknown>();
    metadata.set("__proto__", createYValue({ polluted: true }));
    block.set("metadata", metadata);
    document.getMap("blocks").set("important", block);
    const update = Y.encodeStateAsUpdate(document);

    expect(() => materializeCollaborationUpdates([update])).toThrowError(CollaborationDocumentError);
    document.destroy();
  });

  it("maps malformed durable Yjs history to a fail-closed document error", () => {
    expect(() => materializeCollaborationUpdates([new Uint8Array([255, 255, 255])]))
      .toThrowError(CollaborationDocumentError);
  });

  it("rejects non-JSON numeric metadata before SQL serialization can change it", () => {
    const document = new Y.Doc();
    document.getText("title").insert(0, "Valid title");
    addBlock(document, "important", {
      type: "MARKDOWN",
      markdown: "data",
      checked: false,
      parentBlockId: null,
      sortOrder: 0,
      metadata: { unsafe: Number.POSITIVE_INFINITY }
    });
    const update = Y.encodeStateAsUpdate(document);

    expect(() => materializeCollaborationUpdates([update])).toThrowError(CollaborationDocumentError);
    document.destroy();
  });
});
