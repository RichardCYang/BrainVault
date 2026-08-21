import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  assertSupportedNodeRuntime,
  isNodeRuntimeSupported,
  nodeRuntimeSecurityFloor
} from "../src/lib/runtime-security.ts";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("the runtime guard implements every declared Node.js security boundary", () => {
  assert.equal(nodeRuntimeSecurityFloor, "^22.23.2 || ^24.18.1 || >=26.5.1");

  for (const version of ["22.23.2", "22.99.99", "24.18.1", "24.99.99", "26.5.1", "27.0.0"]) {
    assert.equal(isNodeRuntimeSupported(version), true, `${version} should be accepted`);
  }

  for (const version of ["20.99.99", "22.23.1", "23.99.99", "24.18.0", "25.99.99", "26.5.0"]) {
    assert.equal(isNodeRuntimeSupported(version), false, `${version} should be rejected`);
  }
});

test("malformed and prerelease runtime versions fail closed", () => {
  for (const version of ["", "v22.23.2", "22", "22.23", "22.23.2-rc.1", "22.23.2 ", "999999999999999999999.0.0"]) {
    assert.equal(isNodeRuntimeSupported(version), false, `${JSON.stringify(version)} should be rejected`);
  }

  assert.doesNotThrow(() => assertSupportedNodeRuntime("22.23.2"));
  assert.throws(
    () => assertSupportedNodeRuntime("22.16.0"),
    (error) => error instanceof Error
      && error.message.includes("22.16.0")
      && error.message.includes(nodeRuntimeSecurityFloor)
      && error.message.includes("Refusing to start")
  );
});

test("the server enforces the runtime guard before security-sensitive startup operations", async () => {
  const source = await read("src/server.ts");
  const guardIndex = source.indexOf("assertSupportedNodeRuntime();");

  assert.match(source, /import \{ assertSupportedNodeRuntime \} from "\.\/lib\/runtime-security\.js";/);
  assert.ok(guardIndex >= 0, "The server entrypoint must call the runtime guard");
  for (const operation of ["await loadPoshAcmeTls(", "await bootstrapDatabase(", "server.listen("]) {
    assert.ok(
      source.indexOf(operation) > guardIndex,
      `${operation} must remain after the runtime guard`
    );
  }
});

test("the standalone reproduction demonstrates the metadata gap and the fail-closed remediation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [
      "--import=tsx",
      fileURLToPath(new URL("../scripts/reproduce-runtime-security-floor.mjs", import.meta.url))
    ],
    { encoding: "utf8" }
  ));

  assert.equal(result.baselineReproduction.impossibleEngineRange, ">=999.0.0");
  assert.equal(result.baselineReproduction.engineStrictEnabled, true);
  assert.equal(result.baselineReproduction.entrypointRan, true);
  assert.equal(result.fixedRuntimeGuard.declaredRange, nodeRuntimeSecurityFloor);
  assert.equal(result.fixedRuntimeGuard.knownPreFloorRuntimeSupported, false);
  assert.equal(result.fixedRuntimeGuard.rejectedPreFloorRuntime.accepted, false);
  assert.equal(result.startupWiring.guardRunsBeforeStartupOperations, true);
});
