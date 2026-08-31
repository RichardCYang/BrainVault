import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { BlockType } from "../types/domain.js";
import { getCalloutType } from "./callout.js";
import { formatAttachmentSize, getAttachmentInfo, sanitizeAttachmentFilename } from "./attachments.js";
import { getTableData } from "./table.js";
import { renderKanbanHtml } from "./kanban.js";
import { renderDatabaseHtml } from "./database.js";
import { renderTreeViewHtml } from "./treeview.js";
import { renderTimetableHtml } from "./timetable.js";
import { renderGanttHtml } from "./gantt.js";
import { renderBookmarkHtml } from "./bookmark.js";
import { getAiChatData, getAiProviderLabel } from "./ai-chat.js";
import { renderAccordionHtml } from "./accordion.js";
import { getCodeLanguage, renderHighlightedCode, renderMarkdownCodeFence } from "./code-highlighting.js";
import { parseYouTubeVideoUrl } from "./youtube.js";
import { validateStoredBlockMetadata } from "./structured-metadata-integrity.js";

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: true,
  highlight: (source, language) => renderMarkdownCodeFence(source, language)
});

const aiChatCjkStrongEmphasisEnvKey = "__brainVaultAiChatCjkStrongEmphasis";
const aiChatNumericReferenceLinksEnvKey = "__brainVaultAiChatNumericReferenceLinks";
const aiChatCitationReferenceClass = "rendered-ai-chat-citation-reference";
const cjkOrFullwidthCharacterPattern = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const aiChatNumericReferenceLabelPattern = /^\s*(\d{1,3})\s*$/;
const aiChatGroupedNumericReferenceLabelPattern = /^\s*(\d{1,3}(?:\s*,\s*\d{1,3})+)\s*$/;

function codePointBefore(value: string, position: number) {
  if (position <= 0) return null;
  const trailingCodeUnit = value.charCodeAt(position - 1);
  if ((trailingCodeUnit & 0xfc00) === 0xdc00 && position > 1) {
    return value.codePointAt(position - 2) ?? trailingCodeUnit;
  }
  return trailingCodeUnit;
}

function codePointAt(value: string, position: number) {
  if (position < 0 || position >= value.length) return null;
  return value.codePointAt(position) ?? null;
}

function isCjkOrFullwidthCodePoint(codePoint: number | null) {
  if (codePoint === null) return false;
  return cjkOrFullwidthCharacterPattern.test(String.fromCodePoint(codePoint));
}

/**
 * CommonMark's delimiter-flanking rules can reject `**` next to CJK text
 * when punctuation sits on the other side of the marker. AI answers commonly
 * contain natural Korean/Chinese/Japanese prose without spaces, so preserve
 * markdown-it's normal decision first and only relax failed asterisk runs in
 * the explicitly opted-in AI-answer environment. Underscore emphasis and all
 * non-CJK rendering keep the stock markdown-it behavior.
 */
function enableAiChatCjkStrongEmphasis(markdownIt: MarkdownIt) {
  const InlineState = (markdownIt.inline as any).State;
  (markdownIt.inline as any).State = class BrainVaultInlineState extends InlineState {
    scanDelims(start: number, canSplitWord: boolean) {
      const scanned = super.scanDelims(start, canSplitWord);
      const environment = this.env as Record<string, unknown> | undefined;
      if (
        environment?.[aiChatCjkStrongEmphasisEnvKey] !== true
        || !canSplitWord
        || this.src.charCodeAt(start) !== 0x2a
        || scanned.length !== 2
      ) {
        return scanned;
      }

      const previousCodePoint = codePointBefore(this.src, start);
      const nextCodePoint = codePointAt(this.src, start + scanned.length);
      if (!isCjkOrFullwidthCodePoint(previousCodePoint) && !isCjkOrFullwidthCodePoint(nextCodePoint)) {
        return scanned;
      }

      const previousIsWhitespace = previousCodePoint === null || this.md.utils.isWhiteSpace(previousCodePoint);
      const nextIsWhitespace = nextCodePoint === null || this.md.utils.isWhiteSpace(nextCodePoint);
      return {
        ...scanned,
        can_open: scanned.can_open || !nextIsWhitespace,
        can_close: scanned.can_close || !previousIsWhitespace
      };
    }
  };
}

