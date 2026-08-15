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

function renderMathPlaceholder(latex: string, displayMode: boolean) {
  const source = latex.trim();
  const escaped = markdown.utils.escapeHtml(source);
  const tag = displayMode ? "div" : "span";
  const mode = displayMode ? "display" : "inline";
  return `<${tag} class="math-expression math-expression--${mode}" data-latex="${escaped}" data-math-display="${String(displayMode)}">${escaped}</${tag}>`;
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
]);

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
      const nextAttributes = {
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
  const turns = data.turns.map((turn, index) => {
    const answeredAt = escapeText(turn.answeredAt);
    const question = renderMarkdown(turn.question);
    const answer = renderMarkdown(turn.answer);
    return `<section class="rendered-ai-chat-turn">
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

  return sanitizeHtml(
    `<section class="rendered-ai-chat">${title ? `<div class="rendered-ai-chat-title">${title}</div>` : ""}${turns}</section>`,
    sanitizeOptions
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

export function renderMarkdown(raw: string) {
  const html = markdown.render(raw ?? "");
  return sanitizeRenderedHtml(html);
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
