import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  getAiChatData,
  normalizeAiChatMetadata,
  summarizeAiChatData
} from "../src/lib/ai-chat.js";
import { renderBlockHtml } from "../src/lib/markdown.js";
import { toBlock } from "../src/lib/mappers.js";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const moduleSource = readFileSync(new URL("../public/ai-chat-block.js", import.meta.url), "utf8");
const highlighterSource = readFileSync(new URL("../public/code-highlighting.js", import.meta.url), "utf8");
const runtimeConfigSource = readFileSync(new URL("../public/runtime-config.js", import.meta.url), "utf8");
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

  it("uses the server-delivered AI answer Markdown limit with a 50,000-character fallback", () => {
    expect(moduleSource).toContain('import { AI_CHAT_ANSWER_MAX_LENGTH } from "./runtime-config.js";');
    expect(moduleSource).toContain("answerLength: AI_CHAT_ANSWER_MAX_LENGTH");
    expect(runtimeConfigSource).toContain("AI_CHAT_ANSWER_MAX_LENGTH = 50_000");
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
    expect(moduleSource).toContain('button.className = "ai-chat-layout-option"');
    expect(moduleSource).toContain('answerBorderCheckbox.className = "ai-chat-answer-border-toggle"');
    expect(moduleSource).toContain('pagination.className = "ai-chat-pagination"');
    expect(moduleSource).toContain('turns: [...editor.querySelectorAll(".ai-chat-turn")]');
    expect(moduleSource).toContain('layout: editor.dataset.aiLayout');
    expect(moduleSource).toContain('hideAnswerBorder: editor.querySelector(".ai-chat-answer-border-toggle")?.checked === true');
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
    expect(data.layout).toBe("stacked");
    expect(data.hideAnswerBorder).toBe(false);
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
        layout: "paginated",
        turns: [
          { answeredAt: "2026-08-10T10:00", question: "First question", answer: "First answer" },
          { answeredAt: "2026-08-10T10:05", question: "Second question", answer: "Second answer" }
        ]
      }
    });
    const summary = summarizeAiChatData(data);

    expect(data.title).toBe("Research session");
    expect(data.layout).toBe("paginated");
    expect(data.turns).toHaveLength(2);
    expect(summary).toContain("Research session");
    expect(summary).toContain("First question");
    expect(summary).toContain("Second answer");
  });

  it("keeps continuous layout as the default and renders pagination only when selected", () => {
    const stacked = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        model: "GPT Test",
        turns: [
          { answeredAt: "", question: "One", answer: "First" },
          { answeredAt: "", question: "Two", answer: "Second" }
        ]
      }
    });
    const paginated = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        model: "GPT Test",
        layout: "paginated",
        turns: [
          { answeredAt: "", question: "One", answer: "First" },
          { answeredAt: "", question: "Two", answer: "Second" }
        ]
      }
    });

    expect(stacked).not.toContain("rendered-ai-chat--paginated");
    expect(stacked).not.toContain("rendered-ai-chat-pagination");
    expect(paginated).toContain('class="rendered-ai-chat rendered-ai-chat--paginated"');
    expect(paginated).toContain('class="rendered-ai-chat-track"');
    expect(paginated.match(/class="rendered-ai-chat-page/g)).toHaveLength(2);
    expect(paginated).toContain('data-ai-chat-page="0"');
    expect(paginated).toContain('data-ai-chat-page="1"');
    expect(paginated).toContain('aria-current="page"');
    expect(paginated.match(/class="rendered-ai-chat-turn/g)).toHaveLength(2);
    expect(paginated).toContain('class="rendered-ai-chat-turn is-active" aria-hidden="false"');
    expect(paginated).toContain('class="rendered-ai-chat-turn" aria-hidden="true"');
  });

  it("keeps answer borders by default and can switch to a ChatGPT-style borderless AI answer", () => {
    const defaultData = getAiChatData({ aiChat: { provider: "chatgpt", turns: [] } });
    const defaultHtml = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [{ answeredAt: "", question: "Question", answer: "Answer" }]
      }
    });
    const borderlessHtml = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        hideAnswerBorder: true,
        turns: [{ answeredAt: "", question: "Question", answer: "Answer" }]
      }
    });

    expect(defaultData.hideAnswerBorder).toBe(false);
    expect(defaultHtml).not.toContain("rendered-ai-chat--hide-answer-border");
    expect(borderlessHtml).toContain("rendered-ai-chat--hide-answer-border");
    expect(borderlessHtml).toContain('class="rendered-ai-chat-message rendered-ai-chat-question"');
    expect(borderlessHtml).toContain('class="rendered-ai-chat-message rendered-ai-chat-answer"');
    expect(styles).toMatch(/\.ai-chat-block-editor\[data-ai-hide-answer-border="true"\] \.ai-chat-message--answer\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
    expect(styles).toMatch(/\.rendered-ai-chat--hide-answer-border \.rendered-ai-chat-answer\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*box-shadow:\s*none;/s);
  });

  it("keeps Markdown code fences bordered when the AI answer card border is hidden", () => {
    const borderlessHtml = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        hideAnswerBorder: true,
        turns: [
          {
            answeredAt: "",
            question: "Show an example",
            answer: "```javascript\nconst answer = 42;\n```"
          }
        ]
      }
    });

    expect(borderlessHtml).toContain("rendered-ai-chat--hide-answer-border");
    expect(borderlessHtml).toContain('<pre class="rendered-code-pre"><code class="language-javascript">');
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-code-pre\s*\{[^}]*border:\s*1px solid rgba\(93, 132, 160, 0\.2\);[^}]*border-radius:\s*var\(--radius-md\);/s);
  });

  it("gives inline Markdown code a compact background without restyling fenced code", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "Show both code styles",
            answer: "Run `npm test` first.\n\n```bash\nnpm test\n```"
          }
        ]
      }
    });

    expect(html).toContain("<code>npm test</code>");
    expect(html).toContain('<pre class="rendered-code-pre"><code class="language-bash">');
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content :not\(pre\) > code\s*\{[^}]*border:\s*1px solid color-mix\(in srgb, var\(--accent-text\) 38%, var\(--line-strong\)\);[^}]*background:\s*var\(--accent-soft-strong\);[^}]*color:\s*var\(--ink-strong\);[^}]*padding:\s*0\.1em 0\.34em;[^}]*font-weight:\s*600;/s);
  });

  it("does not let AI Markdown forge pagination controls", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        layout: "paginated",
        turns: [
          {
            answeredAt: "",
            question: '<button class="rendered-ai-chat-page" data-ai-chat-page="49">forged</button>Question',
            answer: "Answer"
          },
          { answeredAt: "", question: "Second", answer: "Second answer" }
        ]
      }
    });

    expect(html).not.toContain("forged</button>");
    expect(html.match(/data-ai-chat-page=/g)).toHaveLength(2);
    expect(html).toContain("forgedQuestion");
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

  it("renders CJK-adjacent strong emphasis in AI answers without leaking literal asterisks", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "CJK emphasis",
            answer: "**문장 전체가 강조됩니다.**다음 문장과 앞**「핵심」**뒤, 그리고 **내용:**설명이 이어집니다."
          }
        ]
      }
    });

    expect(html).toContain("<strong>문장 전체가 강조됩니다.</strong>다음 문장");
    expect(html).toContain("앞<strong>「핵심」</strong>뒤");
    expect(html).toContain("<strong>내용:</strong>설명이 이어집니다.");
    expect(html).not.toContain("**문장 전체가 강조됩니다.**");
    expect(html).not.toContain("**「핵심」**");
  });

  it("keeps non-CJK CommonMark strong-emphasis boundaries and inline code unchanged", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "Boundary compatibility",
            answer: "a**\"quoted\"**b and `**literal**`"
          }
        ]
      }
    });

    expect(html).toContain("a**&quot;quoted&quot;**b");
    expect(html).toContain("<code>**literal**</code>");
  });

  it("renders HTTP(S) AI answer links as domain/favicon chips and keeps titles click-revealed", () => {
    expect(moduleSource).toContain('label.match(/^(?:\\[(\\d{1,3})\\]|(\\d{1,3}))$/)');
    expect(moduleSource).not.toContain('if (!referenceNumber) return null;');
    expect(moduleSource).toContain('getAiChatLinkFallbackTitle(link, url, referenceNumber)');
    expect(moduleSource).toContain('domain.className = "rendered-ai-chat-link-domain"');
    expect(moduleSource).toContain('showAiChatCitationPopover(citation);');
    expect(moduleSource).toContain('renderAiChatCitationPopoverSource(citation, activeAiChatCitationSourceIndex);');
    expect(moduleSource).toContain('t("aiChat.citationNextSource")');
    expect(styles).toMatch(/\.rendered-ai-chat-link-tooltip\s*\{[^}]*position:\s*fixed;[^}]*max-width:/s);
    expect(styles).toMatch(/\.rendered-ai-chat-link-tooltip-navigation\s*\{[^}]*display:\s*flex;/s);
  });

  it("preserves numeric and named HTTP(S) Markdown links for client-side citation hydration", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "Sources?",
            answer: "[1](https://docs.github.com/en/get-started) [MDN URL docs](https://developer.mozilla.org/en-US/docs/Web/API/URL)"
          }
        ]
      }
    });

    expect(html).toContain('<a href="https://docs.github.com/en/get-started"');
    expect(html).toContain('>1</a>');
    expect(html).toContain('<a href="https://developer.mozilla.org/en-US/docs/Web/API/URL"');
    expect(html).toContain('>MDN URL docs</a>');
    expect(html.match(/target="_blank"/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html.match(/rel="noopener noreferrer"/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("regenerates stale AI chat html_cache before exposing numeric reference-style citations", () => {
    const block = toBlock({
      id: "blk_ai_cache",
      page_id: "page_ai_cache",
      parent_block_id: null,
      type: "AI_CHAT",
      markdown: "legacy summary",
      html_cache: '<section class="rendered-ai-chat"><a href="https://docs.github.com/en/get-started">제목</a></section>',
      checked: 0,
      sort_order: 0,
      metadata: {
        aiChat: {
          provider: "chatgpt",
          turns: [
            {
              answeredAt: "",
              question: "Sources?",
              answer: [
                "Claim ([제목][1]).",
                "",
                "[1]: https://docs.github.com/en/get-started"
              ].join("\n")
            }
          ]
        }
      },
      created_at: "2026-08-29T00:00:00.000Z",
      updated_at: "2026-08-29T00:00:00.000Z"
    });

    expect(block.htmlCache).toMatch(/Claim \(<a href="https:\/\/docs\.github\.com\/en\/get-started"[^>]*>1<\/a>\)\./);
    expect(block.htmlCache).not.toContain(">제목</a>");
  });

  it("routes explicit numeric reference-style AI answer links through citation hydration", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "[Question title][1]\n\n[1]: https://question.example/source",
            answer: [
              "Claim ([제목][1]).",
              "",
              "Keep `[code title][2]` literal and [named docs][docs] as a named link.",
              "",
              "[1]: https://docs.github.com/en/get-started",
              "[2]: https://example.com/code-only",
              "[docs]: https://developer.mozilla.org/en-US/docs/Web/API/URL"
            ].join("\n")
          }
        ]
      }
    });

    // Questions keep ordinary CommonMark reference-link behavior. Only AI
    // answers opt into numeric citation normalization for the read-mode chips.
    expect(html).toMatch(/<a href="https:\/\/question\.example\/source"[^>]*>Question title<\/a>/);

    // [제목][1] becomes the same numeric anchor shape as [1](url), allowing
    // public/ai-chat-block.js to replace it with the favicon + domain chip.
    expect(html).toMatch(/Claim \(<a href="https:\/\/docs\.github\.com\/en\/get-started"[^>]*>1<\/a>\)\./);
    expect(html).not.toMatch(/<a href="https:\/\/docs\.github\.com\/en\/get-started"[^>]*>제목<\/a>/);

    // Inline code and nonnumeric reference-style links remain unchanged.
    expect(html).toContain("<code>[code title][2]</code>");
    expect(html).toMatch(/<a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/URL"[^>]*>named docs<\/a>/);
  });

  it("marks single numeric reference citations for read-mode hydration even before the paragraph tail", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "Single citations?",
            answer: [
              "First claim [1] continues in the same paragraph; second claim [2].",
              "An ordinary numeric link [7](https://example.com/ordinary) continues as normal prose.",
              "",
              "[1]: https://docs.github.com/en/get-started",
              "[2]: https://developer.mozilla.org/en-US/docs/Web/API/URL"
            ].join("\n")
          }
        ]
      }
    });

    expect(html).toMatch(/<a[^>]*class="rendered-ai-chat-citation-reference"[^>]*>1<\/a>/);
    expect(html).toMatch(/<a[^>]*class="rendered-ai-chat-citation-reference"[^>]*>2<\/a>/);
    expect(html.match(/rendered-ai-chat-citation-reference/g)?.length).toBe(2);
    expect(html).toMatch(/<a href="https:\/\/example\.com\/ordinary"[^>]*>7<\/a>/);
    expect(html).not.toMatch(/<a[^>]*class="rendered-ai-chat-citation-reference"[^>]*href="https:\/\/example\.com\/ordinary"/);
  });

  it("expands grouped numeric reference markers before CommonMark drops their source definitions", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        turns: [
          {
            answeredAt: "",
            question: "Grouped citations?",
            answer: [
              "First claim [1, 2].",
              "Second claim ([2, 3]).",
              "Keep `[1, 2]` literal inside code.",
              "",
              "[1]: https://docs.github.com/en/get-started",
              "[2]: https://developer.mozilla.org/en-US/docs/Web/API/URL",
              "[3]: https://www.nasa.gov/mission-pages"
            ].join("\n")
          }
        ]
      }
    });

    expect(html).toMatch(/First claim \[<a href="https:\/\/docs\.github\.com\/en\/get-started"[^>]*>1<\/a>, <a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/URL"[^>]*>2<\/a>\]\./);
    expect(html).toMatch(/Second claim \(\[<a href="https:\/\/developer\.mozilla\.org\/en-US\/docs\/Web\/API\/URL"[^>]*>2<\/a>, <a href="https:\/\/www\.nasa\.gov\/mission-pages"[^>]*>3<\/a>\]\)\./);
    expect(html).toContain("<code>[1, 2]</code>");
    expect(html).not.toContain("First claim [1, 2]");
    expect(html).not.toContain("Second claim ([2, 3])");
  });

  it("keeps display LaTeX centered and wrapped inside read-only AI answers", () => {
    expect(styles).toMatch(/\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-ai-chat-content \.math-expression--display\s*\{[^}]*width:\s*100%;[^}]*overflow-x:\s*hidden;[^}]*text-align:\s*center;/s);
    expect(styles).toMatch(/\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-ai-chat-content \.math-expression--display \.katex-display\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*overflow:\s*visible;[^}]*text-align:\s*center;/s);
    expect(styles).toMatch(/\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-ai-chat-content \.math-expression--display \.katex-display > \.katex\s*\{[^}]*max-width:\s*100%;[^}]*white-space:\s*normal;[^}]*text-align:\s*center;/s);
  });

  it("renders Markdown blockquotes with a visible left rail inside AI answers", () => {
    const html = renderBlockHtml("AI_CHAT", "", false, {
      aiChat: {
        provider: "chatgpt",
        model: "GPT Test",
        turns: [
          {
            answeredAt: "",
            question: "Quote this",
            answer: "> Quoted insight"
          }
        ]
      }
    });

    expect(html).toContain("<blockquote>");
    expect(html).toContain("<p>Quoted insight</p>");
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content blockquote\s*\{[^}]*margin:\s*0\.72rem 0;[^}]*border-left:\s*3px solid color-mix\(in srgb, var\(--accent-text\) 72%, var\(--line-strong\)\);[^}]*border-radius:\s*0 var\(--radius-md\) var\(--radius-md\) 0;[^}]*background:\s*var\(--accent-soft\);[^}]*padding:\s*0\.52rem 0\.76rem 0\.52rem 0\.78rem;[^}]*color:\s*var\(--ink\);/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content blockquote > :first-child\s*\{[^}]*margin-top:\s*0;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content blockquote > :last-child\s*\{[^}]*margin-bottom:\s*0;/s);
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
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content\s*\{[^}]*overflow-x:\s*clip;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content table\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;[^}]*table-layout:\s*fixed;[^}]*border:\s*0;[^}]*border-collapse:\s*collapse;[^}]*background:\s*transparent;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content th,[\s\S]*\.rendered-ai-chat-answer \.rendered-ai-chat-content td\s*\{[^}]*min-width:\s*0;[^}]*border:\s*0;[^}]*border-bottom:\s*1px solid var\(--line\);[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content th\s*\{[^}]*background:\s*color-mix\(in srgb, var\(--panel-soft\) 24%, transparent\);/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-ai-chat-content tbody tr:last-child > \*\s*\{[^}]*border-bottom:\s*0;/s);
  });

  it("keeps long AI answer text and code inside the message width without horizontal scrolling", () => {
    expect(styles).toMatch(/\.rendered-ai-chat-message\s*\{[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-content\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*clip;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-content pre\s*\{[^}]*overflow-x:\s*hidden;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-answer \.rendered-code-pre code\.hljs\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*white-space:\s*pre-wrap;[^}]*overflow-wrap:\s*anywhere;/s);
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

  it("re-measures AI textarea heights when read mode switches back to write mode", () => {
    expect(moduleSource).toContain("export function syncAiChatTextareaHeights(root = document)");
    expect(moduleSource).toContain("textarea.getClientRects?.().length === 0");
    expect(client).toContain("syncAiChatTextareaHeights,");
    expect(client).toContain("if (!isPageReadOnly()) syncAiChatTextareaHeights(elements.pageView);");
  });

  it("uses a horizontal one-pair viewport with numbered navigation and preserves all pairs for print", () => {
    expect(styles).toMatch(/\.ai-chat-block-editor\[data-ai-layout="paginated"\] \.ai-chat-conversation\s*\{[^}]*flex-direction:\s*row;/s);
    expect(styles).toMatch(/\.rendered-ai-chat--paginated \.rendered-ai-chat-track\s*\{[^}]*flex-direction:\s*row;/s);
    expect(styles).toMatch(/\.rendered-ai-chat--paginated \.rendered-ai-chat-turn:not\(\.is-active\)\s*\{[^}]*height:\s*0;[^}]*visibility:\s*hidden;/s);
    expect(styles).toMatch(/\.rendered-ai-chat-pagination\s*\{[\s\S]*overflow-x:\s*auto;/s);
    expect(styles).toMatch(/body\.pdf-export-mode \.rendered-ai-chat--paginated \.rendered-ai-chat-track\s*\{[^}]*flex-direction:\s*column !important;[^}]*transform:\s*none !important;/s);
    expect(styles).toMatch(/body\.pdf-export-mode \.rendered-ai-chat-pagination\s*\{[^}]*display:\s*none !important;/s);
    expect(styles).toMatch(/@media print[\s\S]*\.rendered-ai-chat--paginated \.rendered-ai-chat-track\s*\{[^}]*flex-direction:\s*column !important;[^}]*transform:\s*none !important;/s);
    expect(styles).toMatch(/@media print[\s\S]*\.rendered-ai-chat-pagination\s*\{[^}]*display:\s*none !important;/s);
    expect(client).toContain('hydrateRenderedAiChatPagination(preview);');
    expect(client).toContain('button.rendered-ai-chat-page');
    expect(client).toContain('setRenderedAiChatPage(chat, page);');
    expect(client).toContain('.rendered-ai-chat-page');
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
    expect(i18n).toContain('layoutLabel: "표시 방식"');
    expect(i18n).toContain('layoutStacked: "연속"');
    expect(i18n).toContain('layoutPaginated: "페이지"');
    expect(i18n).toContain('hideAnswerBorder: "AI 답변 테두리 숨기기"');
    expect(i18n).toContain('pageAria: "{count}번째 질문·답변 쌍 보기"');
    expect(i18n).toContain('addTurn: "+ 다음 질문·답변 추가"');
    expect(i18n).toContain('answerPlaceholder: "AI 답변을 붙여넣거나 입력하세요…"');
  });
});