enableAiChatCjkStrongEmphasis(markdown);

function findAiChatBacktickSpanEnd(value: string, start: number) {
  let runLength = 1;
  while (value[start + runLength] === "`") runLength += 1;

  let searchFrom = start + runLength;
  const marker = "`".repeat(runLength);
  while (searchFrom < value.length) {
    const candidate = value.indexOf(marker, searchFrom);
    if (candidate < 0) return -1;
    if (value[candidate - 1] !== "`" && value[candidate + runLength] !== "`") {
      return candidate + runLength;
    }
    searchFrom = candidate + 1;
  }
  return -1;
}

function findAiChatReferenceLabelEnd(value: string, start: number) {
  if (value[start] !== "[") return -1;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "`") {
      const codeSpanEnd = findAiChatBacktickSpanEnd(value, index);
      if (codeSpanEnd > index) {
        index = codeSpanEnd - 1;
        continue;
      }
    }
    // markdown-it rejects nested links while parsing the outer link label.
    // Staying conservative here prevents malformed Markdown from being
    // rewritten into a valid citation by this AI-only compatibility rule.
    if (character === "[") return -1;
    if (character === "]") return index;
  }
  return -1;
}

function normalizeAiChatNumericReferenceLinks(value: string, availableReferences: Set<string>) {
  if (!availableReferences.size) return value;

  let output = "";
  let index = 0;
  while (index < value.length) {
    const character = value[index];
    if (character === "\\") {
      output += value.slice(index, Math.min(index + 2, value.length));
      index += 2;
      continue;
    }
    if (character === "`") {
      const codeSpanEnd = findAiChatBacktickSpanEnd(value, index);
      if (codeSpanEnd > index) {
        output += value.slice(index, codeSpanEnd);
        index = codeSpanEnd;
        continue;
      }
    }
    if (character !== "[" || value[index - 1] === "!") {
      output += character;
      index += 1;
      continue;
    }

    const titleEnd = findAiChatReferenceLabelEnd(value, index);
    if (titleEnd < 0) {
      output += character;
      index += 1;
      continue;
    }

    const titleLabel = value.slice(index + 1, titleEnd);
    const groupedReferenceMatch = titleLabel.match(aiChatGroupedNumericReferenceLabelPattern);
    const nextCharacter = value[titleEnd + 1] ?? "";
    if (
      groupedReferenceMatch
      && value[index - 1] !== "["
      && nextCharacter !== "("
      && nextCharacter !== "["
    ) {
      const groupedReferences = groupedReferenceMatch[1]
        .split(",")
        .map((reference) => reference.trim())
        .filter(Boolean);
      if (groupedReferences.length > 1 && groupedReferences.every((reference) => availableReferences.has(reference))) {
        // A marker like [1, 2] is not itself a CommonMark reference link even
        // when [1]: and [2]: definitions exist. Expand it into adjacent numeric
        // reference links while the parser still has access to env.references.
        // The read-mode hydrator can then collapse those anchors into one chip
        // whose tooltip retains every source in the original group.
        output += `\\[${groupedReferences.map((reference) => `[${reference}][${reference}]`).join(", ")}\\]`;
        index = titleEnd + 1;
        continue;
      }
    }

    const referenceStart = titleEnd + 1;
    if (value[referenceStart] !== "[") {
      output += character;
      index += 1;
      continue;
    }

    const referenceEnd = findAiChatReferenceLabelEnd(value, referenceStart);
    if (referenceEnd < 0) {
      output += character;
      index += 1;
      continue;
    }

    const referenceMatch = value.slice(referenceStart + 1, referenceEnd).match(aiChatNumericReferenceLabelPattern);
    const referenceNumber = referenceMatch?.[1] ?? "";
    if (!referenceNumber || !availableReferences.has(referenceNumber)) {
      output += character;
      index += 1;
      continue;
    }

    // markdown-it 14.x resolves [title][1] to an <a> whose visible text is
    // only "title" and does not retain the numeric reference label. The read
    // mode citation hydrator intentionally recognizes numeric link text, so
    // rewrite only explicit numeric reference links in AI answers to the
    // equivalent [1][1] form. The URL still comes from the original reference
    // definition and ordinary inline/nonnumeric links remain untouched.
    output += `[${referenceNumber}][${referenceNumber}]`;
    index = referenceEnd + 1;
  }
  return output;
}

