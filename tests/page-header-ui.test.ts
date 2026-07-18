import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Page view header and actions menu", () => {
  it("adds an accessible page header with an emoji breadcrumb and three-dot trigger", () => {
    expect(index).toContain('id="page-view-header"');
    expect(index).toContain('id="page-path"');
    expect(index).toContain('id="page-actions-button"');
    expect(index).toContain('aria-haspopup="menu"');
    expect(index).toContain('aria-controls="page-actions-menu"');
    expect(client).toContain("function getPagePathSegments");
    expect(client).toContain("function renderPagePath");
    expect(client).toContain('emoji.textContent = segment.icon');
  });

  it("stacks the page icon above a large, full-width title like a Notion page", () => {
    expect(index).toMatch(/class="page-heading"[\s\S]*class="page-emoji-button page-title-icon-button"[\s\S]*class="page-title-row"[\s\S]*id="page-kicker"/);
    expect(styles).toContain("/* Notion-inspired page icon and title hierarchy */");
    expect(styles).toMatch(/\.app-mode \.page-title-icon-button\s*\{[\s\S]*?width:\s*5\.75rem;[\s\S]*?font-size:\s*4\.7rem;/);
    expect(styles).toMatch(/\.app-mode \.page-title-input\s*\{[\s\S]*?width:\s*100%;[\s\S]*?font-size:\s*clamp\(2\.55rem, 5vw, 3\.4rem\);/);
  });

  it("moves PDF export and archive into the page context menu", () => {
    expect(index).toMatch(/id="page-actions-menu"[\s\S]*id="export-pdf-button"[\s\S]*id="archive-page-button"/);
    const toolbar = index.match(/<div class="page-toolbar">[\s\S]*?<\/div>\s*<\/div>/)?.[0] ?? "";
    expect(toolbar).not.toContain('id="export-pdf-button"');
    expect(toolbar).not.toContain('id="archive-page-button"');
    expect(client).toContain("function openPageActionsMenu");
    expect(client).toContain("function closePageActionsMenu");
    expect(client).toContain('["ArrowDown", "ArrowUp", "Home", "End"]');
  });

  it("styles the header responsively and excludes its controls from PDF output", () => {
    expect(styles).toContain(".page-view-header");
    expect(styles).toContain(".page-actions-menu");
    expect(styles).toContain(".page-view-path-emoji");
    expect(styles).toContain("body.pdf-export-mode .page-view-header");
    expect(styles).toContain("body.pdf-export-mode .page-actions-menu");
  });

  it("pins the desktop page header to the viewport top without a padded gap", () => {
    expect(styles).toMatch(/\.main\s*\{[\s\S]*?overflow-x:\s*clip;[\s\S]*?padding:\s*0 var\(--main-inline-padding\) 5rem;/);
    expect(styles).toMatch(/\.page-view-header\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;[\s\S]*?margin:\s*0 calc\(0px - var\(--main-inline-padding\)\) 2\.7rem;/);
    expect(styles).not.toContain("margin: calc(0px - var(--main-block-start)) calc(0px - var(--main-inline-padding)) 2.7rem;");
  });

  it("auto-dismisses page-open status messages and keeps the toast out of the header area", () => {
    expect(client).toContain("let statusClearTimer = null");
    expect(client).toContain("statusClearTimer = window.setTimeout(clearStatus, delay)");
    expect(client).toContain("const statusDismissDelay = 2400");
    expect(styles).toMatch(/\.status\s*\{[\s\S]*?bottom:\s*max\(1rem, env\(safe-area-inset-bottom\)\);/);
    expect(styles).not.toMatch(/\.status\s*\{[\s\S]*?top:\s*0\.85rem;/);
  });

  it("includes Korean labels for the new page header controls", () => {
    expect(i18n).toContain('pathAria: "현재 페이지 경로"');
    expect(i18n).toContain('moreActionsGeneric: "페이지 더보기"');
    expect(i18n).toContain('actionsAriaGeneric: "페이지 작업"');
  });

  it("removes the page-level tag input and its save wiring", () => {
    expect(index).not.toContain('id="page-tags"');
    expect(index).not.toContain('class="tags-label"');
    expect(client).not.toContain('pageTags: $("#page-tags")');
    expect(client).not.toContain("elements.pageTags");
    expect(client).not.toContain("function tagsFromInput");
    expect(client).toContain('body: { title: task.title, expectedVersion: currentPage?.version, mutationId: task.mutationId }');
    expect(styles).not.toContain(".tags-label");
    expect(i18n).not.toContain('guide2Title: "2. 제목과 태그 정리"');
  });
});
