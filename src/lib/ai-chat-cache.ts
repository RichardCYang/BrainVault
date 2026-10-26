// Explicit cache version: bump whenever AI citation/link rendering or the
// sanitizer wrapper semantics change. Unmarked legacy caches are re-rendered.
export const AI_CHAT_RENDERER_VERSION = "2026-10-26-security-v1";
export const AI_CHAT_HTML_CACHE_MAX_CHARS = 2_000_000;

export function isCurrentAiChatHtmlCache(value: unknown): value is string {
  return typeof value === "string" && value.length <= AI_CHAT_HTML_CACHE_MAX_CHARS &&
    value.slice(0, 192).includes(`data-ai-chat-renderer-version="${AI_CHAT_RENDERER_VERSION}"`) &&
    /^<section\s/.test(value);
}