markdown.core.ruler.before("inline", "ai_chat_numeric_reference_links", (state: any) => {
  if (state.env?.[aiChatNumericReferenceLinksEnvKey] !== true) return;
  const references = state.env?.references;
  if (!references || typeof references !== "object") return;

  const availableReferences = new Set(
    Object.keys(references).filter((label) => /^\d{1,3}$/.test(label))
  );
  if (!availableReferences.size) return;

  state.tokens.forEach((token: any) => {
    if (token?.type !== "inline" || typeof token.content !== "string") return;
    token.content = normalizeAiChatNumericReferenceLinks(token.content, availableReferences);
  });
});

// markdown-it 14.x does not expose the originating reference label on
// link tokens. After inline parsing, positively identify numeric links by
// matching their visible number and normalized href against env.references.
// The class survives sanitization and lets read mode distinguish a genuine
// reference citation in the middle of prose from an arbitrary numeric link.
markdown.core.ruler.after("inline", "ai_chat_mark_numeric_reference_links", (state: any) => {
  if (state.env?.[aiChatNumericReferenceLinksEnvKey] !== true) return;
  const references = state.env?.references;
  if (!references || typeof references !== "object") return;

  state.tokens.forEach((token: any) => {
    if (token?.type !== "inline" || !Array.isArray(token.children)) return;
    const children = token.children;
    for (let index = 0; index + 2 < children.length; index += 1) {
      const linkOpen = children[index];
      const labelToken = children[index + 1];
      const linkClose = children[index + 2];
      if (linkOpen?.type !== "link_open" || labelToken?.type !== "text" || linkClose?.type !== "link_close") continue;

      const referenceNumber = String(labelToken.content ?? "").match(aiChatNumericReferenceLabelPattern)?.[1] ?? "";
      if (!referenceNumber) continue;
      const definition = references[referenceNumber];
      const definitionHref = typeof definition?.href === "string" ? definition.href : "";
      const renderedHref = typeof linkOpen.attrGet === "function" ? (linkOpen.attrGet("href") ?? "") : "";
      if (!definitionHref || !renderedHref) continue;

      const normalizedDefinitionHref = markdown.normalizeLink(definitionHref);
      if (normalizedDefinitionHref !== renderedHref) continue;
      linkOpen.attrJoin("class", aiChatCitationReferenceClass);
    }
  });
});

function renderMathPlaceholder(latex: string, displayMode: boolean) {
  const source = latex.trim();
  const escaped = markdown.utils.escapeHtml(source);
  const tag = displayMode ? "div" : "span";
  const mode = displayMode ? "display" : "inline";
  return `<${tag} class="math-expression math-expression--${mode}" data-latex="${escaped}" data-math-display="${String(displayMode)}">${escaped}</${tag}>`;
}

function renderMermaidSourcePlaceholder(source: string) {
  const escaped = markdown.utils.escapeHtml(source.trim());
  return sanitizeHtml(
    `<pre class="rendered-mermaid-source"><code class="language-mermaid">${escaped}</code></pre>`,
    sanitizeOptions
  );
}

function mathInlineParensRule(state: any, silent: boolean) {
  const start = state.pos;
  if (state.src.slice(start, start + 2) !== "\\(") return false;
  const end = state.src.indexOf("\\)", start + 2);
  if (end < 0 || state.src.slice(start + 2, end).includes("\n")) return false;
  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = state.src.slice(start + 2, end).trim();
    token.markup = "\\(\\)";
  }
  state.pos = end + 2;
  return true;
}

function mathInlineDollarRule(state: any, silent: boolean) {
  const start = state.pos;
  if (state.src[start] !== "$" || state.src[start + 1] === "$" || /\s/.test(state.src[start + 1] ?? "")) {
    return false;
  }

  let end = start + 1;
  while ((end = state.src.indexOf("$", end)) >= 0) {
    let slashCount = 0;
    for (let index = end - 1; index >= 0 && state.src[index] === "\\"; index -= 1) slashCount += 1;
    if (slashCount % 2 === 0) break;
    end += 1;
  }
  if (end < 0 || /\s/.test(state.src[end - 1] ?? "") || state.src.slice(start + 1, end).includes("\n")) {
    return false;
  }

  if (!silent) {
    const token = state.push("math_inline", "span", 0);
    token.content = state.src.slice(start + 1, end).trim();
    token.markup = "$";
  }
  state.pos = end + 1;
  return true;
}

