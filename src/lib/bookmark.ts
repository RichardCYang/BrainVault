import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import {
  isBookmarkFetchHostAllowedByOptionalAllowlist,
  normalizeBookmarkFetchHostname
} from "./bookmark-host-policy.js";
import {
  isPrivateAddress,
  isPrivateOrLocalHostname,
  prioritizeResolvedAddresses,
  type ResolvedAddress
} from "./network-address.js";
export { isPrivateAddress, isPrivateOrLocalHostname, prioritizeResolvedAddresses, type ResolvedAddress } from "./network-address.js";
import { env } from "../config/env.js";
import { ApiError } from "./http.js";
import {
  enforceAbsoluteRequestDeadline as enforceRequestDeadline,
  type AbsoluteDeadlineRequest
} from "./request-deadline.js";
import { isRedditBookmarkUrl } from "./reddit-bookmark.js";
export { isRedditBookmarkUrl } from "./reddit-bookmark.js";

export const bookmarkLimits = {
  defaultMaxItems: 50,
  minMaxItems: 1,
  maxMaxItems: 500,
  idLength: 64,
  urlLength: 2_048,
  blockTitleLength: 120,
  titleLength: 300,
  descriptionLength: 1_000,
  siteNameLength: 160,
  maxListColumns: 5,
  htmlBytes: 768 * 1024,
  redirects: 5
} as const;

export const bookmarkViews = ["list", "gallery"] as const;
export type BookmarkView = (typeof bookmarkViews)[number];

export type BookmarkItem = {
  id: string;
  url: string;
  title: string;
  description: string;
  imageUrl: string;
  faviconUrl: string;
  siteName: string;
};

export type BookmarkData = {
  title: string;
  view: BookmarkView;
  listColumns: number;
  maxItems: number;
  items: BookmarkItem[];
};

export type BookmarkPreview = Omit<BookmarkItem, "id">;

type HtmlResponse = {
  url: URL;
  html: string;
};

const defaultBookmarkUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 BrainVault/1.0";
const redditBookmarkUserAgent = "Twitterbot/1.0";

