import type { RequestHandler } from "express";
import type { DbClient } from "./db.js";
import { ApiError } from "./http.js";
import { measureJsonUtf8BytesWithinLimit } from "./data-transfer-limits.js";

const MiB = 1024 * 1024;

// One page is still returned atomically to preserve editor and collaboration
// snapshot semantics. Bound its source before fetching bodies, and its output
// before serialization. These are server boundaries, independent of the client.
export const pageResourceLimits = Object.freeze({
  maxBlocks: 2_000,
  maxMetadataBytes: 8 * MiB,
  maxMarkdownBytes: 4 * MiB,
  maxHtmlCacheBytes: 8 * MiB,
  maxSourceBytes: 16 * MiB,
  maxResponseBytes: 32 * MiB,
  maxRenderBytes: 16 * MiB,
  concurrentProjections: 2
});

export type PageResourceUsage = {
  blocks: number;
  metadataBytes: number;
  markdownBytes: number;
  htmlCacheBytes: number;
};

export function emptyPageResourceUsage(): PageResourceUsage {
  return { blocks: 0, metadataBytes: 0, markdownBytes: 0, htmlCacheBytes: 0 };
}

export function assertPageResourceUsage(usage: PageResourceUsage) {
  const checks = [
    [usage.blocks, pageResourceLimits.maxBlocks, "PAGE_BLOCK_LIMIT_EXCEEDED", "block count"],
    [usage.metadataBytes, pageResourceLimits.maxMetadataBytes, "PAGE_METADATA_LIMIT_EXCEEDED", "metadata"],
    [usage.markdownBytes, pageResourceLimits.maxMarkdownBytes, "PAGE_MARKDOWN_LIMIT_EXCEEDED", "Markdown"],
    [usage.htmlCacheBytes, pageResourceLimits.maxHtmlCacheBytes, "PAGE_HTML_CACHE_LIMIT_EXCEEDED", "rendered content"],
    [usage.metadataBytes + usage.markdownBytes + usage.htmlCacheBytes,
      pageResourceLimits.maxSourceBytes, "PAGE_SOURCE_LIMIT_EXCEEDED", "total content"]
  ] as const;
  for (const [value, limit, code, label] of checks) {
    if (!Number.isSafeInteger(value) || value < 0 || value > limit) {
      throw new ApiError(413, code, `This page exceeds the ${label} limit (${limit}). Split its content across pages.`);
    }
  }
}

export function addPageBlockUsage(
  usage: PageResourceUsage,
  block: { markdown: string; metadata: unknown; htmlCache?: string | null }
) {
  usage.blocks++;
  usage.markdownBytes += Buffer.byteLength(block.markdown, "utf8");
  usage.metadataBytes += block.metadata == null ? 0 : Buffer.byteLength(
    typeof block.metadata === "string" ? block.metadata : JSON.stringify(block.metadata), "utf8"
  );
  usage.htmlCacheBytes += Buffer.byteLength(block.htmlCache ?? "", "utf8");
  assertPageResourceUsage(usage);
}

/**
 * Never fetch TEXT/JSON bodies to decide whether they are safe to fetch.
 * The bounded length-only projection also detects pre-existing oversized pages.
 * Writers MUST hold the page row lock and use current reads: a plain aggregate
 * can see a stale REPEATABLE READ snapshot established before that lock.
 * Readers use the same snapshot as authorization and the subsequent body read.
 */
export async function assertStoredPageResourceBudget(client: DbClient, pageId: string, lock = false) {
  const rows = await client.query<{
    metadata_bytes: number; markdown_bytes: number; html_cache_bytes: number;
  }>(
    `SELECT COALESCE(OCTET_LENGTH(metadata), 0) AS metadata_bytes,
            COALESCE(OCTET_LENGTH(markdown), 0) AS markdown_bytes,
            COALESCE(OCTET_LENGTH(html_cache), 0) AS html_cache_bytes
     FROM blocks WHERE page_id = ? ORDER BY id ASC LIMIT ?${lock ? " FOR UPDATE" : ""}`,
    [pageId, pageResourceLimits.maxBlocks + 1]
  );
  const usage = emptyPageResourceUsage();
  usage.blocks = rows.length;
  for (const row of rows) {
    usage.metadataBytes += Number(row.metadata_bytes ?? 0);
    usage.markdownBytes += Number(row.markdown_bytes ?? 0);
    usage.htmlCacheBytes += Number(row.html_cache_bytes ?? 0);
  }
  assertPageResourceUsage(usage);
  return usage;
}

export function assertPageResponseBudget(value: unknown) {
  if (measureJsonUtf8BytesWithinLimit(value, pageResourceLimits.maxResponseBytes) === null) {
    throw new ApiError(413, "PAGE_RESPONSE_TOO_LARGE", "This page is too large to return in one response. Split its content across pages.");
  }
}

export function assertPageRenderBudget(bytes: number) {
  if (bytes > pageResourceLimits.maxRenderBytes) {
    throw new ApiError(413, "PAGE_RENDER_LIMIT_EXCEEDED", "This page exceeds the rendered output limit. Split its content across pages.");
  }
}

// Retain admission through processing AND response delivery. An early socket
// close must not admit more work while the abandoned request is still fetching
// or rendering its page. All admitted routes finish with a JSON/error response.
let activeProjections = 0;
export const admitPageProjection: RequestHandler = (_req, res, next) => {
  if (activeProjections >= pageResourceLimits.concurrentProjections) {
    res.setHeader("Retry-After", "1");
    next(new ApiError(503, "PAGE_PROJECTION_BUSY", "Page processing is busy. Retry shortly."));
    return;
  }
  activeProjections++;
  let released = false;
  let processingComplete = false;
  let responseComplete = false;
  const release = () => {
    if (released || !processingComplete || !responseComplete) return;
    released = true;
    activeProjections--;
    res.off("finish", finish);
    res.off("close", close);
  };
  const finish = () => {
    processingComplete = responseComplete = true;
    release();
  };
  const close = () => {
    responseComplete = true;
    release();
  };
  const originalEnd = res.end;
  res.end = function (this: typeof res, ...args: unknown[]) {
    processingComplete = true;
    try { return Reflect.apply(originalEnd, this, args); }
    finally { release(); }
  } as typeof res.end;
  res.once("finish", finish);
  res.once("close", close);
  next();
};
