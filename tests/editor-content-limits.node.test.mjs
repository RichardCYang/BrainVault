import assert from "node:assert/strict";
import test from "node:test";
import {
  BLOCK_MARKDOWN_MAX_LENGTH,
  EDITOR_CONTENT_LIMIT_EXCEEDED,
  PAGE_TITLE_MAX_LENGTH,
  requireBlockMarkdownWithinLimit,
  requirePageTitleWithinLimit
} from "../public/editor-content-limits.js";

test("collaboration title validation preserves an exact-limit value", () => {
  const title = "t".repeat(PAGE_TITLE_MAX_LENGTH);
  assert.equal(requirePageTitleWithinLimit(title), title);
});

test("collaboration title validation rejects rather than truncates an over-limit value", () => {
  const title = `${"t".repeat(PAGE_TITLE_MAX_LENGTH)}-must-survive`;
  assert.throws(
    () => requirePageTitleWithinLimit(title),
    (error) => {
      assert.equal(error.code, EDITOR_CONTENT_LIMIT_EXCEEDED);
      assert.equal(error.field, "title");
      assert.equal(error.actualLength, title.length);
      return true;
    }
  );
});

test("collaboration block validation rejects rather than truncates an over-limit value", () => {
  const markdown = `${"m".repeat(BLOCK_MARKDOWN_MAX_LENGTH)}-must-survive`;
  assert.throws(
    () => requireBlockMarkdownWithinLimit(markdown),
    (error) => {
      assert.equal(error.code, EDITOR_CONTENT_LIMIT_EXCEEDED);
      assert.equal(error.field, "markdown");
      assert.equal(error.actualLength, markdown.length);
      return true;
    }
  );
});

test("collaboration block validation preserves an exact-limit value", () => {
  const markdown = "m".repeat(BLOCK_MARKDOWN_MAX_LENGTH);
  assert.equal(requireBlockMarkdownWithinLimit(markdown), markdown);
});
