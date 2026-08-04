import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("the patched lockfile excludes vulnerable ip-address releases", () => {
  const packageJson = JSON.parse(read("package.json"));
  const packageLock = JSON.parse(read("package-lock.json"));
  const installed = packageLock.packages?.["node_modules/ip-address"];

  assert.equal(packageJson.overrides?.["ip-address"], "10.3.1");
  assert.equal(installed?.version, "10.3.1");
  assert.equal(installed?.resolved, "https://registry.npmjs.org/ip-address/-/ip-address-10.3.1.tgz");
  assert.equal(
    installed?.integrity,
    "sha512-1e9d3kb97NHJTIJDZW9rKqW2h6+dFa50Dy0fpPSMQp2ADje5gvKsXmdiK6dwY5t76TaTt5+P5N1Y/LoToIxP6g=="
  );
  assert.notEqual(installed?.version, "10.2.0");
});

test("the collaboration runtime is same-origin and the import map matches its CSP hash", () => {
  const appSource = read("src/app.ts");
  const collaborationSource = read("public/collaboration.js");
  const indexSource = read("public/index.html");
  const importMapMatch = indexSource.match(/<script type="importmap">([\s\S]*?)<\/script>/);

  assert.ok(importMapMatch, "index.html must include an import map");
  const importMap = JSON.parse(importMapMatch[1]);
  assert.deepEqual(importMap, {
    imports: {
      "lib0/": "/vendor/yjs/lib0/",
      "isomorphic.js": "/vendor/yjs/isomorphic/browser.mjs"
    }
  });

  const digest = createHash("sha256").update(importMapMatch[1], "utf8").digest("base64");
  assert.equal(digest, "AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE=");
  assert.ok(appSource.includes(`'sha256-${digest}'`));
  assert.ok(collaborationSource.includes('const YJS_MODULE_URL = "/vendor/yjs/yjs.mjs";'));
  assert.ok(appSource.includes('app.get("/vendor/yjs/yjs.mjs"'));
  assert.ok(appSource.includes('app.get("/vendor/yjs/isomorphic/browser.mjs"'));
  assert.ok(appSource.includes('"/vendor/yjs/lib0"'));
  assert.ok(!appSource.includes("https://cdn.jsdelivr.net/npm/yjs@"));
  assert.ok(!collaborationSource.includes("https://cdn.jsdelivr.net/npm/yjs@"));
});

test("the documented advisory hostname canonicalizes to the private IPv4 target", () => {
  const parsed = new URL("http://012.0.0.1/");
  assert.equal(parsed.hostname, "10.0.0.1");
});
