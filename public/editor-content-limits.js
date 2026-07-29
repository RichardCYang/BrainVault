// @ts-check

export const PAGE_TITLE_MAX_LENGTH = 160;
export const BLOCK_MARKDOWN_MAX_LENGTH = 20_000;
export const EDITOR_CONTENT_LIMIT_EXCEEDED = "EDITOR_CONTENT_LIMIT_EXCEEDED";

export class EditorContentLimitError extends RangeError {
  constructor(field, maxLength, actualLength) {
    const label = field === "title" ? "Page title" : "Block content";
    super(`${label} cannot exceed ${maxLength} characters`);
    this.name = "EditorContentLimitError";
    this.code = EDITOR_CONTENT_LIMIT_EXCEEDED;
    this.field = field;
    this.maxLength = maxLength;
    this.actualLength = actualLength;
  }
}

function requireWithinLimit(value, field, maxLength) {
  const text = String(value ?? "");
  if (text.length > maxLength) {
    throw new EditorContentLimitError(field, maxLength, text.length);
  }
  return text;
}

export function requirePageTitleWithinLimit(value) {
  return requireWithinLimit(value, "title", PAGE_TITLE_MAX_LENGTH);
}

export function requireBlockMarkdownWithinLimit(value) {
  return requireWithinLimit(value, "markdown", BLOCK_MARKDOWN_MAX_LENGTH);
}
