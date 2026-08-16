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
