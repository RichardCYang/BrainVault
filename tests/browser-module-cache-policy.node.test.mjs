import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function parseCacheControl(value) {
  const directives = new Map();
  for (const item of value.split(",")) {
    const [name, rawValue] = item.trim().toLowerCase().split("=", 2);
    directives.set(name, rawValue ?? true);
  }
  return directives;
}

function canReuseWithoutRevalidation(value, ageSeconds) {
  const directives = parseCacheControl(value);
  if (directives.has("no-cache")) return false;
  const maxAge = Number(directives.get("max-age") ?? 0);
  return Number.isFinite(maxAge) && ageSeconds < maxAge;
}

const readSource = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("the previous immutable policy can retain an old module after deployment", () => {
  const previous = "public, max-age=31536000, immutable";
  assert.equal(canReuseWithoutRevalidation(previous, 24 * 60 * 60), true);
});

test("stable collaboration-module URLs revalidate instead of remaining fresh", async () => {
  const appSource = await readSource("src/app.ts");
  const match = /const browserModuleCacheControl = "([^"]+)"/.exec(appSource);
  assert.ok(match, "browser module cache policy must remain explicit");

  const policy = match[1];
  const directives = parseCacheControl(policy);
  assert.equal(canReuseWithoutRevalidation(policy, 1), false);
  assert.equal(directives.get("max-age"), "0");
  assert.equal(directives.has("must-revalidate"), true);
  assert.equal(directives.has("immutable"), false);

  assert.match(appSource, /res\.sendFile\(filePath, \{ cacheControl: false \}/);
  assert.match(
    appSource,
    /express\.static\(path\.join\(browserModuleRoot, "lib0"\), \{[\s\S]*?cacheControl: false,/
  );
});
