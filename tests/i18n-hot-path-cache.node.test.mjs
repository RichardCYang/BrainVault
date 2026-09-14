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
