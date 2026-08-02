const youtubeVideoIdPattern = /^[A-Za-z0-9_-]{11}$/;
const youtubeHosts = new Set([
  "youtube.com",
  "m.youtube.com",
  "music.youtube.com",
  "www.youtube.com",
  "youtube-nocookie.com",
  "www.youtube-nocookie.com"
]);

export const youtubeVideoUrlMaxLength = 2_048;

export type YouTubeVideo = {
  videoId: string;
  startSeconds: number;
  embedUrl: string;
  watchUrl: string;
};

function parseTimeValue(value: string | null) {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) return 0;
  if (/^\d+$/.test(source)) return Math.min(86_400, Number.parseInt(source, 10) || 0);

  const match = source.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match[0]) return 0;
  const hours = Number.parseInt(match[1] ?? "0", 10) || 0;
  const minutes = Number.parseInt(match[2] ?? "0", 10) || 0;
  const seconds = Number.parseInt(match[3] ?? "0", 10) || 0;
  return Math.min(86_400, hours * 3_600 + minutes * 60 + seconds);
}

function extractCandidateUrl(value: string) {
  const source = value.trim();
  const iframeSource = source.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1];
  return (iframeSource ?? source).replaceAll("&amp;", "&").trim();
}

export function parseYouTubeVideoUrl(value: unknown): YouTubeVideo | null {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!source || source.length > youtubeVideoUrlMaxLength) return null;

  const candidate = extractCandidateUrl(source);
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const hostname = url.hostname.toLowerCase();
  let videoId = "";

  if (hostname === "youtu.be" || hostname === "www.youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? "";
  } else if (youtubeHosts.has(hostname)) {
    const segments = url.pathname.split("/").filter(Boolean);
    if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? "";
    else if (["embed", "shorts", "live"].includes(segments[0] ?? "")) videoId = segments[1] ?? "";
  }

  if (!youtubeVideoIdPattern.test(videoId)) return null;

  const hashParams = new URLSearchParams(url.hash.replace(/^#/, ""));
  const startSeconds = parseTimeValue(
    url.searchParams.get("start") ?? url.searchParams.get("t") ?? hashParams.get("t")
  );
  const embed = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  embed.searchParams.set("playsinline", "1");
  embed.searchParams.set("rel", "0");
  if (startSeconds > 0) embed.searchParams.set("start", String(startSeconds));

  const watch = new URL("https://www.youtube.com/watch");
  watch.searchParams.set("v", videoId);
  if (startSeconds > 0) watch.searchParams.set("t", `${startSeconds}s`);

  return {
    videoId,
    startSeconds,
    embedUrl: embed.toString(),
    watchUrl: watch.toString()
  };
}