function parseMetadata(metadata: unknown): Record<string, unknown> | null {
  if (!metadata) return null;
  if (typeof metadata === "string") {
    try {
      const parsed = JSON.parse(metadata) as unknown;
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  return typeof metadata === "object" && !Array.isArray(metadata)
    ? (metadata as Record<string, unknown>)
    : null;
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeText(value: unknown, maxLength: number) {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function normalizeItemId(value: unknown, fallback: string) {
  const id = normalizeText(value, bookmarkLimits.idLength);
  return id || fallback;
}

function normalizeBookmarkListColumns(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return 1;
  return Math.min(bookmarkLimits.maxListColumns, Math.max(1, value));
}

function normalizeBookmarkMaxItems(value: unknown) {
  if (typeof value !== "number" || !Number.isInteger(value)) return bookmarkLimits.defaultMaxItems;
  return Math.min(bookmarkLimits.maxMaxItems, Math.max(bookmarkLimits.minMaxItems, value));
}

export function normalizeBookmarkUrl(value: unknown, baseUrl?: string | URL) {
  const raw = normalizeText(value, bookmarkLimits.urlLength);
  if (!raw) return "";

  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    if (isPrivateOrLocalHostname(url.hostname)) return "";
    url.hash = "";
    return url.toString().slice(0, bookmarkLimits.urlLength);
  } catch {
    return "";
  }
}

export function createDefaultBookmarkData(): BookmarkData {
  return {
    title: "Bookmarks",
    view: "gallery",
    listColumns: 1,
    maxItems: bookmarkLimits.defaultMaxItems,
    items: []
  };
}

export function getBookmarkData(metadata: unknown): BookmarkData {
  const value = parseMetadata(metadata)?.bookmark;
  const source = recordValue(value);
  if (!source) return createDefaultBookmarkData();

  const title = typeof source.title === "string"
    ? normalizeText(source.title, bookmarkLimits.blockTitleLength)
    : "Bookmarks";
  const requestedView = normalizeText(source.view, 20) as BookmarkView;
  const view = bookmarkViews.includes(requestedView) ? requestedView : "gallery";
  const listColumns = normalizeBookmarkListColumns(source.listColumns);
  const maxItems = normalizeBookmarkMaxItems(source.maxItems);
  const sourceItems = Array.isArray(source.items) ? source.items.slice(0, bookmarkLimits.maxMaxItems) : [];
  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();
  const items: BookmarkItem[] = [];

  for (const [index, rawItem] of sourceItems.entries()) {
    const item = recordValue(rawItem);
    if (!item) continue;
    const url = normalizeBookmarkUrl(item.url);
    if (!url || seenUrls.has(url)) continue;
    seenUrls.add(url);

    let id = normalizeItemId(item.id, `bookmark-${index + 1}`);
    let attempt = 1;
    while (seenIds.has(id)) {
      id = `bookmark-${index + 1}-${attempt}`.slice(0, bookmarkLimits.idLength);
      attempt += 1;
    }
    seenIds.add(id);

    const parsedUrl = new URL(url);
    const title = normalizeText(item.title, bookmarkLimits.titleLength) || parsedUrl.hostname;
    items.push({
      id,
      url,
      title,
      description: normalizeText(item.description, bookmarkLimits.descriptionLength),
      imageUrl: normalizeBookmarkUrl(item.imageUrl, url),
      faviconUrl: normalizeBookmarkUrl(item.faviconUrl, url) || new URL("/favicon.ico", url).toString(),
      siteName: normalizeText(item.siteName, bookmarkLimits.siteNameLength) || parsedUrl.hostname
    });
  }

  return { title, view, listColumns, maxItems, items };
}

export function normalizeBookmarkMetadata(metadata: unknown) {
  const source = parseMetadata(metadata) ?? {};
  return { ...source, bookmark: getBookmarkData(source) };
}

export function summarizeBookmarkData(data: BookmarkData) {
  const itemSummary = data.items
    .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
    .join("\n\n");
  return [data.title, itemSummary].filter(Boolean).join("\n\n").slice(0, 20_000);
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function renderBookmarkHtml(metadata: unknown) {
  const bookmark = getBookmarkData(metadata);
  const items = bookmark.items.map((item) => {
    const favicon = item.faviconUrl
      ? `<img class="rendered-bookmark-favicon" src="${escapeHtml(item.faviconUrl)}" alt="" width="20" height="20" loading="lazy" referrerpolicy="no-referrer">`
      : "";

    if (bookmark.view === "list") {
      return `<li class="rendered-bookmark-list-item"><a href="${escapeHtml(item.url)}">${favicon}<span>${escapeHtml(item.title)}</span></a></li>`;
    }

    const image = item.imageUrl
      ? `<img class="rendered-bookmark-image" src="${escapeHtml(item.imageUrl)}" alt="" loading="lazy" referrerpolicy="no-referrer">`
      : `<div class="rendered-bookmark-image rendered-bookmark-image--placeholder">${favicon}</div>`;
    const description = item.description
      ? `<p class="rendered-bookmark-description">${escapeHtml(item.description)}</p>`
      : "";

    return `<article class="rendered-bookmark-card"><a href="${escapeHtml(item.url)}"><div class="rendered-bookmark-media">${image}</div><div class="rendered-bookmark-content"><strong>${escapeHtml(item.title)}</strong>${description}<small>${favicon}${escapeHtml(item.siteName)}</small></div></a></article>`;
  });

  const title = bookmark.title
    ? `<h3>${escapeHtml(bookmark.title)}</h3>`
    : "";
  if (bookmark.view === "list") {
    return `<div class="rendered-bookmark-block">${title}<div class="rendered-bookmarks rendered-bookmarks--list rendered-bookmarks--list-columns-${bookmark.listColumns}"><ul>${items.join("")}</ul></div></div>`;
  }
  return `<div class="rendered-bookmark-block">${title}<div class="rendered-bookmarks rendered-bookmarks--gallery">${items.join("")}</div></div>`;
}

function isDnsNoDataError(error: unknown) {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return code === "ENODATA" || code === "ENOTFOUND";
}

async function resolvePublicAddresses(
  url: URL,
  deadline: number = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS
): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHostname(hostname)) {
    throw new ApiError(400, "BOOKMARK_URL_BLOCKED", "Local and private network addresses are not allowed");
  }

  const literalFamily = net.isIP(hostname);
  let addresses: Array<{ address: string; family: number }>;
  try {
    if (literalFamily) {
      addresses = [{ address: hostname, family: literalFamily }];
    } else {
      const remainingTime = deadline - Date.now();
      if (remainingTime <= 0) throw new ApiError(504, "BOOKMARK_FETCH_TIMEOUT", "The bookmark page took too long to respond");

      // dns.lookup() runs getaddrinfo() on libuv's shared worker pool and cannot be
      // cancelled. Use the asynchronous DNS resolver instead so attacker-controlled
      // hosts cannot occupy the worker pool beyond the bookmark request deadline.
      const resolver = new dns.promises.Resolver({ timeout: Math.max(1, remainingTime), tries: 1 });
      const cancelTimer = setTimeout(() => resolver.cancel(), remainingTime);
      cancelTimer.unref?.();
      const [ipv4, ipv6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname)
      ]).finally(() => clearTimeout(cancelTimer));

      const unexpectedFailure = [ipv4, ipv6].find(
        (result) => result.status === "rejected" && !isDnsNoDataError(result.reason)
      );
      if (unexpectedFailure?.status === "rejected") throw unexpectedFailure.reason;

      addresses = [
        ...(ipv4.status === "fulfilled" ? ipv4.value.map((address) => ({ address, family: 4 })) : []),
        ...(ipv6.status === "fulfilled" ? ipv6.value.map((address) => ({ address, family: 6 })) : [])
      ];
      if (!addresses.length) {
        const resolutionFailure = [ipv4, ipv6].find((result) => result.status === "rejected");
        if (resolutionFailure?.status === "rejected") throw resolutionFailure.reason;
      }
    }
  } catch (error) {
    const systemCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
    if (error instanceof ApiError || systemCode === "ETIMEOUT" || systemCode === "ECANCELLED") {
      if (error instanceof ApiError) throw error;
      throw new ApiError(504, "BOOKMARK_FETCH_TIMEOUT", "The bookmark page took too long to respond");
    }
    throw new ApiError(422, "BOOKMARK_FETCH_FAILED", "The bookmark hostname could not be resolved", {
      reason: "dns",
      systemCode
    });
  }

  const hasUnsafeAddress = addresses.some((item) => {
    const family = net.isIP(item.address);
    return (family !== 4 && family !== 6) || isPrivateAddress(item.address);
  });
  const publicAddresses = prioritizeResolvedAddresses(addresses);
  if (!publicAddresses.length || hasUnsafeAddress) {
    throw new ApiError(400, "BOOKMARK_URL_BLOCKED", "Local and private network addresses are not allowed");
  }

  return publicAddresses;
}

