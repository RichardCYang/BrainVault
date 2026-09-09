import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

function source(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const db = source("../src/lib/db.ts");
const schemas = source("../src/utils/schemas.ts");
const pageRoute = source("../src/routes/page.routes.ts");
const blockRoute = source("../src/routes/block.routes.ts");
const collaborationRoute = source("../src/routes/collaboration.routes.ts");
const pageVersionHistory = source("../src/lib/page-version-history.ts");

test("MariaDB refuses approximate BIGINT-to-Number conversions", () => {
  assert.match(db, /bigIntAsNumber: true,[\s\S]*checkNumberRange: true/);
});

test("optimistic version inputs are bounded to JavaScript's exact integer range", () => {
  assert.match(schemas, /safeVersionSchema = z\.number\(\)\.int\(\)\.min\(1\)\.max\(Number\.MAX_SAFE_INTEGER\)/);
  assert.match(pageRoute, /expectedVersion: safeVersionSchema/);
  assert.match(blockRoute, /expectedVersion: safeVersionSchema/);
  assert.match(blockRoute, /version: safeVersionSchema/);
  assert.match(blockRoute, /expectedPageContentVersion: safeVersionSchema\.optional\(\)/);
});

test("reproduction demonstrates the unsafe adjacent-BIGINT collision that the connector guard rejects", () => {
  const output = execFileSync(
    process.execPath,
    [new URL("../scripts/reproduce-bigint-version-collision.mjs", import.meta.url).pathname],
    { encoding: "utf8" }
  );
  const result = JSON.parse(output);
  assert.equal(result.vulnerable.compareEqual, true);
  assert.equal(result.fixed.olderAccepted, false);
  assert.equal(result.fixed.newerAccepted, false);
});

test("every SQL version increment is fenced below the JavaScript safe-integer ceiling", () => {
  const count = (text, pattern) => text.match(pattern)?.length ?? 0;

  assert.equal(count(pageRoute, /edit_version = edit_version \+ 1/g), 3);
  assert.equal(count(pageRoute, /edit_version < \?/g), 3);

  assert.equal(count(blockRoute, /edit_version = edit_version \+ 1/g), 5);
  assert.equal(count(blockRoute, /edit_version < \?/g), 5);
  assert.equal(count(blockRoute, /content_version = content_version \+ 1/g), 1);
  assert.equal(count(blockRoute, /content_version < \?/g), 1);

  assert.equal(count(collaborationRoute, /edit_version = edit_version \+ 1/g), 5);
  assert.equal(count(collaborationRoute, /edit_version < \?/g), 5);
  assert.equal(count(collaborationRoute, /content_version = content_version \+ 1/g), 1);
  assert.equal(count(collaborationRoute, /content_version < \?/g), 1);
});

test("page-version history refuses to create an unsafe revision", () => {
  assert.match(pageVersionHistory, /currentRevision >= Number\.MAX_SAFE_INTEGER/);
  assert.equal(Number.isSafeInteger(Number.MAX_SAFE_INTEGER + 1), false);
});