function mathBlockRule(state: any, startLine: number, endLine: number, silent: boolean) {
  const start = state.bMarks[startLine] + state.tShift[startLine];
  const max = state.eMarks[startLine];
  const firstLine = state.src.slice(start, max);
  if (!firstLine.startsWith("$$")) return false;

  const singleLine = firstLine.trim();
  let content = "";
  let nextLine = startLine + 1;

  if (singleLine.length > 4 && singleLine.endsWith("$$")) {
    content = singleLine.slice(2, -2);
  } else {
    content = firstLine.slice(2);
    let closed = false;
    for (; nextLine < endLine; nextLine += 1) {
      const lineStart = state.bMarks[nextLine] + state.tShift[nextLine];
      const lineEnd = state.eMarks[nextLine];
      const line = state.src.slice(lineStart, lineEnd);
      const closing = line.indexOf("$$");
      if (closing >= 0) {
        content += `${content ? "\n" : ""}${line.slice(0, closing)}`;
        nextLine += 1;
        closed = true;
        break;
      }
      content += `${content ? "\n" : ""}${line}`;
    }
    if (!closed) return false;
  }

  if (silent) return true;
  state.line = nextLine;
  const token = state.push("math_block", "div", 0);
  token.block = true;
  token.content = content.trim();
  token.map = [startLine, nextLine];
  token.markup = "$$";
  return true;
}

markdown.inline.ruler.before("escape", "math_inline_parens", mathInlineParensRule);
markdown.inline.ruler.before("text", "math_inline_dollar", mathInlineDollarRule);
markdown.block.ruler.before("fence", "math_block", mathBlockRule, {
  alt: ["paragraph", "reference", "blockquote", "list"]
});
markdown.renderer.rules.math_inline = (tokens, index) => renderMathPlaceholder(tokens[index].content, false);
markdown.renderer.rules.math_block = (tokens, index) => `${renderMathPlaceholder(tokens[index].content, true)}\n`;

const forbiddenRenderedTags = new Set(["script", "style", "svg", "math", "textarea", "xmp"]);

const allowedTags = sanitizeHtml.defaults.allowedTags.concat([
  "div",
  "img",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "pre",
  "code",
  "span",
  "input",
  "hr",
  "table",
  "section",
  "article",
  "header",
  "small",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "time",
  "iframe",
  "details",
  "summary"
]).filter((tagName) => !forbiddenRenderedTags.has(tagName));

const allowedAttributes: sanitizeHtml.IOptions["allowedAttributes"] = {
  ...sanitizeHtml.defaults.allowedAttributes,
  a: ["class", "href", "name", "target", "rel"],
  div: ["class", "data-latex", "data-math-display"],
  section: ["class"],
  article: ["class"],
  header: ["class"],
  small: ["class"],
  p: ["class"],
  img: ["src", "alt", "title", "width", "height", "loading", "referrerpolicy"],
  pre: ["class"],
  code: ["class"],
  span: ["class", "style", "data-latex", "data-math-display", "data-icon-value", "aria-hidden"],
  input: ["type", "checked", "disabled"],
  table: ["class"],
  thead: ["class"],
  tbody: ["class"],
  tr: ["class"],
  th: ["class", "scope"],
  td: ["class", "colspan"],
  time: ["class", "datetime"],
  iframe: ["class", "src", "title", "loading", "allowfullscreen", "referrerpolicy"],
  details: ["class", "open"],
  summary: ["class"],
  ul: ["class"],
  ol: ["class"],
  li: ["class"]
};

