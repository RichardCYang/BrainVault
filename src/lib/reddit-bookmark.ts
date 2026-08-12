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
