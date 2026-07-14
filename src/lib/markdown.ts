import MarkdownIt from "markdown-it";
import sanitizeHtml from "sanitize-html";
import type { BlockType } from "../types/domain.js";
import { getCalloutType } from "./callout.js";
import { formatAttachmentSize, getAttachmentInfo, sanitizeAttachmentFilename } from "./attachments.js";
import { getTableData } from "./table.js";
import { renderKanbanHtml } from "./kanban.js";

const markdown = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: true
});

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
  "td"
]);

const allowedAttributes: sanitizeHtml.IOptions["allowedAttributes"] = {
  ...sanitizeHtml.defaults.allowedAttributes,
  a: ["href", "name", "target", "rel"],
  div: ["class"],
  section: ["class"],
  article: ["class"],
  header: ["class"],
  small: ["class"],
  p: ["class"],
  img: ["src", "srcset", "alt", "title", "width", "height", "loading"],
  code: ["class"],
  span: ["class", "style"],
  input: ["type", "checked", "disabled"],
  table: ["class"],
  thead: ["class"],
  tbody: ["class"],
  tr: ["class"],
  th: ["class", "scope"],
  td: ["class"]
};

const sanitizeOptions: sanitizeHtml.IOptions = {
  allowedTags,
  allowedAttributes,
  allowedStyles: {
    span: {
      color: [/^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i]
    }
  },
  allowedSchemes: ["http", "https", "mailto"],
  transformTags: {
    a: sanitizeHtml.simpleTransform("a", { rel: "noopener noreferrer", target: "_blank" }),
    img: sanitizeHtml.simpleTransform("img", { loading: "lazy" })
  }
};

function stripHeadingMarks(raw: string) {
  return raw.replace(/^\s*#{1,6}\s+/, "").trim();
}

function stripBlockquoteMarks(raw: string) {
  return raw.replace(/^\s*>\s?/gm, "");
}

function stripFence(raw: string) {
  return raw.replace(/^\s*```[\w-]*\n?/, "").replace(/\n?```\s*$/, "");
}

function stripMarkdownImage(raw: string) {
  const match = raw.trim().match(/^!?\[[^\]]*\]\(([^)]+)\)$/);
  return match?.[1]?.trim() ?? raw.trim();
}

function renderTableCell(raw: string) {
  return sanitizeHtml(markdown.renderInline(raw ?? ""), sanitizeOptions);
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
  return sanitizeHtml(html, sanitizeOptions);
}

export function renderBlockHtml(type: BlockType, raw: string, checked = false, metadata?: unknown) {
  const markdownValue = raw ?? "";

  switch (type) {
    case "HEADING_1":
      return renderMarkdown(`# ${stripHeadingMarks(markdownValue) || "제목 1"}`);
    case "HEADING_2":
      return renderMarkdown(`## ${stripHeadingMarks(markdownValue) || "제목 2"}`);
    case "HEADING_3":
      return renderMarkdown(`### ${stripHeadingMarks(markdownValue) || "제목 3"}`);
    case "TODO": {
      const checkbox = `<input type="checkbox" disabled${checked ? " checked" : ""}>`;
      return sanitizeHtml(`<div class="rendered-todo">${checkbox}${renderMarkdown(markdownValue)}</div>`, sanitizeOptions);
    }
    case "QUOTE":
      return renderMarkdown(`> ${stripBlockquoteMarks(markdownValue)}`);
    case "CALLOUT": {
      const calloutType = getCalloutType(metadata);
      return sanitizeHtml(
        `<div class="rendered-callout rendered-callout--${calloutType}">${renderMarkdown(markdownValue)}</div>`,
        sanitizeOptions
      );
    }
    case "TABLE":
      return renderTable(metadata);
    case "KANBAN":
      return sanitizeHtml(renderKanbanHtml(metadata), sanitizeOptions);
    case "CODE":
      return renderMarkdown(`\`\`\`\n${stripFence(markdownValue)}\n\`\`\``);
    case "DIVIDER":
      return sanitizeHtml("<hr>", sanitizeOptions);
    case "IMAGE": {
      const src = stripMarkdownImage(markdownValue);
      if (/^https?:\/\//i.test(src)) return renderMarkdown(`![BrainVault image](${src})`);
      return renderMarkdown(markdownValue);
    }
    case "ATTACHMENT": {
      const info = getAttachmentInfo(metadata) ?? {
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
      return renderMarkdown(markdownValue);
  }
}