export function createPinnedLookup(addresses: ResolvedAddress[]): LookupFunction {
  const pinned = prioritizeResolvedAddresses(addresses);
  return (_hostname, options, callback) => {
    const requestedFamily = Number(options.family ?? 0);
    const matching = requestedFamily === 4 || requestedFamily === 6
      ? pinned.filter((item) => item.family === requestedFamily)
      : pinned;

    if (!matching.length) {
      const error = Object.assign(new Error("No validated address matches the requested IP family"), {
        code: "ENOTFOUND"
      });
      callback(error, options.all ? [] : "", 0);
      return;
    }

    if (options.all) {
      callback(null, matching);
      return;
    }
    callback(null, matching[0].address, matching[0].family);
  };
}

function createBookmarkFetchAgent(url: URL, addresses: ResolvedAddress[]) {
  const agentOptions: http.AgentOptions = {
    autoSelectFamily: addresses.length > 1,
    autoSelectFamilyAttemptTimeout: 250
  };
  return url.protocol === "https:"
    ? new https.Agent(agentOptions)
    : new http.Agent(agentOptions);
}

export function isBookmarkFetchHostAllowed(
  hostname: string,
  allowedHosts: readonly string[] = env.BOOKMARK_FETCH_ALLOWED_HOSTS
) {
  return isBookmarkFetchHostAllowedByOptionalAllowlist(hostname, allowedHosts);
}

function isSelfOrSubdomainBookmarkFetchHost(hostname: string) {
  const host = normalizeBookmarkFetchHostname(hostname);
  const publicHost = normalizeBookmarkFetchHostname(new URL(env.PUBLIC_ORIGIN).hostname);
  if (host === publicHost) return true;
  return net.isIP(host) === 0 && net.isIP(publicHost) === 0 && host.endsWith(`.${publicHost}`);
}

type BookmarkFetchHostPolicy = "bookmark" | "public";

