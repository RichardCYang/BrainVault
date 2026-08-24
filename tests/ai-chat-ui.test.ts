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
const highlighterSource = readFileSync(new URL("../public/code-highlighting.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");

describe("AI conversation block", () => {
  it("registers the slash command, structured editor, and rendered preview", () => {
    expect(client).toContain('{ type: "AI_CHAT", command: "/ai", icon: "ai-chat" }');
    expect(client).toContain('createAiChatEditor(row, getBlockAiChatData(block)');
    expect(client).toContain('htmlCache: block.htmlCache ?? ""');
    expect(client).toContain('metadata.aiChat = aiChat');
    expect(client).toContain('payload.markdown = summarizeAiChatData(aiChat)');
    expect(moduleSource).toContain('preview.className = "block-rendered-preview ai-chat-rendered-preview"');
    expect(schema).toContain('"AI_CHAT"');
  });

  it("offers provider icons, a block title, and multiple conversation turns", () => {
    for (const provider of ["chatgpt", "gemini", "claude", "deepseek", "grok"]) {
      expect(moduleSource).toContain(`{ id: "${provider}"`);
      expect(styles).toContain(`.ai-provider-icon[data-provider="${provider}"]`);
    }
    expect(moduleSource).toContain('titleInput.className = "ai-chat-title-input"');
    expect(moduleSource).toContain('timeInput.type = "datetime-local"');
    expect(moduleSource).toContain('modelInput.className = "ai-chat-model-input"');
    expect(moduleSource).toContain('questionInput.className = "ai-chat-question-input"');
    expect(moduleSource).toContain('answerInput.className = "ai-chat-answer-input"');
    expect(moduleSource).toContain('addTurnButton.className = "ai-chat-add-turn"');
    expect(moduleSource).toContain('removeButton.className = "ai-chat-remove-turn"');
    expect(moduleSource).toContain('turns: [...editor.querySelectorAll(".ai-chat-turn")]');
  });

  it("normalizes legacy single-pair metadata without losing searchability", () => {
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
    expect(data.title).toBe("");
    expect(data.provider).toBe("gemini");
    expect(data.model).toBe("Gemini Pro");
    expect(data.turns).toHaveLength(1);
    expect(data.turns[0].answeredAt).toBe("2026-07-17T12:34");
    expect(data.turns[0].question).toBe("How does this work?");
    expect(data.turns[0].answer).toBe("It stores a structured transcript.");
    expect(summarizeAiChatData(data)).toContain("How does this work?");
    expect(summarizeAiChatData(data)).toContain("It stores a structured transcript.");
  });

  it("keeps a titled multi-turn AI conversation searchable", () => {
    const data = getAiChatData({
      aiChat: {
        title: "Research session",
        provider: "claude",
        model: "Claude Test",
        turns: [
          { answeredAt: "2026-08-10T10:00", question: "First question", answer: "First answer" },
          { answeredAt: "2026-08-10T10:05", question: "Second question", answer: "Second answer" }
        ]
      }
    });
    const summary = summarizeAiChatData(data);

    expect(data.title).toBe("Research session");
    expect(data.turns).toHaveLength(2);
    expect(summary).toContain("Research session");
    expect(summary).toContain("First question");
    expect(summary).toContain("Second answer");
  });

  it("renders sanitized Markdown and LaTeX placeholders for every turn", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        title: "Rendered chat",
        provider: "claude",
        model: "Claude Test",
        turns: [
          {
            answeredAt: "2026-08-10T09:10",
            question: "<script>alert(1)</script>**Question** with $x^2$",
            answer: "**Safe** answer"
          },
          {
            answeredAt: "2026-08-10T09:12",
            question: "Second question",
            answer: "$$y=x+1$$"
          }
        ]
      }
    });

    expect(html).toContain('class="rendered-ai-chat"');
    expect(html).toContain('class="rendered-ai-chat-title"');
    expect(html).toContain("Rendered chat");
    expect(html.match(/class="rendered-ai-chat-turn"/g)).toHaveLength(2);
    expect(html).toContain("Claude Test");
    expect(html).toContain("<strong>Q1</strong>");
    expect(html).toContain("<strong>Safe</strong>");
    expect(html).toContain('class="math-expression math-expression--inline"');
    expect(html).toContain('class="math-expression math-expression--display"');
    expect(html).toContain('data-latex="x^2"');
    expect(html).toContain('data-latex="y=x+1"');
    expect(html).not.toContain("script");
  });

  it("renders Markdown tables as readable tables inside AI answers", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        model: "GPT Test",
        turns: [
          {
            answeredAt: "2026-08-24T18:30",
            question: "Compare the options",
            answer: "| Option | Score |\n| --- | --- |\n| **Alpha** | 9 |\n| Beta | 7 |"
          }
        ]
      }
    });

    expect(html).toContain("<table>");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<th>Option</th>");
    expect(html).toContain("<strong>Alpha</strong>");
    expect(html).toContain("<td>9</td>");
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content\s*\{[^}]*overflow-x:\s*auto;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content table\s*\{[^}]*min-width:\s*100%;[^}]*border:/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content th,[\s\S]*\.rendered-ai-chat-answer \.rendered-ai-chat-content td\s*\{[^}]*border-bottom:/s);
  });

  it("uses content-sized questions and swaps editor for preview in read mode", () => {
    expect(styles).toContain(".ai-chat-message--question");
    expect(styles).toContain(".ai-chat-message--answer");
    expect(styles).toMatch(/\.ai-chat-block-editor\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
    expect(styles).toMatch(/\.ai-chat-settings\s*\{[^}]*background:\s*var\(--ai-chat-panel\);[^}]*box-shadow:\s*var\(--shadow-card\);/s);
    expect(styles).toMatch(/\.ai-chat-question-input\s*\{[^}]*min-height:\s*2\.35rem;/s);
    expect(moduleSource).toContain('textarea.classList.contains("ai-chat-question-input") ? 38 : 112');
    expect(styles).toMatch(/\.page-view\.is-read-only \.ai-chat-editing-surface\s*\{[^}]*display:\s*none;/s);
    expect(styles).toMatch(/\.page-view\.is-read-only \.ai-chat-rendered-preview\s*\{[^}]*display:\s*block;/s);
    expect(styles).toMatch(/@media \(max-width: 640px\)[\s\S]*\.ai-chat-message,[\s\S]*width:\s*100%;/s);
  });

  it("hydrates final collaborative HTML cache before entering read mode", () => {
    expect(client).toContain("function applyMaterializedHtmlCaches(result)");
    expect(client).toContain("const materialization = await flushPendingPageEdits({ allowLocked: true });");
    expect(client).toContain("applyMaterializedHtmlCaches(materialization);");
    expect(client).toContain("updateRenderedBlockPreview(row, block);");
  });

  it("adds copy controls only to rendered AI answer code blocks in read mode", () => {
    expect(highlighterSource).toContain('.rendered-ai-chat-answer .rendered-code-pre');
    expect(highlighterSource).toContain('button.dataset.action = "copy-ai-answer-code"');
    expect(highlighterSource).toContain('await copyTextToClipboard(code.textContent ?? "")');
    expect(client).toContain('[data-action="copy-ai-answer-code"]');
    expect(client).toContain('if (isPageReadOnly()) hydrateHighlightedCodeBlocks(elements.pageView);');
    expect(styles).toMatch(/\.rendered-code-copy-button\s*\{[\s\S]*display:\s*none;/s);
    expect(styles).toMatch(/\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-code-copy-button\s*\{[^}]*display:\s*inline-flex;/s);
    expect(styles).toMatch(/body\.pdf-export-mode \.rendered-code-copy-button\s*\{[^}]*display:\s*none !important;/s);
    expect(i18n).toContain('copyCode: "복사"');
    expect(i18n).toContain('codeCopied: "복사됨"');
    expect(i18n).toContain('codeCopyFailed: "복사 실패"');
  });

  it("includes Korean labels for titles and turn controls", () => {
    expect(i18n).toContain('AI_CHAT: "AI 대화"');
    expect(i18n).toContain('providerLabel: "AI 아이콘"');
    expect(i18n).toContain('titlePlaceholder: "AI 대화 블록 제목"');
    expect(i18n).toContain('timeLabel: "답변 일시"');
    expect(i18n).toContain('addTurn: "+ 다음 질문·답변 추가"');
    expect(i18n).toContain('answerPlaceholder: "AI 답변을 붙여넣거나 입력하세요…"');
  });
});
