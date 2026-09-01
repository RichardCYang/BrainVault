import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath) => readFileSync(join(rootDir, relativePath), "utf8").replace(/\r\n/g, "\n");

test("Mermaid executable code is same-origin and vendored from an integrity-pinned package", () => {
  const browser = read("public/mermaid-block.js");
  const app = read("src/app.ts");
  const vendor = read("scripts/vendor-mermaid.mjs");
  const pkg = JSON.parse(read("package.json"));

  assert.match(browser, /MERMAID_SCRIPT_URL = `\/vendor\/mermaid\/\$\{MERMAID_VERSION\}\/mermaid\.min\.js`/);
  assert.doesNotMatch(browser, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  assert.doesNotMatch(app, /cdn\.jsdelivr\.net\/npm\/mermaid/);
  assert.match(vendor, /MERMAID_PACKAGE_INTEGRITY/);
  assert.match(vendor, /sha512-V6K3C8EBdEsPFZXSKMJe6ppQOENxuHARr9GvHX4hh47lAbhMRD9qf4oEK7LoaRQxULMa80\/qt5gHO73aCleBBg==/);
  assert.match(vendor, /verifyPackageIntegrity\(tarball\)/);
  assert.match(vendor, /assertTarHeaderChecksum\(header\)/);
  assert.match(pkg.scripts.build, /^npm run vendor:mermaid && /);
});

test("the supported single-instance topology is enforced before network traffic is accepted", () => {
  const server = read("src/server.ts");
  const lease = read("src/lib/application-instance-lock.ts");
  const db = read("src/lib/db.ts");

  assert.match(lease, /SELECT GET_LOCK\(\?, 0\) AS acquired/);
  assert.match(lease, /SELECT RELEASE_LOCK\(\?\) AS released/);
  assert.match(lease, /Another BrainVault application instance is already active/);
  assert.match(lease, /application_instance_lease_heartbeat/);
  assert.match(lease, /options\.onLeaseLost\(error\)/);
  assert.match(server, /process\.kill\(process\.pid, "SIGTERM"\)/);
  assert.match(db, /export function createDedicatedDbConnection\(\)/);

  const acquireIndex = server.indexOf("applicationInstanceLease = await acquireApplicationInstanceLease({");
  const listenIndex = server.indexOf("server.listen(");
  assert.ok(acquireIndex >= 0 && listenIndex > acquireIndex);
  assert.ok(server.includes("await applicationInstanceLease?.release()"));
});

test("page-version reset verification follows the refactored locked authorization helper", () => {
  const verifier = read("scripts/verify-data-loss-guards.mjs");
  const pageAccess = read("src/lib/page-access.ts");

  assert.match(verifier, /getPageAccess\(pageId, user\.id, client, \{ lockPage: true \}\)/);
  assert.match(pageAccess, /WHERE id = \?\$\{lockPage \? " FOR UPDATE" : ""\}/);
  assert.doesNotMatch(verifier, /SELECT \* FROM pages WHERE id = \? AND owner_id = \? FOR UPDATE/);
});