async function validateFetchUrl(
  value: string | URL,
  hostPolicy: BookmarkFetchHostPolicy = "bookmark",
  deadline: number = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS
) {
  const normalized = normalizeBookmarkUrl(String(value));
  if (!normalized) {
    throw new ApiError(400, "BOOKMARK_URL_INVALID", "Enter a valid HTTP or HTTPS URL");
  }
  const url = new URL(normalized);
  if (isSelfOrSubdomainBookmarkFetchHost(url.hostname)) {
    throw new ApiError(403, "BOOKMARK_URL_BLOCKED", "Self-origin bookmark previews are not allowed");
  }
  if (hostPolicy === "bookmark" && !isBookmarkFetchHostAllowed(url.hostname)) {
    throw new ApiError(403, "BOOKMARK_URL_BLOCKED", "Bookmark preview host is blocked by the configured outbound host restriction");
  }
  const effectivePort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!env.BOOKMARK_FETCH_ALLOWED_PORTS.includes(effectivePort)) {
    throw new ApiError(400, "BOOKMARK_PORT_BLOCKED", "Bookmark previews are limited to approved web ports");
  }
  const addresses = await resolvePublicAddresses(url, deadline);
  return { url, addresses };
}

function createBookmarkFetchTimeoutError() {
  return new ApiError(504, "BOOKMARK_FETCH_TIMEOUT", "The bookmark page took too long to respond");
}

export function enforceAbsoluteRequestDeadline(request: AbsoluteDeadlineRequest, timeoutMs: number) {
  enforceRequestDeadline(request, timeoutMs, createBookmarkFetchTimeoutError);
}

function decodeResponseBody(buffer: Buffer, contentType: string) {
  const headerCharset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]?.toLowerCase();
  const htmlPrefix = buffer.subarray(0, 8_192).toString("latin1");
  const metaCharset = /<meta\b[^>]*charset\s*=\s*["']?([^"'\s/>]+)/i.exec(htmlPrefix)?.[1]?.toLowerCase()
    || /<meta\b[^>]*content\s*=\s*["'][^"']*charset\s*=\s*([^;"'\s]+)/i.exec(htmlPrefix)?.[1]?.toLowerCase();
  const charset = (headerCharset || metaCharset || "utf-8").replace(/^utf8$/, "utf-8");

  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

function bookmarkFetchUserAgent(url: URL) {
  return isRedditBookmarkUrl(url) ? redditBookmarkUserAgent : defaultBookmarkUserAgent;
}

async function fetchHtml(
  value: string | URL,
  redirectsLeft: number = bookmarkLimits.redirects,
  deadline: number = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS,
  hostPolicy: BookmarkFetchHostPolicy = "bookmark"
): Promise<HtmlResponse> {
  const { url, addresses } = await validateFetchUrl(value, hostPolicy, deadline);
  const client = url.protocol === "https:" ? https : http;
  const remainingTime = deadline - Date.now();
  if (remainingTime <= 0) {
    throw createBookmarkFetchTimeoutError();
  }

  return new Promise<HtmlResponse>((resolve, reject) => {
    let settled = false;
    const rejectFetch = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (error instanceof ApiError) {
        reject(error);
        return;
      }
      const systemCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      reject(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The bookmark page could not be fetched", {
        reason: "network",
        systemCode
      }));
    };

    const requestOptions = {
      method: "GET",
      headers: {
        Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.1",
        "Accept-Encoding": "identity",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
        "User-Agent": bookmarkFetchUserAgent(url)
      },
      lookup: createPinnedLookup(addresses),
      agent: createBookmarkFetchAgent(url, addresses)
    };

    const request = client.request(
      url,
      requestOptions,
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;

        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            rejectFetch(new ApiError(422, "BOOKMARK_REDIRECT_LIMIT", "The bookmark URL redirected too many times"));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch {
            rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The bookmark page returned an invalid redirect"));
            return;
          }
          if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
            rejectFetch(new ApiError(403, "BOOKMARK_URL_BLOCKED", "Bookmark redirects must not downgrade from HTTPS to HTTP"));
            return;
          }
          fetchHtml(nextUrl, redirectsLeft - 1, deadline, hostPolicy).then(
            (result) => {
              if (settled) return;
              settled = true;
              resolve(result);
            },
            rejectFetch
          );
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", `The bookmark page returned HTTP ${status || "error"}`, {
            reason: "http",
            status
          }));
          return;
        }

        const contentType = String(response.headers["content-type"] ?? "");
        if (!contentType || !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_NOT_HTML", "The bookmark URL did not return an HTML page"));
          return;
        }

        const contentEncoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
        if (contentEncoding && contentEncoding !== "identity") {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The bookmark page ignored the requested response encoding", {
            reason: "encoding",
            contentEncoding
          }));
          return;
        }

        const maxBytes = Math.min(env.BOOKMARK_FETCH_MAX_BYTES, bookmarkLimits.htmlBytes);
        const chunks: Buffer[] = [];
        let total = 0;
        let probeTail = "";

        const finish = () => {
          if (settled) return;
          settled = true;
          const html = decodeResponseBody(Buffer.concat(chunks), contentType);
          response.destroy();
          resolve({ url, html });
        };

        response.on("data", (rawChunk: Buffer | string) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          const available = maxBytes - total;
          if (available <= 0) {
            finish();
            return;
          }

          const accepted = chunk.length > available ? chunk.subarray(0, available) : chunk;
          chunks.push(accepted);
          total += accepted.length;

          const probe = probeTail + accepted.toString("latin1");
          probeTail = probe.slice(-64);
          if (/<\/head\s*>/i.test(probe) || total >= maxBytes) finish();
        });
        response.on("end", finish);
        response.on("aborted", () => rejectFetch(new Error("The bookmark response was aborted")));
        response.on("error", rejectFetch);
      }
    );

    enforceAbsoluteRequestDeadline(request, remainingTime);
    request.setTimeout(remainingTime, () => {
      request.destroy(createBookmarkFetchTimeoutError());
    });
    request.on("error", rejectFetch);
    request.end();
  });
}

