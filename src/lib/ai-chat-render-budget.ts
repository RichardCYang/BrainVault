import type { AiChatData } from "./ai-chat.js";

// Bounds synchronous Markdown parsing, sanitizer CPU and html_cache amplification.
// This is a rendering limit, NOT an editor/storage limit: excess source remains
// intact in canonical metadata so opening/saving an existing note never erases it.
export const AI_CHAT_RENDER_MAX_TOTAL_SOURCE_CHARS = 96_000;
export const AI_CHAT_RENDER_MAX_SEGMENT_CHARS = 16_000;

export function isAiChatWithinRenderBudget(data: AiChatData): boolean {
  let total = 0;
  for (const turn of data.turns) {
    if (
      turn.question.length > AI_CHAT_RENDER_MAX_SEGMENT_CHARS ||
      turn.answer.length > AI_CHAT_RENDER_MAX_SEGMENT_CHARS
    ) return false;
    total += turn.question.length + turn.answer.length;
    if (total > AI_CHAT_RENDER_MAX_TOTAL_SOURCE_CHARS) return false;
  }
  return true;
}
