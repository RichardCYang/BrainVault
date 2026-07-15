import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import net, { type LookupFunction } from "node:net";
import { env } from "../config/env.js";
import { ApiError } from "./http.js";

export const bookmarkLimits = {
  items: 50,
  idLength: 64,
  urlLength: 2_048,
  titleLength: 300,
  descriptionLength: 1_000,
  siteNameLength: 160,
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
  view: BookmarkView;
  items: BookmarkItem[];
};

export type BookmarkPreview = Omit<BookmarkItem, "id">;

export type ResolvedAddress = {
  address: string;
  family: 4 | 6;
};

type HtmlResponse = {
  url: URL;
  html: string;
};

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

export function normalizeBookmarkUrl(value: unknown, baseUrl?: string | URL) {
  const raw = normalizeText(value, bookmarkLimits.urlLength);
  if (!raw) return "";

  try {
    const url = baseUrl ? new URL(raw, baseUrl) : new URL(raw);
    if (!(["http:", "https:"] as string[]).includes(url.protocol)) return "";
    if (url.username || url.password) return "";
    url.hash = "";
    return url.toString().slice(0, bookmarkLimits.urlLength);
  } catch {
    return "";
  }
}

export function createDefaultBookmarkData(): BookmarkData {
  return { view: "gallery", items: [] };
}

export function getBookmarkData(metadata: unknown): BookmarkData {
  const value = parseMetadata(metadata)?.bookmark;
  const source = recordValue(value);
  if (!source) return createDefaultBookmarkData();

  const requestedView = normalizeText(source.view, 20) as BookmarkView;
  const view = bookmarkViews.includes(requestedView) ? requestedView : "gallery";
  const sourceItems = Array.isArray(source.items) ? source.items.slice(0, bookmarkLimits.items) : [];
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

  return { view, items };
}

export function normalizeBookmarkMetadata(metadata: unknown) {
  const source = parseMetadata(metadata) ?? {};
  return { ...source, bookmark: getBookmarkData(source) };
}

export function summarizeBookmarkData(data: BookmarkData) {
  return data.items
    .map((item) => `${item.title}\n${item.description}\n${item.url}`.trim())
    .join("\n\n")
    .slice(0, 20_000);
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

  if (bookmark.view === "list") {
    return `<div class="rendered-bookmarks rendered-bookmarks--list"><ul>${items.join("")}</ul></div>`;
  }
  return `<div class="rendered-bookmarks rendered-bookmarks--gallery">${items.join("")}</div>`;
}

function ipv4ToNumber(address: string) {
  return address.split(".").reduce((total, part) => (total << 8) + Number(part), 0) >>> 0;
}

function isIpv4InRange(address: string, base: string, prefix: number) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

function isPrivateIpv4(address: string) {
  const ranges: Array<[string, number]> = [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.0.0.0", 24],
    ["192.0.2.0", 24],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
    ["198.51.100.0", 24],
    ["203.0.113.0", 24],
    ["224.0.0.0", 4]
  ];
  return ranges.some(([base, prefix]) => isIpv4InRange(address, base, prefix));
}

function expandIpv6(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (normalized.includes(".")) {
    const lastColon = normalized.lastIndexOf(":");
    const ipv4 = normalized.slice(lastColon + 1);
    if (net.isIPv4(ipv4)) {
      const number = ipv4ToNumber(ipv4);
      address = `${normalized.slice(0, lastColon)}:${((number >>> 16) & 0xffff).toString(16)}:${(number & 0xffff).toString(16)}`;
    }
  }

  const [left, right = ""] = address.toLowerCase().split("::");
  const leftParts = left ? left.split(":") : [];
  const rightParts = right ? right.split(":") : [];
  const missing = Math.max(0, 8 - leftParts.length - rightParts.length);
  return [...leftParts, ...Array.from({ length: missing }, () => "0"), ...rightParts]
    .map((part) => part.padStart(4, "0"))
    .slice(0, 8);
}

function isPrivateIpv6(address: string) {
  const parts = expandIpv6(address);
  if (parts.length !== 8) return true;
  const first = Number.parseInt(parts[0], 16);
  const second = Number.parseInt(parts[1], 16);
  if (parts.every((part) => part === "0000")) return true;
  if (parts.slice(0, 7).every((part) => part === "0000") && parts[7] === "0001") return true;
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (first === 0x2001 && second === 0x0db8) return true;

  const isMappedIpv4 = parts.slice(0, 5).every((part) => part === "0000") && parts[5] === "ffff";
  if (isMappedIpv4) {
    const high = Number.parseInt(parts[6], 16);
    const low = Number.parseInt(parts[7], 16);
    const mapped = `${high >>> 8}.${high & 255}.${low >>> 8}.${low & 255}`;
    return isPrivateIpv4(mapped);
  }
  return false;
}

export function isPrivateAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPrivateIpv4(address);
  if (family === 6) return isPrivateIpv6(address);
  return true;
}

export function prioritizeResolvedAddresses(addresses: Array<{ address: string; family: number }>) {
  const unique = new Map<string, ResolvedAddress>();
  for (const item of addresses) {
    const family = net.isIP(item.address);
    if ((family !== 4 && family !== 6) || isPrivateAddress(item.address)) continue;
    unique.set(`${family}:${item.address}`, { address: item.address, family });
  }

  return [...unique.values()].sort((left, right) => left.family - right.family);
}