function decodeHtmlEntities(value: string) {
  const named: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    ndash: "–",
    mdash: "—",
    hellip: "…"
  };

  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x")) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isSafeInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isSafeInteger(codePoint)
        && codePoint >= 0
        && codePoint <= 0x10ffff
        && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
        ? String.fromCodePoint(codePoint)
        : match;
    }
    return named[entity.toLowerCase()] ?? match;
  });
}

function parseAttributes(tag: string) {
  const attributes: Record<string, string> = {};
  const body = tag.replace(/^<\/?[a-z0-9:-]+/i, "").replace(/\/?\s*>$/, "");
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    const name = match[1].toLowerCase();
    attributes[name] = decodeHtmlEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function firstValue(map: Map<string, string>, keys: string[]) {
  for (const key of keys) {
    const value = map.get(key);
    if (value) return value;
  }
  return "";
}

function findOpeningTag(
  head: string,
  opening: RegExp,
  from: number
): { start: number; afterName: number } | null {
  const pattern = new RegExp(
    opening.source,
    opening.flags.includes("g") ? opening.flags : `${opening.flags}g`
  );
  pattern.lastIndex = from;
  const match = pattern.exec(head);
  return match ? { start: match.index, afterName: match.index + match[0].length } : null;
}

function matchOpeningTags(head: string, tagName: "meta" | "link") {
  const tags: string[] = [];
  let from = 0;
  const opening = new RegExp(`<${tagName}\\b`, "i");
  while (from < head.length) {
    const match = findOpeningTag(head, opening, from);
    if (!match) break;
    const tagEnd = head.indexOf(">", match.afterName);
    if (tagEnd === -1) break;
    tags.push(head.slice(match.start, tagEnd + 1));
    from = tagEnd + 1;
  }
  return tags;
}

function extractTitleContent(head: string) {
  const opening = findOpeningTag(head, /<title\b/i, 0);
  if (!opening) return "";
  const tagEnd = head.indexOf(">", opening.afterName);
  if (tagEnd === -1) return "";

  let searchFrom = tagEnd + 1;
  for (;;) {
    const close = findOpeningTag(head, /<\/title/i, searchFrom);
    if (!close) return "";
    let cursor = close.afterName;
    while (cursor < head.length && /\s/.test(head[cursor])) cursor += 1;
    if (head[cursor] === ">") return head.slice(tagEnd + 1, close.start);
    searchFrom = close.afterName;
  }
}

function extractBaseTag(head: string) {
  const opening = findOpeningTag(head, /<base\b/i, 0);
  if (!opening) return "";
  const tagEnd = head.indexOf(">", opening.afterName);
  return tagEnd === -1 ? "" : head.slice(opening.start, tagEnd + 1);
}

function stripInlineTags(value: string) {
  let result = "";
  let cursor = 0;
  for (;;) {
    const open = value.indexOf("<", cursor);
    if (open === -1) return result + value.slice(cursor);
    result += value.slice(cursor, open);
    const close = value.indexOf(">", open + 1);
    if (close === -1) return result + value.slice(open);
    if (close === open + 1) {
      result += "<";
      cursor = open + 1;
      continue;
    }
    result += " ";
    cursor = close + 1;
  }
}

export function parseBookmarkPreview(html: string, pageUrl: string | URL): BookmarkPreview {
  const finalUrl = new URL(pageUrl);
  const head = html.slice(0, bookmarkLimits.htmlBytes);
  const metadata = new Map<string, string>();

  for (const tag of matchOpeningTags(head, "meta")) {
    const attributes = parseAttributes(tag);
    const key = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    const content = normalizeText(attributes.content, bookmarkLimits.descriptionLength);
    if (key && content && !metadata.has(key)) metadata.set(key, content);
  }

  const titleTag = extractTitleContent(head);
  const title = normalizeText(
    firstValue(metadata, ["og:title", "twitter:title"]) || decodeHtmlEntities(stripInlineTags(titleTag)),
    bookmarkLimits.titleLength
  ) || finalUrl.hostname;

  const description = normalizeText(
    firstValue(metadata, ["og:description", "twitter:description", "description"]),
    bookmarkLimits.descriptionLength
  );

  const canonicalCandidates: string[] = [];
  const faviconCandidates: string[] = [];
  for (const tag of matchOpeningTags(head, "link")) {
    const attributes = parseAttributes(tag);
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/);
    if (rel.includes("canonical") && attributes.href) canonicalCandidates.push(attributes.href);
    if (rel.some((value) => ["icon", "shortcut", "apple-touch-icon", "apple-touch-icon-precomposed"].includes(value)) && attributes.href) {
      faviconCandidates.push(attributes.href);
    }
  }

  const canonicalUrl = normalizeBookmarkUrl(firstValue(metadata, ["og:url"]) || canonicalCandidates[0], finalUrl) || finalUrl.toString();
  const imageUrl = normalizeBookmarkUrl(
    firstValue(metadata, ["og:image:secure_url", "og:image", "twitter:image", "twitter:image:src"]),
    canonicalUrl
  );
  const faviconUrl = normalizeBookmarkUrl(faviconCandidates[0], canonicalUrl) || new URL("/favicon.ico", canonicalUrl).toString();
  const siteName = normalizeText(firstValue(metadata, ["og:site_name"]), bookmarkLimits.siteNameLength) || new URL(canonicalUrl).hostname;

  return {
    url: canonicalUrl,
    title,
    description,
    imageUrl,
    faviconUrl,
    siteName
  };
}

