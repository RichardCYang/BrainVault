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

// Mirrors of the server's per-page budgets (src/lib/page-resource-limits.ts).
// The client only uses them to refuse a split paste up front instead of
// stopping halfway; the server stays the authority.
export const PAGE_MAX_BLOCKS = 20_000;
// A shared page is one real-time document (sharedPageResourceLimits).
export const SHARED_PAGE_MAX_BLOCKS = 5_000;
export const PAGE_MAX_MARKDOWN_BYTES = 4 * 1024 * 1024;

const fenceOpenPattern = /^ {0,3}(`{3,}|~{3,})/;
const fenceClosePattern = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

function isHighSurrogate(code) {
  return code >= 0xd800 && code <= 0xdbff;
}

// Picks where the first chunk of `window` ends. Paragraph breaks outside code
// fences come first, then line breaks, then spaces, then a hard cut. A cut in
// the back half is preferred so chunks stay full.
function chooseChunkCut(window, maxLength, trackFences, minEnd) {
  const candidates = { paragraph: [], line: [], space: [] };
  let fence = null;
  let lineStart = 0;
  for (let index = 0; index <= window.length; index += 1) {
    const atEnd = index === window.length;
    const char = window[index];
    if (!atEnd && (char === " " || char === "\t")) {
      candidates.space.push({ end: index, resume: index + 1, fence });
      continue;
    }
    if (!atEnd && char !== "\n") continue;
    if (atEnd) break;
    const line = window.slice(lineStart, index);
    if (trackFences) {
      if (!fence) {
        const open = fenceOpenPattern.exec(line);
        if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
          fence = { char: open[1][0], length: open[1].length, marker: open[1], opening: line };
        }
      } else {
        const close = fenceClosePattern.exec(line);
        if (close && close[1][0] === fence.char && close[1].length >= fence.length) fence = null;
      }
    }
    candidates.line.push({ end: index, resume: index + 1, fence });
    let runEnd = index;
    while (window[runEnd] === "\n") runEnd += 1;
    if (runEnd - index >= 2 && !fence) candidates.paragraph.push({ end: index, resume: runEnd, fence: null });
    // Blank lines inside the run are lines of their own; skip them.
    if (runEnd - index >= 2) {
      for (let blank = index + 1; blank < runEnd; blank += 1) {
        candidates.line.push({ end: blank, resume: blank + 1, fence });
      }
      index = runEnd - 1;
    }
    lineStart = index + 1;
  }

  const fits = (cut) => cut.end >= minEnd
    && cut.end + (cut.fence ? cut.fence.marker.length + 1 : 0) <= maxLength;
  const half = minEnd + Math.floor((maxLength - minEnd) / 2);
  for (const floor of [half, minEnd]) {
    for (const kind of ["paragraph", "line", "space"]) {
      const list = candidates[kind];
      for (let index = list.length - 1; index >= 0; index -= 1) {
        const cut = list[index];
        if (cut.end < floor) break;
        if (fits(cut)) return cut;
      }
    }
  }

  // No break at all: cut hard, never between the halves of a surrogate pair.
  // A fence still open here is the one the last line break saw.
  const openFence = candidates.line.length ? candidates.line[candidates.line.length - 1].fence : null;
  let end = maxLength - (openFence ? openFence.marker.length + 1 : 0);
  if (end > minEnd && isHighSurrogate(window.charCodeAt(end - 1))) end -= 1;
  return { end, resume: end, fence: openFence };
}

/**
 * Splits text that is too long for one block into block-sized chunks, so a
 * long paste becomes several blocks instead of being refused or cut. Only the
 * line breaks or the single space at each cut are dropped: every other
 * character is kept, in order. A Markdown code fence open at a cut is closed
 * at the end of that chunk and reopened at the start of the next, so each
 * chunk still renders as code.
 */
export function splitTextIntoBlockChunks(text, maxLength = BLOCK_MARKDOWN_MAX_LENGTH, { markdownFences = true } = {}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 64) throw new RangeError("Chunk length must be at least 64");
  const source = String(text ?? "").replace(/\r\n?/g, "\n");
  if (source.length <= maxLength) return [source];
  const chunks = [];
  let offset = 0;
  let prefix = "";
  for (;;) {
    const available = maxLength - prefix.length;
    if (source.length - offset <= available) {
      chunks.push(prefix + source.slice(offset));
      return chunks;
    }
    const window = prefix + source.slice(offset, offset + available + 1);
    const cut = chooseChunkCut(window, maxLength, markdownFences, prefix.length + 1);
    let chunk = window.slice(0, cut.end);
    let nextPrefix = "";
    if (cut.fence) {
      chunk += `\n${cut.fence.marker}`;
      // A very long opening line would leave no room; reopen with the bare marker.
      nextPrefix = `${cut.fence.opening.length <= maxLength / 4 ? cut.fence.opening : cut.fence.marker}\n`;
    }
    chunks.push(chunk);
    offset += cut.resume - prefix.length;
    prefix = nextPrefix;
  }
}
