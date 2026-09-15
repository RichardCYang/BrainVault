import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const clientSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");

test("high-volume client formatting routes through the shared i18n formatter caches", () => {
  assert.doesNotMatch(clientSource, /new Intl\.NumberFormat\(/);
  assert.doesNotMatch(clientSource, /new Intl\.DisplayNames\(/);
  assert.match(
    clientSource,
    /formatNumber\(amount, \{ maximumFractionDigits: amount >= 100 \? 0 : 1 \}\)/
  );
  assert.match(
    clientSource,
    /formatNumber\(value, \{ maximumFractionDigits: value >= 10 \? 0 : 1 \}\)/
  );
  assert.match(clientSource, /const label = formatRegionName\(normalized\);/);
});

test("Intl hot paths avoid repeated locale scans and allocation-heavy option-key pipelines", async () => {
  const source = await readFile(new URL("../public/i18n.js", import.meta.url), "utf8");
  const localeStart = source.indexOf("export function getLocale()");
  const localeEnd = source.indexOf("export function getLanguageLabel", localeStart);
  const localeSection = source.slice(localeStart, localeEnd);
  assert.match(localeSection, /return currentLocale;/);
  assert.doesNotMatch(localeSection, /supportedLanguages\.find/);

  const keyStart = source.indexOf("function getIntlFormatOptionsKey(options)");
  const keyEnd = source.indexOf("const numberFormattersByKey", keyStart);
  const keySection = source.slice(keyStart, keyEnd);
  assert.match(keySection, /if \(!options\) return "";/);
  assert.doesNotMatch(keySection, /localeCompare|\.filter\(|\.map\(/);
});
