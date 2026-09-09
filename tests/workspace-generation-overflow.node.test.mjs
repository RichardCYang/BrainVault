import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const transfer = (await readFile(new URL("../src/lib/data-transfer.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");

test("workspace restore generation increment is fenced below the JavaScript safe-integer ceiling", () => {
  const updateStart = transfer.indexOf("const restoredUserUpdate = await client.execute");
  const updateEnd = transfer.indexOf("const restoredOwner =", updateStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart, "missing bounded restore user update");

  const section = transfer.slice(updateStart, updateEnd);
  assert.match(
    section,
    /attachment_generation = attachment_generation \+ 1[\s\S]*WHERE id = \? AND attachment_generation < \?/
  );
  assert.match(section, /userId,\s*Number\.MAX_SAFE_INTEGER/);
  assert.match(section, /Number\(restoredUserUpdate\.affectedRows\) !== 1/);
  assert.match(section, /"DATA_RESTORE_VERSION_EXHAUSTED"/);
});

test("reproduction: the previous restore increment could create an application-invalid generation", () => {
  const current = Number.MAX_SAFE_INTEGER;
  const previousNext = current + 1;

  assert.equal(Number.isSafeInteger(current), true);
  assert.equal(Number.isSafeInteger(previousNext), false);

  const fixedCanAdvance = current < Number.MAX_SAFE_INTEGER;
  assert.equal(fixedCanAdvance, false);
});
