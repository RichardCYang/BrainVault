import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8").replace(/\r\n/g, "\n");
const collaboration = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8").replace(
  /\r\n/g,
  "\n"
);

describe("Editor content limits", () => {
  it("enforces the server limits in title and block controls", () => {
    expect(index).toMatch(/id="page-title"[^>]*maxlength="160"/);
    expect(app).toContain("textarea.maxLength = BLOCK_MARKDOWN_MAX_LENGTH;");
  });

  it("does not truncate collaboration edits before the durability gate", () => {
    const scheduleStart = app.indexOf("function schedulePageTitleSave");
    const scheduleEnd = app.indexOf("function normalizeRecoveredBlockPayload", scheduleStart);
    const scheduleBody = app.slice(scheduleStart, scheduleEnd);
    expect(scheduleBody).toContain("const title = elements.pageTitle.value;");
    expect(scheduleBody).not.toContain(".slice(0, 160)");

    const setTitleStart = collaboration.indexOf("setTitle(value)");
    const setTitleEnd = collaboration.indexOf("upsertBlock(", setTitleStart);
    const setTitleBody = collaboration.slice(setTitleStart, setTitleEnd);
    expect(setTitleBody).toContain("const normalized = requirePageTitleWithinLimit(value);");
    expect(setTitleBody.indexOf("requirePageTitleWithinLimit")).toBeLessThan(
      setTitleBody.indexOf("this.commitLocalMutation")
    );

    const normalizeBlockStart = collaboration.indexOf("function normalizeBlock");
    const normalizeBlockEnd = collaboration.indexOf("function readDocumentSnapshot", normalizeBlockStart);
    expect(collaboration.slice(normalizeBlockStart, normalizeBlockEnd)).toContain(
      "markdown: requireBlockMarkdownWithinLimit(block?.markdown)"
    );
    expect(collaboration).not.toContain("String(block?.markdown ?? \"\").slice(0, 20_000)");
  });

  it("fails closed for collaboration snapshot and bootstrap titles", () => {
    expect(collaboration).toContain("title: requirePageTitleWithinLimit(title.toString())");
    expect(collaboration).toContain("replaceYText(this.title, requirePageTitleWithinLimit(page.title))");
    expect(collaboration).toContain(
      "title: requirePageTitleWithinLimit(session.document.title ?? this.page.title)"
    );
    expect(app).toContain("const nextTitle = requirePageTitleWithinLimit(snapshot.title);");
  });
});
