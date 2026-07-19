import { describe, expect, it } from "vitest";
import { rebaseCommittedBlockContent, rebaseCommittedPageTitle } from "../public/save-rebase.js";

describe("save response rebasing", () => {
  it("preserves a newer local title while accepting the committed server version", () => {
    const committed = { id: "page-1", title: "older request", version: 8, updatedAt: "server-time" };

    const rebased = rebaseCommittedPageTitle(committed, "newer local title");

    expect(rebased).toEqual({
      id: "page-1",
      title: "newer local title",
      version: 8,
      updatedAt: "server-time"
    });
    expect(committed.title).toBe("older request");
  });

  it("returns the committed page unchanged when there is no newer local title", () => {
    const committed = { id: "page-1", title: "saved", version: 2 };
    expect(rebaseCommittedPageTitle(committed)).toBe(committed);
  });

  it("preserves newer local block content while accepting committed concurrency metadata", () => {
    const committed = {
      id: "block-1",
      type: "MARKDOWN",
      markdown: "older request",
      checked: false,
      metadata: null,
      htmlCache: "<p>older request</p>",
      version: 12,
      updatedAt: "server-time",
      parentBlockId: null,
      sortOrder: 4
    };
    const localPayload = {
      type: "TODO",
      markdown: "newer local content",
      checked: true,
      metadata: { textAlign: "center" },
      version: 999,
      sortOrder: 999
    };

    const rebased = rebaseCommittedBlockContent(committed, localPayload);

    expect(rebased).toMatchObject({
      id: "block-1",
      type: "TODO",
      markdown: "newer local content",
      checked: true,
      metadata: { textAlign: "center" },
      htmlCache: null,
      version: 12,
      updatedAt: "server-time",
      parentBlockId: null,
      sortOrder: 4
    });
    expect(committed.markdown).toBe("older request");
  });

  it("returns the committed block unchanged when no newer local payload exists", () => {
    const committed = { id: "block-1", markdown: "saved", version: 3 };
    expect(rebaseCommittedBlockContent(committed)).toBe(committed);
  });
});