function normalizeRenderedImageSource(value: unknown) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return "";

  // Persisted HTML may render only same-origin application paths or bounded
  // raster-image data URLs. Do not preserve absolute/protocol-relative URLs:
  // collaborator-authored markup must never trigger third-party viewer egress.
  if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\")) {
    return source;
  }
  if (/^data:image\/(?:png|jpeg|webp|vnd\.microsoft\.icon|x-icon);base64,[a-z0-9+/]+={0,2}$/i.test(source)) {
    return source;
  }
  return "";
}

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes,
  allowedStyles: {
    span: {
      color: [/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i],
      "grid-column": [/^\d+(?: \/ span \d+)?$/],
      width: [/^(?:100|[1-9]?\d)%$/]
    }
  },
  allowProtocolRelative: false,
  allowedSchemes: ["http", "https", "mailto"],
  allowedSchemesByTag: { img: ["data"] },
  allowedIframeHostnames: ["www.youtube-nocookie.com", "www.youtube.com"],
  exclusiveFilter: (frame) => frame.tag === "input" && frame.attribs.type !== "checkbox",
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    img: (tagName, attribs) => {
      const nextAttributes: sanitizeHtml.Attributes = {
        ...attribs,
        loading: "lazy",
        referrerpolicy: "no-referrer"
      };
      const safeSource = normalizeRenderedImageSource(attribs.src);
      if (safeSource) nextAttributes.src = safeSource;
      else delete nextAttributes.src;
      delete nextAttributes.srcset;
      return { tagName, attribs: nextAttributes };
    }
  }
};

// AI chat pagination controls are generated by the server after each question
// and answer has already passed through renderMarkdown()/sanitizeRenderedHtml().
// Keep interactive button allowances scoped to this trusted wrapper so raw
// Markdown cannot forge application controls or data attributes.
const aiChatSanitizeOptions: sanitizeHtml.IOptions = {
  ...sanitizeOptions,
  allowedTags: [...allowedTags, "button", "nav"],
  allowedAttributes: {
    ...allowedAttributes,
    nav: ["class", "aria-label"],
    section: ["class", "aria-hidden"],
    button: ["class", "type", "data-ai-chat-page", "aria-label", "aria-current"]
  }
};

/**
 * Treat persisted/rendered HTML as untrusted at every read boundary.
 *
 * html_cache is a derived performance field, not an authorization or trust
 * boundary. Re-sanitizing it prevents legacy rows, manual database changes, or
 * output produced by an older sanitizer version from reaching DOM HTML sinks
 * without passing through the currently configured policy.
 */
export function sanitizeRenderedHtml(value: unknown) {
  return sanitizeHtml(typeof value === "string" ? value : "", sanitizeOptions);
}

/**
 * Re-sanitize a persisted block cache with the policy for that block type.
 *
 * AI_CHAT is the only block that intentionally renders server-generated
 * pagination controls. Keeping that allowance type-scoped preserves those
 * controls without broadening the generic Markdown/read-boundary policy.
 */
export function sanitizeRenderedBlockHtml(type: BlockType, value: unknown) {
  const options = type === "AI_CHAT" ? aiChatSanitizeOptions : sanitizeOptions;
  return sanitizeHtml(typeof value === "string" ? value : "", options);
}

const textAlignments = new Set(["left", "center", "right", "justify"]);

function getTextAlign(metadata: unknown) {
  let source: Record<string, unknown> = {};
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    source = metadata as Record<string, unknown>;
  } else if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        source = parsed as Record<string, unknown>;
      }
    } catch {
      source = {};
    }
  }
  const value = source.textAlign;
  return typeof value === "string" && textAlignments.has(value) ? value : "left";
}

function renderTextAlignment(html: string, metadata: unknown) {
  const textAlign = getTextAlign(metadata);
  if (textAlign === "left") return html;
  return sanitizeHtml(
    `<div class="rendered-text-alignment rendered-text-alignment--${textAlign}">${html}</div>`,
    sanitizeOptions
  );
}

function stripHeadingMarks(raw: string) {
  return raw.replace(/^\s*#{1,6}\s+/, "").trim();
}

function stripBlockquoteMarks(raw: string) {
  return raw.replace(/^\s*>\s?/gm, "");
}

function stripListItemMarker(raw: string, type: "UNORDERED_LIST" | "ORDERED_LIST") {
  const pattern = type === "ORDERED_LIST" ? /^\s*\d+[.)]\s+/ : /^\s*[-+*]\s+/;
  return raw.replace(pattern, "").trim();
}

