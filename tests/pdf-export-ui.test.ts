import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const client = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const i18n = readFileSync(new URL("../public/i18n.js", import.meta.url), "utf8");

describe("Current-page PDF export", () => {
  it("adds a localized PDF export action to every open page", () => {
    expect(index).toContain('id="export-pdf-button"');
    expect(index).toContain('data-i18n="page.exportPdf"');
    expect(index).toContain('data-i18n-title="page.exportPdfTitle"');
  });

  it("uses the native browser print engine after preparing page assets and layout", () => {
    expect(client).toContain("async function exportCurrentPageToPdf()");
    expect(client).toContain("await waitForPdfExportAssets()");
    expect(client).toContain("freezePdfExportComputedStyles()");
    expect(client).toContain("configurePdfExportLayout()");
    expect(client).toContain("window.print()");
    expect(client).toContain('document.body.classList.add("pdf-export-mode")');
  });

  it("preserves print colors, expands scroll containers, and prevents common block splits", () => {
    expect(styles).toContain("print-color-adjust: exact");
    expect(styles).toMatch(/@page\s*\{[^}]*size:\s*A4 landscape;[^}]*margin:\s*10mm;/s);
    expect(styles).toMatch(/body\.pdf-export-mode \.kanban-board-scroll[^{]*\{[^}]*overflow:\s*visible !important;/s);
    expect(styles).toContain("break-inside: avoid");
    expect(styles).toContain("zoom: var(--pdf-export-scale, 1)");
    expect(styles).toMatch(/body\.pdf-export-mode \.block-handle\s*\{[^}]*visibility:\s*hidden !important;/s);
  });

  it("includes Korean export labels and guidance", () => {
    expect(i18n).toContain('exportPdf: "PDF 내보내기"');
    expect(i18n).toContain('pdfSaveInstructions: "인쇄 창에서 ‘PDF로 저장’을 선택하세요."');
    expect(i18n).toContain('pdfExportFailed: "PDF 내보내기 창을 열지 못했습니다.');
  });
});
