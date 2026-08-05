import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("PDF export enters its measurement mode before measuring the full-bleed page", async () => {
  const app = await readSource("public/app.js");
  const exportStart = app.indexOf("async function exportCurrentPageToPdf()");
  const exportEnd = app.indexOf("\n\nfunction clampPageCoverPosition", exportStart);
  const exportSource = app.slice(exportStart, exportEnd);
  const modeIndex = exportSource.indexOf('document.body.classList.add("pdf-export-mode")');
  const frameIndex = exportSource.indexOf("await waitForAnimationFrame()", modeIndex);
  const layoutIndex = exportSource.indexOf("configurePdfExportLayout()", frameIndex);

  assert.ok(exportStart >= 0 && exportEnd > exportStart);
  assert.ok(modeIndex >= 0, "PDF mode must be applied");
  assert.ok(frameIndex > modeIndex, "style/layout must settle after PDF mode is applied");
  assert.ok(layoutIndex > frameIndex, "PDF geometry must be measured after PDF mode is applied");
});

test("standalone reproduction demonstrates the wide-screen PDF scaling regression", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-page-cover-pdf-layout-regression.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.measurementModeAppliedFirst, false);
  assert.equal(result.vulnerable.unnecessarilyShrinksLegacyWidthContent, true);
  assert.equal(result.fixed.measurementModeAppliedFirst, true);
  assert.equal(result.fixed.unnecessarilyShrinksLegacyWidthContent, false);
  assert.equal(result.fixed.scale, 1);
});
