import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  privateNoStoreCacheControl,
  setPrivateNoStoreCacheControl
} from "../src/lib/cache-control.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

function responseHeadersWithAuthenticatedPolicy() {
  const headers = new Map();
  setPrivateNoStoreCacheControl({
    setHeader(name, value) {
      headers.set(name.toLowerCase(), value);
    }
  });
  return headers;
}

function canSharedCacheStore(headers) {
  const directives = String(headers.get("cache-control") ?? "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return !directives.includes("no-store") && !directives.includes("private");
}

test("the authenticated response policy prohibits private and shared cache storage", () => {
  const headers = responseHeadersWithAuthenticatedPolicy();
  assert.equal(headers.get("cache-control"), privateNoStoreCacheControl);
  assert.equal(canSharedCacheStore(headers), false);
});

test("requireAuth applies cache isolation before every credential and database exit", () => {
  const source = read("src/middleware/auth.ts");
  const functionStart = source.indexOf("export async function requireAuth");
  const policyIndex = source.indexOf("setPrivateNoStoreCacheControl(res);", functionStart);
  const credentialIndex = source.indexOf("const cookieToken = readAuthSessionCookie(req);", functionStart);
  const databaseIndex = source.indexOf("const user = await db.queryOne", functionStart);

  assert.ok(functionStart >= 0);
  assert.ok(policyIndex > functionStart);
  assert.ok(policyIndex < credentialIndex);
  assert.ok(policyIndex < databaseIndex);
});

test("authenticated static documentation cannot override no-store with public cache metadata", () => {
  const source = read("src/app.ts");
  assert.match(
    source,
    /app\.use\(\s*"\/docs",\s*requireAuth,\s*express\.static\(docsDir,\s*\{[\s\S]*?cacheControl: false,[\s\S]*?etag: false,[\s\S]*?lastModified: false,[\s\S]*?setHeaders: setPrivateNoStoreCacheControl/
  );
});

test("the HTTP reproduction demonstrates legacy cross-user disclosure and fixed isolation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/reproduce-authenticated-cache-isolation.mjs"],
    { cwd: rootDir, encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.crossUserDisclosure, true);
  assert.equal(result.vulnerable.secondRequestCacheStatus, "HIT");
  assert.equal(result.fixed.crossUserDisclosure, false);
  assert.equal(result.fixed.secondRequestCacheStatus, "MISS");
  assert.equal(result.fixed.cacheControl, privateNoStoreCacheControl);
});