async function resolvePublicAddresses(url: URL): Promise<ResolvedAddress[]> {
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".lan") ||
    hostname.endsWith(".home")
  ) {
    throw new ApiError(400, "BOOKMARK_URL_BLOCKED", "Local and private network addresses are not allowed");
  }

  const literalFamily = net.isIP(hostname);
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = literalFamily
      ? [{ address: hostname, family: literalFamily }]
      : await dns.promises.lookup(hostname, { all: true, order: "ipv4first" });
  } catch (error) {
    const systemCode = error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
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

async function validateFetchUrl(value: string | URL) {
  const normalized = normalizeBookmarkUrl(String(value));
  if (!normalized) {
    throw new ApiError(400, "BOOKMARK_URL_INVALID", "Enter a valid HTTP or HTTPS URL");
  }
  const url = new URL(normalized);
  const addresses = await resolvePublicAddresses(url);
  return { url, addresses };
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

async function fetchHtml(
  value: string | URL,
  redirectsLeft: number = bookmarkLimits.redirects,
  deadline: number = Date.now() + env.BOOKMARK_FETCH_TIMEOUT_MS
): Promise<HtmlResponse> {
  const { url, addresses } = await validateFetchUrl(value);
  const client = url.protocol === "https:" ? https : http;
  const remainingTime = deadline - Date.now();
  if (remainingTime <= 0) {
    throw new ApiError(504, "BOOKMARK_FETCH_TIMEOUT", "The bookmark page took too long to respond");
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
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 BrainVault/1.0"
      },
      lookup: createPinnedLookup(addresses),
      autoSelectFamily: addresses.length > 1,
      autoSelectFamilyAttemptTimeout: 250
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
          fetchHtml(nextUrl, redirectsLeft - 1, deadline).then(
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
        if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) {
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

    request.setTimeout(remainingTime, () => {
      request.destroy(new ApiError(504, "BOOKMARK_FETCH_TIMEOUT", "The bookmark page took too long to respond"));
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
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
    }
    if (entity.startsWith("#")) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(codePoint) ? String.fromCodePoint(codePoint) : match;
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

export function parseBookmarkPreview(html: string, pageUrl: string | URL): BookmarkPreview {
  const finalUrl = new URL(pageUrl);
  const head = html.slice(0, bookmarkLimits.htmlBytes);
  const metadata = new Map<string, string>();

  for (const tag of head.match(/<meta\b[^>]*>/gi) ?? []) {
    const attributes = parseAttributes(tag);
    const key = (attributes.property || attributes.name || attributes.itemprop || "").toLowerCase();
    const content = normalizeText(attributes.content, bookmarkLimits.descriptionLength);
    if (key && content && !metadata.has(key)) metadata.set(key, content);
  }

  const titleTag = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(head)?.[1] ?? "";
  const title = normalizeText(
    firstValue(metadata, ["og:title", "twitter:title"]) || decodeHtmlEntities(titleTag.replace(/<[^>]+>/g, " ")),
    bookmarkLimits.titleLength
  ) || finalUrl.hostname;

  const description = normalizeText(
    firstValue(metadata, ["og:description", "twitter:description", "description"]),
    bookmarkLimits.descriptionLength
  );

  const canonicalCandidates: string[] = [];
  const faviconCandidates: string[] = [];
  for (const tag of head.match(/<link\b[^>]*>/gi) ?? []) {
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

async function normalizePublicPreviewUrl(value: string, fallback = "") {
  if (!value) return fallback;
  try {
    const { url } = await validateFetchUrl(value);
    return url.toString();
  } catch {
    return fallback;
  }
}

export async function fetchBookmarkPreview(value: string): Promise<BookmarkPreview> {
  const response = await fetchHtml(value);
  const parsed = parseBookmarkPreview(response.html, response.url);
  const finalUrl = response.url.toString();
  const pageUrl = await normalizePublicPreviewUrl(parsed.url, finalUrl);
  const fallbackFavicon = new URL("/favicon.ico", pageUrl).toString();
  const [imageUrl, faviconUrl] = await Promise.all([
    normalizePublicPreviewUrl(parsed.imageUrl),
    normalizePublicPreviewUrl(parsed.faviconUrl, fallbackFavicon)
  ]);

  return {
    ...parsed,
    url: pageUrl,
    imageUrl,
    faviconUrl,
    siteName: parsed.siteName || new URL(pageUrl).hostname
  };
}


const recoverableBookmarkPreviewCodes = new Set([
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

export function createFallbackBookmarkPreview(value: string): BookmarkPreview {
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
    faviconUrl: new URL("/favicon.ico", url).toString(),
    siteName: parsedUrl.hostname
  };
}

export async function fetchBookmarkPreviewWithFallback(value: string): Promise<BookmarkPreviewResponse> {
  try {
    return { preview: await fetchBookmarkPreview(value) };
  } catch (error) {
    if (error instanceof ApiError && recoverableBookmarkPreviewCodes.has(error.code)) {
      return {
        preview: createFallbackBookmarkPreview(value),
        warning: { code: error.code }
      };
    }
    throw error;
  }
}
