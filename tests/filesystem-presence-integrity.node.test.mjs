import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { isDefinitivePathAbsenceError } from "../src/lib/filesystem-presence.ts";

const customIconsSource = readFileSync(new URL("../src/lib/custom-icons.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

test("only definitive filesystem absence may prune a custom-icon library row", () => {
  for (const code of ["ENOENT", "ENOTDIR"]) {
    assert.equal(isDefinitivePathAbsenceError(Object.assign(new Error(code), { code })), true);
  }
  for (const code of ["EACCES", "EIO", "EMFILE", "ENFILE", "ESTALE"]) {
    assert.equal(isDefinitivePathAbsenceError(Object.assign(new Error(code), { code })), false);
  }
  assert.equal(isDefinitivePathAbsenceError(new Error("unknown")), false);

  assert.match(customIconsSource, /catch \(error\) \{[\s\S]*?isDefinitivePathAbsenceError\(error\)[\s\S]*?throw error;/);
  assert.match(customIconsSource, /DELETE FROM custom_icons WHERE user_id = \? AND id IN/);
  assert.doesNotMatch(customIconsSource, /catch \{\s*missingIds\.push\(row\.id\);\s*\}/);
});

test("restoring a custom icon library entry rolls back on uncertain filesystem errors", () => {
  const restoreStart = customIconsSource.indexOf("export async function restoreCustomIconToLibrary");
  const restoreEnd = customIconsSource.indexOf("export async function rememberCustomIconPaths", restoreStart);
  const restoreSource = customIconsSource.slice(restoreStart, restoreEnd);
  assert.ok(restoreStart >= 0 && restoreEnd > restoreStart);
  assert.match(restoreSource, /DELETE FROM custom_icon_library_removals/);
  assert.match(restoreSource, /catch \(error\) \{[\s\S]*?isDefinitivePathAbsenceError\(error\)[\s\S]*?throw error;/);
});