function renderListBlock(type: "UNORDERED_LIST" | "ORDERED_LIST", raw: string) {
  const tag = type === "ORDERED_LIST" ? "ol" : "ul";
  const variant = type === "ORDERED_LIST" ? "ordered" : "unordered";
  const items = raw
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => stripListItemMarker(line, type))
    .filter(Boolean)
    .map((item) => `<li>${markdown.renderInline(item)}</li>`)
    .join("");

  return sanitizeHtml(
    `<${tag} class="rendered-list rendered-list--${variant}">${items}</${tag}>`,
    sanitizeOptions
  );
}

function stripFence(raw: string) {
  return raw.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
}

function stripMarkdownImage(raw: string) {
  const match = raw.trim().match(/^!?\[[^\]]*\]\(([^)]+)\)$/);
  return match?.[1]?.trim() ?? raw.trim();
}

function parseMetadataRecord(metadata: unknown) {
  if (metadata && typeof metadata === "object" && !Array.isArray(metadata)) {
    return metadata as Record<string, unknown>;
  }
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Invalid legacy metadata is ignored instead of affecting rendering.
    }
  }
  return {};
}

function splitToggleMarkdown(raw: string) {
  const normalized = String(raw ?? "").replace(/\r\n?/g, "\n");
  const newlineIndex = normalized.indexOf("\n");
  if (newlineIndex < 0) return { title: normalized.trim(), body: "" };
  return {
    title: normalized.slice(0, newlineIndex).trim(),
    body: normalized.slice(newlineIndex + 1)
  };
}

function renderToggle(raw: string, metadata: unknown) {
  const { title, body } = splitToggleMarkdown(raw);
  const summarySource = title || "Toggle";
  const summary = sanitizeHtml(markdown.renderInline(summarySource), sanitizeOptions);
  const content = body.trim()
    ? renderMarkdown(body)
    : '<p class="rendered-toggle-empty"></p>';
  const open = parseMetadataRecord(metadata).toggleOpen !== false ? " open" : "";
  return sanitizeHtml(
    `<details class="rendered-toggle"${open}><summary class="rendered-toggle-summary">${summary}</summary><div class="rendered-toggle-content">${content}</div></details>`,
    sanitizeOptions
  );
}

function renderTableCell(raw: string) {
  return sanitizeHtml(markdown.renderInline(raw ?? ""), sanitizeOptions);
}

function renderYouTubeVideo(raw: string) {
  const video = parseYouTubeVideoUrl(raw);
  if (!video) {
    return sanitizeHtml(
      `<div class="rendered-youtube-video rendered-youtube-video--invalid">Paste a valid YouTube video URL.</div>`,
      sanitizeOptions
    );
  }

  return sanitizeHtml(
    `<section class="rendered-youtube-video">
      <div class="rendered-youtube-video-frame youtube-video-frame">
        <iframe class="youtube-video-iframe" src="${video.embedUrl}" title="YouTube video player" loading="lazy" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      </div>
      <a class="youtube-video-open-link" href="${video.watchUrl}" target="_blank" rel="noopener noreferrer">Watch on YouTube</a>
    </section>`,
    sanitizeOptions
  );
}


