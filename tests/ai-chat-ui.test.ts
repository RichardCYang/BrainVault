import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getAiChatData,
  normalizeAiChatMetadata,
  summarizeAiChatData
} from "../src/lib/ai-chat.js";
import { renderBlockHtml } from "../src/lib/markdown.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("../public/ai-chat-block.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");

describe("AI conversation block", () => {
  it("registers the slash command and structured editor", () => {
    expect(client).toContain('{ type: "AI_CHAT", command: "/ai", icon: "ai-chat" }');
    expect(client).toContain('createAiChatEditor(row, getBlockAiChatData(block)');
    expect(client).toContain('metadata.aiChat = aiChat');
    expect(client).toContain('payload.markdown = summarizeAiChatData(aiChat)');
    expect(schema).toContain('"AI_CHAT"');
  });

  it("offers the requested provider icons and editable metadata", () => {
    for (const provider of ["chatgpt", "gemini", "claude", "deepseek", "grok"]) {
      expect(moduleSource).toContain(`{ id: "${provider}"`);
      expect(styles).toContain(`.ai-provider-icon[data-provider="${provider}"]`);
    }
    expect(moduleSource).toContain('timeInput.type = "datetime-local"');
    expect(moduleSource).toContain('modelInput.className = "ai-chat-model-input"');
    expect(moduleSource).toContain('questionInput.className = "ai-chat-question-input"');
    expect(moduleSource).toContain('answerInput.className = "ai-chat-answer-input"');
  });

  it("normalizes AI metadata and keeps it searchable", () => {
    const metadata = normalizeAiChatMetadata({
      untouched: true,
      aiChat: {
        provider: "gemini",
        model: "Gemini Pro",
        answeredAt: "2026-07-17T12:34",
        question: "How does this work?",
        answer: "It stores a structured transcript."
      }
    });
    const data = getAiChatData(metadata);

    expect(metadata.untouched).toBe(true);
    expect(data.provider).toBe("gemini");
    expect(data.model).toBe("Gemini Pro");
    expect(data.answeredAt).toBe("2026-07-17T12:34");
    expect(summarizeAiChatData(data)).toContain("How does this work?");
    expect(summarizeAiChatData(data)).toContain("It stores a structured transcript.");
  });

  it("renders sanitized question and answer bubbles", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "claude",
        model: "Claude Test",
        answeredAt: "2026-07-17T09:10",
        question: "<script>alert(1)</script>Question",
        answer: "**Safe** answer"
      }
    });

    expect(html).toContain('class="rendered-ai-chat"');
    expect(html).toContain("Claude Test");
    expect(html).toContain("Question");
    expect(html).toContain("<strong>Safe</strong>");
    expect(html).not.toContain("script");
  });

  it("uses responsive chat bubbles and hides settings in read mode", () => {
    expect(styles).toContain(".ai-chat-message--question");
    expect(styles).toContain(".ai-chat-message--answer");
    expect(styles).toMatch(/\.ai-chat-block-editor\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
    expect(styles).toMatch(/\.ai-chat-settings\s*\{[^}]*background:\s*var\(--ai-chat-panel\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
    expect(styles).toMatch(/\.ai-chat-message\s*\{[^}]*border-radius:\s*8px;[^}]*background:\s*var\(--ai-chat-panel\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
    expect(styles).toMatch(/\.page-view\.is-read-only \.ai-chat-settings\s*\{[^}]*display:\s*none;/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.ai-chat-message,[\s\S]*width:\s*100%;/s);
  });

  it("includes Korean labels", () => {
    expect(i18n).toContain('AI_CHAT: "AI 대화"');
    expect(i18n).toContain('providerLabel: "AI 아이콘"');
    expect(i18n).toContain('timeLabel: "답변 일시"');
    expect(i18n).toContain('answerPlaceholder: "AI 답변을 붙여넣거나 입력하세요…"');
  });
});
