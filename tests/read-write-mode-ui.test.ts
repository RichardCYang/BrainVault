import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Page read/write mode", () => {
  it("adds an accessible toggle menu and defaults the page state to read mode", () => {
    expect(index).toContain('id="page-mode-toggle"');
    expect(index).toContain('role="menuitemcheckbox"');
    expect(index).toContain('aria-checked="false"');
    expect(client).toContain('pageMode: pageModes.READ');
    expect(client).toContain('state.pageMode = pageModes.READ');
  });

  it("locks every block editor control and preserves non-editing attachment downloads", () => {
    expect(client).toContain('function syncBlockReadOnlyState');
    expect(client).toContain('control.matches(\'[data-action="download-attachment"]\')');
    expect(client).toContain('control.readOnly = true');
    expect(client).toContain('control.disabled = true');
    expect(client).toContain('draggable.draggable = false');
    expect(styles).toContain('.page-view.is-read-only .block-handle');
  });

  it("guards page and block mutations behind write mode", () => {
    expect(client).toContain('function requireWritablePage');
    expect(client).toMatch(/async function saveBlockRow[\s\S]*requireWritablePage/);
    expect(client).toMatch(/async function createEmptyBlock[\s\S]*requireWritablePage/);
    expect(client).toMatch(/async function savePageTitleNow[\s\S]*requireWritablePage/);
    expect(client).toMatch(/elements\.archivePageButton[\s\S]*requireWritablePage/);
  });

  it("does not create a block merely by opening an empty page", () => {
    const openPage = client.match(/async function openPage\(pageId\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(openPage).not.toContain('createEmptyBlock(pageId)');
    expect(openPage).toContain('state.pageMode = pageModes.READ');
  });

  it("includes Korean read-only labels and guidance", () => {
    expect(i18n).toContain('readMode: "읽기 모드"');
    expect(i18n).toContain('writeMode: "쓰기 모드"');
    expect(i18n).toContain('readOnlyBlocked: "읽기 전용 페이지입니다. 편집하려면 쓰기 모드로 전환하세요."');
  });
});