function renderAiChat(metadata: unknown) {
  const data = getAiChatData(metadata);
  const escapeText = (value: string) => sanitizeHtml(value, { allowedTags: [], allowedAttributes: {} });
  const provider = escapeText(getAiProviderLabel(data.provider));
  const model = escapeText(data.model);
  const title = escapeText(data.title);
  const paginated = data.layout === "paginated";
  const answerBorderClass = data.hideAnswerBorder ? " rendered-ai-chat--hide-answer-border" : "";
  const turns = data.turns.map((turn, index) => {
    const answeredAt = escapeText(turn.answeredAt);
    const question = renderMarkdown(turn.question);
    const answer = renderAiChatAnswerMarkdown(turn.answer);
    const activeClass = paginated && index === 0 ? " is-active" : "";
    const hiddenAttribute = paginated && index !== 0 ? ' aria-hidden="true"' : paginated ? ' aria-hidden="false"' : "";
    return `<section class="rendered-ai-chat-turn${activeClass}"${hiddenAttribute}>
      <article class="rendered-ai-chat-message rendered-ai-chat-question">
        <header class="rendered-ai-chat-meta"><strong>Q${index + 1}</strong></header>
        <div class="rendered-ai-chat-content">${question}</div>
      </article>
      <article class="rendered-ai-chat-message rendered-ai-chat-answer">
        <header class="rendered-ai-chat-meta"><strong>${provider}</strong>${model ? `<span class="rendered-ai-chat-model">${model}</span>` : ""}${answeredAt ? `<small class="rendered-ai-chat-time">${answeredAt}</small>` : ""}</header>
        <div class="rendered-ai-chat-content">${answer}</div>
      </article>
    </section>`;
  }).join("");

  const pagination = paginated && data.turns.length > 1
    ? `<nav class="rendered-ai-chat-pagination" aria-label="AI conversation pages">${data.turns.map((_, index) => (
      `<button type="button" class="rendered-ai-chat-page${index === 0 ? " is-current" : ""}" data-ai-chat-page="${index}" aria-label="Show question and answer pair ${index + 1}"${index === 0 ? ' aria-current="page"' : ""}>${index + 1}</button>`
    )).join("")}</nav>`
    : "";

  return sanitizeHtml(
    `<section class="rendered-ai-chat${paginated ? " rendered-ai-chat--paginated" : ""}${answerBorderClass}">${title ? `<div class="rendered-ai-chat-title">${title}</div>` : ""}<div class="rendered-ai-chat-viewport"><div class="rendered-ai-chat-track">${turns}</div></div>${pagination}</section>`,
    aiChatSanitizeOptions
  );
}

function renderTable(metadata: unknown) {
  const table = getTableData(metadata);
  const bodyRows = table.headerRow ? table.rows.slice(1) : table.rows;
  const renderRow = (row: string[], rowIndex: number, headerSection = false) => {
    const cells = row.map((cell, columnIndex) => {
      const isHeader = headerSection || (table.headerColumn && columnIndex === 0);
      const tag = isHeader ? "th" : "td";
      const scope = headerSection ? ' scope="col"' : table.headerColumn && columnIndex === 0 ? ' scope="row"' : "";
      const className = isHeader ? ' class="rendered-table-header"' : "";
      return `<${tag}${scope}${className}>${renderTableCell(cell)}</${tag}>`;
    });
    return `<tr class="rendered-table-row rendered-table-row--${rowIndex}">${cells.join("")}</tr>`;
  };

  const head = table.headerRow
    ? `<thead class="rendered-table-head">${renderRow(table.rows[0], 0, true)}</thead>`
    : "";
  const body = `<tbody class="rendered-table-body">${bodyRows
    .map((row, index) => renderRow(row, index + (table.headerRow ? 1 : 0)))
    .join("")}</tbody>`;

  return sanitizeHtml(
    `<div class="rendered-table-wrap"><table class="rendered-table">${head}${body}</table></div>`,
    sanitizeOptions
  );
}

function renderMarkdownWithEnvironment(raw: string, environment?: Record<string, unknown>) {
  const html = markdown.render(raw ?? "", environment ?? {});
  return sanitizeRenderedHtml(html);
}

export function renderMarkdown(raw: string) {
  return renderMarkdownWithEnvironment(raw);
}

function renderAiChatAnswerMarkdown(raw: string) {
  return renderMarkdownWithEnvironment(raw, {
    [aiChatCjkStrongEmphasisEnvKey]: true,
    [aiChatNumericReferenceLinksEnvKey]: true
  });
}