export type DatabaseUrlDocumentMetadata = {
  title: string;
  faviconUrls: string[];
};

export type DatabaseUrlPreview = {
  title: string;
  faviconUrl: string;
};

export const databaseUrlPreviewFaviconMaxBytes = 128 * 1024;

function validIcoStructure(bytes: Buffer) {
  if (bytes.length < 22 || bytes.readUInt16LE(0) !== 0 || bytes.readUInt16LE(2) !== 1) return false;
  const imageCount = bytes.readUInt16LE(4);
  const directoryEnd = 6 + imageCount * 16;
  if (!imageCount || directoryEnd > bytes.length) return false;
  for (let index = 0; index < imageCount; index += 1) {
    const offset = 6 + index * 16;
    const imageSize = bytes.readUInt32LE(offset + 8);
    const imageOffset = bytes.readUInt32LE(offset + 12);
    if (!imageSize || imageOffset < directoryEnd || imageOffset > bytes.length || imageSize > bytes.length - imageOffset) {
      return false;
    }
  }
  return true;
}

function detectDatabaseFaviconMimeType(bytes: Buffer) {
  if (!bytes.length || bytes.length > databaseUrlPreviewFaviconMaxBytes) return "";
  if (
    bytes.length >= 8
    && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") {
    return "image/webp";
  }
  if (bytes.length >= 6) {
    const signature = bytes.toString("ascii", 0, 6);
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif";
  }
  if (validIcoStructure(bytes)) return "image/vnd.microsoft.icon";
  return "";
}

export function createDatabaseFaviconDataUrl(bytes: Buffer) {
  const mimeType = detectDatabaseFaviconMimeType(bytes);
  return mimeType ? `data:${mimeType};base64,${bytes.toString("base64")}` : "";
}

