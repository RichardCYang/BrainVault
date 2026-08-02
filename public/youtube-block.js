import { t } from "./i18n.js";

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

function parseTimeValue(value) {
  const source = String(value ?? "").trim().toLowerCase();
  if (!source) return 0;
  if (/^\d+$/.test(source)) return Math.min(86_400, Number.parseInt(source, 10) || 0);
  const match = source.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/);
  if (!match || !match[0]) return 0;
  return Math.min(
    86_400,
    (Number.parseInt(match[1] ?? "0", 10) || 0) * 3_600 +
      (Number.parseInt(match[2] ?? "0", 10) || 0) * 60 +
      (Number.parseInt(match[3] ?? "0", 10) || 0)
  );
}

function extractCandidateUrl(value) {
  const source = value.trim();
  const iframeSource = source.match(/<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1];
  return (iframeSource ?? source).replaceAll("&amp;", "&").trim();
}

export function parseYouTubeVideoUrl(value) {
  if (typeof value !== "string") return null;
  const source = value.trim();
  if (!source || source.length > youtubeVideoUrlMaxLength) return null;

  let url;
  try {
    url = new URL(extractCandidateUrl(source));
  } catch {
    return null;
  }

  if (!['https:', 'http:'].includes(url.protocol)) return null;
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

  return { videoId, startSeconds, embedUrl: embed.toString(), watchUrl: watch.toString() };
}

function createPlayer(video) {
  const frame = document.createElement("div");
  frame.className = "youtube-video-frame";

  const iframe = document.createElement("iframe");
  iframe.className = "youtube-video-iframe";
  iframe.src = video.embedUrl;
  iframe.title = t("youtube.playerTitle");
  iframe.loading = "lazy";
  iframe.referrerPolicy = "strict-origin-when-cross-origin";
  iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
  iframe.allowFullscreen = true;
  frame.append(iframe);

  const link = document.createElement("a");
  link.className = "youtube-video-open-link";
  link.href = video.watchUrl;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = t("youtube.openOnYouTube");

  return [frame, link];
}

export function updateYouTubeVideoPreview(root, value) {
  const preview = root?.classList?.contains("youtube-video-preview")
    ? root
    : root?.querySelector?.(".youtube-video-preview");
  if (!preview) return;

  preview.replaceChildren();
  preview.classList.remove("is-empty", "is-invalid");
  const source = String(value ?? "").trim();
  if (!source) {
    preview.classList.add("is-empty");
    preview.textContent = t("youtube.emptyPreview");
    return;
  }

  const video = parseYouTubeVideoUrl(source);
  if (!video) {
    preview.classList.add("is-invalid");
    preview.textContent = t("youtube.invalidUrl");
    return;
  }

  preview.append(...createPlayer(video));
}

export function createYouTubeVideoEditor(block) {
  const editor = document.createElement("div");
  editor.className = "youtube-video-editor";

  const urlRow = document.createElement("div");
  urlRow.className = "youtube-video-url-row";

  const textarea = document.createElement("textarea");
  textarea.name = "markdown";
  textarea.className = "block-row-input youtube-video-url-input";
  textarea.rows = 1;
  textarea.maxLength = youtubeVideoUrlMaxLength;
  textarea.spellcheck = false;
  textarea.autocapitalize = "off";
  textarea.autocomplete = "off";
  textarea.placeholder = t("youtube.urlPlaceholder");
  textarea.setAttribute("aria-label", t("youtube.urlAria"));
  textarea.value = block?.markdown ?? "";

  const hint = document.createElement("small");
  hint.className = "youtube-video-hint";
  hint.textContent = t("youtube.urlHint");
  urlRow.append(textarea, hint);

  const preview = document.createElement("div");
  preview.className = "youtube-video-preview";
  preview.setAttribute("aria-live", "polite");
  editor.append(urlRow, preview);
  updateYouTubeVideoPreview(preview, textarea.value);
  return editor;
}
