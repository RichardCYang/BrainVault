import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSupportedNodeRuntime,
  isNodeRuntimeSupported,
  nodeRuntimeSecurityFloor
} from "../src/lib/runtime-security.ts";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const packageJson = JSON.parse(await readFile(join(rootDir, "package.json"), "utf8"));
const serverSource = (await readFile(join(rootDir, "src/server.ts"), "utf8")).replace(/\r\n/g, "\n");

const temporaryProject = await mkdtemp(join(tmpdir(), "brainvault-runtime-floor-"));
let directNodeProbe;
try {
  const impossibleEngineRange = ">=999.0.0";
  const probeFile = join(temporaryProject, "probe.mjs");
  await writeFile(
    join(temporaryProject, "package.json"),
    `${JSON.stringify({ type: "module", engines: { node: impossibleEngineRange } }, null, 2)}\n`,
    "utf8"
  );
  await writeFile(join(temporaryProject, ".npmrc"), "engine-strict=true\n", "utf8");
  await writeFile(probeFile, 'process.stdout.write("entrypoint-ran");\n', "utf8");

  const probe = spawnSync(process.execPath, [probeFile], {
    cwd: temporaryProject,
    encoding: "utf8"
  });
  directNodeProbe = {
    impossibleEngineRange,
    engineStrictEnabled: true,
    exitStatus: probe.status,
    stdout: probe.stdout,
    stderr: probe.stderr,
    entrypointRan: probe.status === 0 && probe.stdout === "entrypoint-ran"
  };
} finally {
  await rm(temporaryProject, { recursive: true, force: true });
}

function captureGuard(version) {
  try {
    assertSupportedNodeRuntime(version);
    return { accepted: true, error: null };
  } catch (error) {
    return {
      accepted: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

const guardCallIndex = serverSource.indexOf("assertSupportedNodeRuntime();");
const startupOperationIndexes = {
  tlsLoad: serverSource.indexOf("await loadPoshAcmeTls("),
  databaseBootstrap: serverSource.indexOf("await bootstrapDatabase("),
  listenerStart: serverSource.indexOf("server.listen(")
};
const guardRunsBeforeStartupOperations = guardCallIndex >= 0
  && Object.values(startupOperationIndexes).every((index) => index > guardCallIndex);

const knownPreFloorRuntime = "22.16.0";
const rejectedPreFloorRuntime = captureGuard(knownPreFloorRuntime);
const result = {
  baselineReproduction: {
    explanation: "Direct Node.js execution does not evaluate package.json engines or .npmrc engine-strict.",
    ...directNodeProbe
  },
  fixedRuntimeGuard: {
    declaredRange: packageJson.engines?.node,
    guardRange: nodeRuntimeSecurityFloor,
    knownPreFloorRuntime,
    knownPreFloorRuntimeSupported: isNodeRuntimeSupported(knownPreFloorRuntime),
    rejectedPreFloorRuntime,
    acceptsNode22Floor: captureGuard("22.23.2").accepted,
    acceptsNode24Floor: captureGuard("24.18.1").accepted,
    acceptsNode26Floor: captureGuard("26.5.1").accepted
  },
  startupWiring: {
    guardCallIndex,
    startupOperationIndexes,
    guardRunsBeforeStartupOperations
  }
};

const passed = directNodeProbe.entrypointRan
  && packageJson.engines?.node === nodeRuntimeSecurityFloor
  && rejectedPreFloorRuntime.accepted === false
  && result.fixedRuntimeGuard.acceptsNode22Floor
  && result.fixedRuntimeGuard.acceptsNode24Floor
  && result.fixedRuntimeGuard.acceptsNode26Floor
  && guardRunsBeforeStartupOperations;

console.log(JSON.stringify(result, null, 2));
if (!passed) {
  throw new Error("Runtime security-floor reproduction or remediation verification failed.");
}