export function parseDatabaseUrlDocumentMetadata(html: string, pageUrl: string | URL): DatabaseUrlDocumentMetadata {
  const finalUrl = new URL(pageUrl);
  const head = html.slice(0, bookmarkLimits.htmlBytes);
  const titleTag = extractTitleContent(head);
  const title = normalizeText(
    decodeHtmlEntities(stripInlineTags(titleTag)),
    bookmarkLimits.titleLength
  ) || finalUrl.hostname;

  let linkBaseUrl = finalUrl.toString();
  const baseTag = extractBaseTag(head);
  if (baseTag) {
    const baseHref = parseAttributes(baseTag).href;
    if (baseHref) linkBaseUrl = normalizeBookmarkUrl(baseHref, finalUrl) || linkBaseUrl;
  }

  const iconUrls: string[] = [];
  const appleTouchIconUrls: string[] = [];
  for (const tag of matchOpeningTags(head, "link")) {
    const attributes = parseAttributes(tag);
    if (!attributes.href) continue;
    const rel = (attributes.rel ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const resolved = normalizeBookmarkUrl(attributes.href, linkBaseUrl);
    if (!resolved) continue;
    if (rel.includes("icon")) iconUrls.push(resolved);
    else if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) {
      appleTouchIconUrls.push(resolved);
    }
  }

  // When several equally suitable icons exist, browsers prefer the last one in tree order.
  // Try regular favicon links before touch icons, then the conventional origin favicon path.
  const faviconUrls = [
    ...iconUrls.reverse(),
    ...appleTouchIconUrls.reverse(),
    new URL("/favicon.ico", finalUrl).toString()
  ].filter((value, index, values) => values.indexOf(value) === index);

  return { title, faviconUrls };
}

