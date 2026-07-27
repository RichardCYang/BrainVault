import { describe, expect, it } from "vitest";
import {
  CollaborationDocumentError,
  validateCollaborationBlockHierarchy
} from "../src/lib/collaboration-document.js";

function expectDocumentError(action: () => unknown, code: string) {
  expect(action).toThrowError(CollaborationDocumentError);
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(CollaborationDocumentError);
    expect((error as CollaborationDocumentError).code).toBe(code);
  }
}

describe("collaboration document hierarchy", () => {
  it("orders parents before children and siblings by sort order", () => {
    const result = validateCollaborationBlockHierarchy([
      { id: "child-b", parentBlockId: "root", sortOrder: 20 },
      { id: "root", parentBlockId: null, sortOrder: 10 },
      { id: "child-a", parentBlockId: "root", sortOrder: 10 }
    ]);

    expect(result.map((block) => block.id)).toEqual(["root", "child-a", "child-b"]);
  });

  it("rejects duplicate IDs, missing parents, self-parenting, and cycles", () => {
    expectDocumentError(
      () => validateCollaborationBlockHierarchy([
        { id: "same", parentBlockId: null, sortOrder: 0 },
        { id: "same", parentBlockId: null, sortOrder: 1 }
      ]),
      "DUPLICATE_BLOCK_ID"
    );
    expectDocumentError(
      () => validateCollaborationBlockHierarchy([
        { id: "orphan", parentBlockId: "missing", sortOrder: 0 }
      ]),
      "INVALID_PARENT_BLOCK"
    );
    expectDocumentError(
      () => validateCollaborationBlockHierarchy([
        { id: "self", parentBlockId: "self", sortOrder: 0 }
      ]),
      "INVALID_PARENT_BLOCK"
    );
    expectDocumentError(
      () => validateCollaborationBlockHierarchy([
        { id: "a", parentBlockId: "b", sortOrder: 0 },
        { id: "b", parentBlockId: "a", sortOrder: 0 }
      ]),
      "INVALID_PARENT_BLOCK"
    );
  });

  it("handles an adversarially deep tree iteratively and enforces the 128-level limit", () => {
    const blocks = Array.from({ length: 130 }, (_, index) => ({
      id: `depth-${index}`,
      parentBlockId: index === 0 ? null : `depth-${index - 1}`,
      sortOrder: index
    }));

    expectDocumentError(() => validateCollaborationBlockHierarchy(blocks), "BLOCK_NESTING_TOO_DEEP");
  });
});
