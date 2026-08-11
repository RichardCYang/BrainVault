export const redditBookmarkFaviconUrl = "https://www.redditstatic.com/desktop2x/img/favicon/favicon-32x32.png";

export type RedditOEmbedPayload = {
  author_name?: unknown;
  provider_name?: unknown;
  title?: unknown;
  thumbnail_url?: unknown;
  html?: unknown;
};

export type RedditBookmarkFallbackData = {
  url: string;
  title: string;
  description: string;
  imageUrl: string;
  faviconUrl: string;
  siteName: string;
};

function cleanText(value: unknown) {
  return (typeof value === "string" ? value : "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeRedditUrl(value: string | URL) {
  try {
    const url = value instanceof URL ? new URL(value.toString()) : new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function isRedditBookmarkUrl(value: string | URL) {
  const url = normalizeRedditUrl(value);
  if (!url) return false;
  const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
  return hostname === "redd.it" || hostname === "reddit.com" || hostname.endsWith(".reddit.com");
}

function redditPathContext(url: URL) {
  const segments = url.pathname.split("/").filter(Boolean);
  const subredditIndex = segments.findIndex((segment) => segment.toLowerCase() === "r");
  const subreddit = subredditIndex >= 0 ? cleanText(segments[subredditIndex + 1]) : "";
  const commentsIndex = segments.findIndex((segment) => segment.toLowerCase() === "comments");

  let isComment = false;
  if (commentsIndex >= 0) {
    const tail = segments.slice(commentsIndex + 1);
    // Post URLs normally end after <post-id>/<slug>. A further path component
    // is a legacy comment id or the modern /comment/<comment-id> form.
    isComment = tail.length >= 3;
  }

  return { subreddit, isComment };
}

function redditAuthorLabel(value: unknown) {
  const author = cleanText(value);
  if (!author) return "";
  return author.toLowerCase().startsWith("u/") ? author : `u/${author}`;
}

export function parseRedditOEmbedPayload(
  payload: RedditOEmbedPayload,
  sourceValue: string | URL
): RedditBookmarkFallbackData | null {
  const sourceUrl = normalizeRedditUrl(sourceValue);
  if (!sourceUrl || !isRedditBookmarkUrl(sourceUrl)) return null;

  const rawTitle = cleanText(payload.title);
  const author = redditAuthorLabel(payload.author_name);
  const { subreddit, isComment } = redditPathContext(sourceUrl);
  const subredditLabel = subreddit ? `r/${subreddit}` : "";

  const title = isComment
    ? author
      ? `Reddit comment by ${author}`
      : "Reddit comment"
    : rawTitle || "Reddit";

  const description = isComment
    ? rawTitle
    : [author, subredditLabel].filter(Boolean).join(" · ");

  const imageUrl = cleanText(payload.thumbnail_url);

  return {
    url: sourceUrl.toString(),
    title,
    description,
    imageUrl,
    faviconUrl: redditBookmarkFaviconUrl,
    siteName: "Reddit"
  };
}