async function fetchDatabaseFaviconBytes(
  value: string | URL,
  redirectsLeft: number,
  deadline: number
): Promise<Buffer> {
  const { url, addresses } = await validateFetchUrl(value, "public", deadline);
  const client = url.protocol === "https:" ? https : http;
  const remainingTime = deadline - Date.now();
  if (remainingTime <= 0) throw createBookmarkFetchTimeoutError();

  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    const rejectFetch = (error: unknown) => {
      if (settled) return;
      settled = true;
      if (error instanceof ApiError) {
        reject(error);
        return;
      }
      const systemCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
      reject(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The URL preview favicon could not be fetched", {
        reason: "network",
        systemCode
      }));
    };

    const request = client.request(
      url,
      {
        method: "GET",
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/x-icon,image/vnd.microsoft.icon,*/*;q=0.1",
          "Accept-Encoding": "identity",
          "Cache-Control": "no-cache",
          Pragma: "no-cache",
          "User-Agent": bookmarkFetchUserAgent(url)
        },
        lookup: createPinnedLookup(addresses),
        agent: createBookmarkFetchAgent(url, addresses)
      },
      (response) => {
        const status = response.statusCode ?? 0;
        const location = response.headers.location;
        if (status >= 300 && status < 400 && location) {
          response.resume();
          if (redirectsLeft <= 0) {
            rejectFetch(new ApiError(422, "BOOKMARK_REDIRECT_LIMIT", "The favicon URL redirected too many times"));
            return;
          }
          let nextUrl: URL;
          try {
            nextUrl = new URL(location, url);
          } catch {
            rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The favicon URL returned an invalid redirect"));
            return;
          }
          if (url.protocol === "https:" && nextUrl.protocol !== "https:") {
            rejectFetch(new ApiError(403, "BOOKMARK_URL_BLOCKED", "Favicon redirects must not downgrade from HTTPS to HTTP"));
            return;
          }
          fetchDatabaseFaviconBytes(nextUrl, redirectsLeft - 1, deadline).then(
            (result) => {
              if (settled) return;
              settled = true;
              resolve(result);
            },
            rejectFetch
          );
          return;
        }

        if (status < 200 || status >= 300) {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", `The favicon URL returned HTTP ${status || "error"}`));
          return;
        }

        const contentEncoding = String(response.headers["content-encoding"] ?? "").toLowerCase().trim();
        if (contentEncoding && contentEncoding !== "identity") {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_FETCH_FAILED", "The favicon response ignored the requested encoding"));
          return;
        }

        const declaredLength = Number(response.headers["content-length"] ?? 0);
        if (Number.isFinite(declaredLength) && declaredLength > databaseUrlPreviewFaviconMaxBytes) {
          response.resume();
          rejectFetch(new ApiError(422, "BOOKMARK_PAGE_TOO_LARGE", "The favicon is too large"));
          return;
        }

        const chunks: Buffer[] = [];
        let total = 0;
        response.on("data", (rawChunk: Buffer | string) => {
          if (settled) return;
          const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
          total += chunk.length;
          if (total > databaseUrlPreviewFaviconMaxBytes) {
            response.destroy();
            rejectFetch(new ApiError(422, "BOOKMARK_PAGE_TOO_LARGE", "The favicon is too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          if (settled) return;
          settled = true;
          resolve(Buffer.concat(chunks));
        });
        response.on("aborted", () => rejectFetch(new Error("The favicon response was aborted")));
        response.on("error", rejectFetch);
      }
    );

    enforceAbsoluteRequestDeadline(request, remainingTime);
    request.setTimeout(remainingTime, () => request.destroy(createBookmarkFetchTimeoutError()));
    request.on("error", rejectFetch);
    request.end();
  });
}

export async function fetchDatabaseUrlPreview(value: string): Promise<DatabaseUrlPreview> {
  const deadline = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS;
  // Database URL properties use the same public-web SSRF gate as bookmarks. The explicit
  // "public" policy only bypasses the optional operator hostname restriction, when configured.
  const response = await fetchHtml(value, bookmarkLimits.redirects, deadline, "public");
  const metadata = parseDatabaseUrlDocumentMetadata(response.html, response.url);
  let faviconUrl = "";

  for (const candidate of metadata.faviconUrls.slice(0, 8)) {
    try {
      faviconUrl = createDatabaseFaviconDataUrl(
        await fetchDatabaseFaviconBytes(candidate, bookmarkLimits.redirects, deadline)
      );
      if (faviconUrl) break;
    } catch {
      // A broken/blocked icon must not discard an otherwise valid document title.
    }
  }

  return { title: metadata.title, faviconUrl };
}

async function normalizePublicPreviewUrl(value: string, fallback = "", deadline = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS) {
  if (!value) return fallback;
  try {
    const { url } = await validateFetchUrl(value, "bookmark", deadline);
    return url.toString();
  } catch {
    return fallback;
  }
}

async function fetchBookmarkPreviewFromHtml(value: string, deadline: number): Promise<BookmarkPreview> {
  const response = await fetchHtml(value, bookmarkLimits.redirects, deadline);
  const parsed = parseBookmarkPreview(response.html, response.url);
  const finalUrl = response.url.toString();
  const pageUrl = await normalizePublicPreviewUrl(parsed.url, finalUrl, deadline);
  const fallbackFavicon = new URL("/favicon.ico", pageUrl).toString();
  const [imageUrl, faviconUrl] = await Promise.all([
    normalizePublicPreviewUrl(parsed.imageUrl, "", deadline),
    normalizePublicPreviewUrl(parsed.faviconUrl, fallbackFavicon, deadline)
  ]);

  return {
    ...parsed,
    url: pageUrl,
    imageUrl,
    faviconUrl,
    siteName: parsed.siteName || new URL(pageUrl).hostname
  };
}

export async function fetchBookmarkPreview(value: string): Promise<BookmarkPreview> {
  const deadline = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS;
  return fetchBookmarkPreviewFromHtml(value, deadline);
}

const recoverableBookmarkPreviewCodes = new Set([
  "BOOKMARK_URL_BLOCKED",
  "BOOKMARK_PORT_BLOCKED",
  "BOOKMARK_FETCH_FAILED",
  "BOOKMARK_FETCH_TIMEOUT",
  "BOOKMARK_NOT_HTML",
  "BOOKMARK_PAGE_TOO_LARGE",
  "BOOKMARK_REDIRECT_LIMIT"
]);

export type BookmarkPreviewResponse = {
  preview: BookmarkPreview;
  warning?: {
    code: string;
  };
};

export function createFallbackBookmarkPreview(
  value: string,
  { includeFavicon = true }: { includeFavicon?: boolean } = {}
): BookmarkPreview {
  const url = normalizeBookmarkUrl(value);
  if (!url) {
    throw new ApiError(400, "BOOKMARK_URL_INVALID", "Enter a valid HTTP or HTTPS URL");
  }
  const parsedUrl = new URL(url);
  return {
    url,
    title: parsedUrl.hostname,
    description: "",
    imageUrl: "",
    faviconUrl: includeFavicon ? new URL("/favicon.ico", url).toString() : "",
    siteName: parsedUrl.hostname
  };
}

export async function fetchBookmarkPreviewWithFallback(value: string): Promise<BookmarkPreviewResponse> {
  try {
    return { preview: await fetchBookmarkPreview(value) };
  } catch (error) {
    if (error instanceof ApiError && recoverableBookmarkPreviewCodes.has(error.code)) {
      const blockedTarget = error.code === "BOOKMARK_URL_BLOCKED" || error.code === "BOOKMARK_PORT_BLOCKED";
      return {
        preview: createFallbackBookmarkPreview(value, { includeFavicon: false }),
        warning: { code: blockedTarget ? "BOOKMARK_FETCH_FAILED" : error.code }
      };
    }
    throw error;
  }
}