export function renderBlockHtml(type: BlockType, raw: string, checked = false, metadata?: unknown) {
  const markdownValue = raw ?? "";
  const safeMetadata = validateStoredBlockMetadata(type, metadata);

  switch (type) {
    case "HEADING_1":
      return renderTextAlignment(renderMarkdown(`# ${stripHeadingMarks(markdownValue) || "제목 1"}`), safeMetadata);
    case "HEADING_2":
      return renderTextAlignment(renderMarkdown(`## ${stripHeadingMarks(markdownValue) || "제목 2"}`), safeMetadata);
    case "HEADING_3":
      return renderTextAlignment(renderMarkdown(`### ${stripHeadingMarks(markdownValue) || "제목 3"}`), safeMetadata);
    case "HEADING_4":
      return renderTextAlignment(renderMarkdown(`#### ${stripHeadingMarks(markdownValue) || "제목 4"}`), safeMetadata);
    case "HEADING_5":
      return renderTextAlignment(renderMarkdown(`##### ${stripHeadingMarks(markdownValue) || "제목 5"}`), safeMetadata);
    case "TODO": {
      const checkbox = `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
      return renderTextAlignment(
        sanitizeHtml(`<div class="rendered-todo">${checkbox}${renderMarkdown(markdownValue)}</div>`, sanitizeOptions),
        safeMetadata
      );
    }
    case "UNORDERED_LIST":
    case "ORDERED_LIST":
      return renderListBlock(type, markdownValue);
    case "QUOTE":
      return renderTextAlignment(renderMarkdown(`> ${stripBlockquoteMarks(markdownValue)}`), safeMetadata);
    case "CALLOUT": {
      const calloutType = getCalloutType(safeMetadata);
      return renderTextAlignment(
        sanitizeHtml(
          `<div class="rendered-callout rendered-callout--${calloutType}">${renderMarkdown(markdownValue)}</div>`,
          sanitizeOptions
        ),
        safeMetadata
      );
    }
    case "TOGGLE":
      return renderToggle(markdownValue, safeMetadata);
    case "ACCORDION":
      return sanitizeHtml(renderAccordionHtml(safeMetadata, renderMarkdown), sanitizeOptions);
    case "TABLE":
      return renderTable(safeMetadata);
    case "KANBAN":
      return sanitizeHtml(renderKanbanHtml(safeMetadata), sanitizeOptions);
    case "DATABASE":
      return sanitizeHtml(renderDatabaseHtml(safeMetadata), sanitizeOptions);
    case "TREEVIEW":
      return sanitizeHtml(renderTreeViewHtml(safeMetadata), sanitizeOptions);
    case "TIMETABLE":
      return sanitizeHtml(renderTimetableHtml(safeMetadata), sanitizeOptions);
    case "GANTT":
      return sanitizeHtml(renderGanttHtml(safeMetadata), sanitizeOptions);
    case "BOOKMARK":
      return sanitizeHtml(renderBookmarkHtml(safeMetadata), sanitizeOptions);
    case "AI_CHAT":
      return renderAiChat(safeMetadata);
    case "MATH":
      return sanitizeHtml(renderMathPlaceholder(markdownValue, true), sanitizeOptions);
    case "MERMAID":
      // Mermaid is rendered in the browser inside a sandboxed data-URL iframe.
      // Persist only an escaped source fallback in html_cache; never trust a
      // stored/generated SVG as an application HTML trust boundary.
      return renderMermaidSourcePlaceholder(markdownValue);
    case "CODE":
      return renderTextAlignment(
        sanitizeHtml(renderHighlightedCode(stripFence(markdownValue), getCodeLanguage(safeMetadata)), sanitizeOptions),
        safeMetadata
      );
    case "DIVIDER":
      return sanitizeHtml("<hr>", sanitizeOptions);
    case "VIDEO":
      return renderYouTubeVideo(markdownValue);
    case "IMAGE": {
      const src = stripMarkdownImage(markdownValue);
      if (/^https?:\/\//i.test(src)) {
        return renderTextAlignment(renderMarkdown(`![BrainVault image](${src})`), safeMetadata);
      }
      return renderTextAlignment(renderMarkdown(markdownValue), safeMetadata);
    }
    case "ATTACHMENT": {
      const info = getAttachmentInfo(safeMetadata) ?? {
        originalName: sanitizeAttachmentFilename(markdownValue),
        mimeType: "application/octet-stream",
        size: 0
      };
      const safeName = sanitizeHtml(info.originalName, { allowedTags: [], allowedAttributes: {} });
      const safeMimeType = sanitizeHtml(info.mimeType, { allowedTags: [], allowedAttributes: {} });
      const detail = `${formatAttachmentSize(info.size)} · ${safeMimeType}`;
      return sanitizeHtml(
        `<div class="rendered-attachment"><span class="rendered-attachment-name">${safeName}</span><small class="rendered-attachment-meta">${detail}</small></div>`,
        sanitizeOptions
      );
    }
    case "MARKDOWN":
    default:
      return renderTextAlignment(renderMarkdown(markdownValue), safeMetadata);
  }
}
