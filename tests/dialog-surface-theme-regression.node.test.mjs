import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const index = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");

function cssRule(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = styles.match(new RegExp(`${escaped}\\s*\\{([^}]*)\\}`, "s"));
  assert.ok(match, `missing CSS rule: ${selector}`);
  return match[1];
}

test("page and block move dialogs use the defined theme panel surface", () => {
  assert.match(index, /id="page-move-dialog"[^>]*class="block-move-dialog page-move-dialog"/s);
  assert.match(index, /id="block-move-dialog"[^>]*class="block-move-dialog"/s);

  const root = cssRule(":root");
  const dialog = cssRule(".block-move-dialog");
  const destinationSelect = cssRule(".block-move-field select");

  assert.match(root, /--panel:\s*#ffffff;/);
  assert.match(dialog, /background:\s*var\(--panel\);/);
  assert.match(destinationSelect, /background:\s*var\(--panel\);/);
});

test("move-dialog surfaces do not depend on the removed undefined surface tokens", () => {
  assert.doesNotMatch(styles, /var\(--surface(?:-soft)?\)/);
});

test("dark mode keeps an explicit opaque move-dialog surface and backdrop styling", () => {
  const darkDialog = cssRule('html[data-theme="dark"] .block-move-dialog');
  const backdrop = cssRule(".block-move-dialog::backdrop");

  assert.match(darkDialog, /background:\s*#24282d;/);
  assert.match(backdrop, /background:\s*rgba\(20, 27, 34, 0\.48\);/);
});
