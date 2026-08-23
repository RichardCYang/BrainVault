import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error Browser-side JavaScript module intentionally has no TypeScript declaration.
import { supportedLanguages, translationCatalogs } from "../public/i18n.js";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

const modeTranslationKeys = [
  "page.readMode",
  "page.writeMode",
  "page.readModeDescription",
  "page.writeModeDescription",
  "page.readOnlyHelp",
  "page.readerAria",
  "empty.readOnlyPage",
  "empty.noBlocksWrite",
  "status.documentCreated",
  "status.readModeEnabled",
  "status.writeModeEnabled",
  "status.readOnlyBlocked",
  "errors.readOnlyPage"
];

function getTranslation(catalog: object, key: string) {
  return key.split(".").reduce<unknown>((value, segment) => {
    if (!value || typeof value !== "object") return undefined;
    return (value as Record<string, unknown>)[segment];
  }, catalog);
}

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

  it("keeps read-mode callouts to a single rendered border", () => {
    expect(styles).toMatch(
      /\.page-view\.is-read-only \.editor-block-row\[data-block-type="CALLOUT"\] \.block-row-body\s*\{[^}]*border:\s*0;[^}]*background:\s*transparent;[^}]*padding:\s*0;/s
    );
    expect(styles).toMatch(
      /\.page-view\.is-read-only \.editor-block-row\[data-block-type="CALLOUT"\] \.block-row-body::before\s*\{[^}]*content:\s*none;/s
    );
    expect(styles).toMatch(/\.rendered-callout\s*\{[^}]*border:\s*1px solid/s);
    expect(styles).toMatch(
      /\.page-view\.is-read-only \.editor-block-row\[data-block-type="CALLOUT"\] \.rendered-callout\s*\{[^}]*padding-top:\s*0\.55rem;[^}]*padding-bottom:\s*0\.55rem;/s
    );
    expect(styles).toMatch(
      /\.page-view\.is-read-only \.editor-block-row\[data-block-type="CALLOUT"\] \.rendered-callout > :first-child\s*\{[^}]*margin-top:\s*0;/s
    );
    expect(styles).toMatch(
      /\.page-view\.is-read-only \.editor-block-row\[data-block-type="CALLOUT"\] \.rendered-callout > :last-child\s*\{[^}]*margin-bottom:\s*0;/s
    );
  });

  it("guards page and block mutations behind write mode", () => {
    expect(client).toContain('function requireWritablePage');
    expect(client).toMatch(/async function saveBlockRow[\s\S]*requireWritablePage/);
    expect(client).toMatch(/async function createEmptyBlock[\s\S]*requireWritablePage/);
    expect(client).toMatch(/async function savePageTitleNow[\s\S]*requireWritablePage/);
    expect(client).toMatch(/elements\.archivePageButton[\s\S]*requireWritablePage/);
  });

  it("allows the write-mode transition to create the first block while its own transition lock is active", () => {
    const setPageMode = client.match(/async function setPageMode\(nextMode, \{ announce = true \} = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(setPageMode).toContain("const pageId = state.selectedPage.id;");
    expect(setPageMode).toContain("const navigationGeneration = workspaceNavigationGeneration;");
    expect(setPageMode).toContain("const isPageModeIntentCurrent = () => (");
    expect(setPageMode).toContain("const data = await createEmptyBlock(pageId, {");
    expect(setPageMode).toContain("navigationGeneration");
  });

  it("does not create a block merely by opening an empty page", () => {
    const openPage = client.match(/async function openPage\(pageId, \{ skipFlush = false \} = \{\}\) \{[\s\S]*?\n\}/)?.[0] ?? "";
    expect(openPage).not.toContain('createEmptyBlock(pageId)');
    expect(openPage).toContain('state.pageMode = pageModes.READ');
  });

  it("includes Korean read-only labels and guidance", () => {
    expect(i18n).toContain('readMode: "읽기 모드"');
    expect(i18n).toContain('writeMode: "쓰기 모드"');
    expect(i18n).toContain('readOnlyBlocked: "읽기 전용 페이지입니다. 편집하려면 쓰기 모드로 전환하세요."');
  });

  it("localizes every read/write-mode message in every supported language", () => {
    for (const { code } of supportedLanguages) {
      const catalog = translationCatalogs[code as keyof typeof translationCatalogs];
      for (const key of modeTranslationKeys) {
        const localized = getTranslation(catalog, key);
        expect(localized).toBeTypeOf("string");
        expect(localized).not.toBe("");
        if (code !== "en") {
          expect(localized).not.toBe(getTranslation(translationCatalogs.en, key));
        }
      }
    }
  });
});
