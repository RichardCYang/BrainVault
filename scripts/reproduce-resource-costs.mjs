// Reproducible, dependency-free comparison with the byte-hashed uploaded source.
// Run: node --expose-gc scripts/reproduce-resource-costs.mjs --output /tmp/costs.json
// Measurements are isolated workloads, not whole-application speedup estimates.
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";
import {
  baseline, sourceFor, loadModule, databaseFixture, freeze, countSortWork,
  makeStorage, countStorageWork
} from "../tests/helpers/resource-cost-harness.mjs";

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--output")) {
  throw new Error("Usage: node --expose-gc scripts/reproduce-resource-costs.mjs [--output file.json]");
}
const modules = {};
for (const mode of ["baseline", "current"]) {
  modules[mode] = { zip: await loadModule("src/lib/zip.ts", mode),
    database: await loadModule("src/lib/database.ts", mode),
    storage: await loadModule("public/storage-snapshot.js", mode) };
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
let sink;
function sample(run) {
  const usage = process.cpuUsage();
  const start = performance.now();
  sink = run();
  const wallMs = performance.now() - start;
  const cpu = process.cpuUsage(usage);
  return { wallMs, cpuMs: (cpu.user + cpu.system) / 1000 };
}
function measurePair(runs, repetitions = 7) {
  for (const mode of ["baseline", "current"]) { runs[mode](); runs[mode](); }
  const samples = { baseline: [], current: [] };
  for (let index = 0; index < repetitions; index += 1) {
    for (const mode of index % 2 ? ["current", "baseline"] : ["baseline", "current"]) {
      globalThis.gc?.();
      samples[mode].push(sample(runs[mode]));
    }
  }
  const summaries = Object.fromEntries(Object.entries(samples).map(([mode, values]) => [mode, {
    medianWallMs: median(values.map(value => value.wallMs)),
    medianCpuMs: median(values.map(value => value.cpuMs))
  }]));
  return { ...summaries, samples,
    cpuReductionPercent: (1 - summaries.current.medianCpuMs / summaries.baseline.medianCpuMs) * 100,
    wallSpeedup: summaries.baseline.medianWallMs / summaries.current.medianWallMs };
}

const bytes = Buffer.alloc(8 * 1024 * 1024);
for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
const crcRuns = Object.fromEntries(Object.entries(modules).map(([mode, { zip }]) => [mode, () => {
  let value = 0;
  for (let repeat = 0; repeat < 8; repeat += 1) {
    for (let offset = 0; offset < bytes.length; offset += 64 * 1024) value = zip.updateCrc32(value, bytes.subarray(offset, offset + 64 * 1024));
  }
  return value;
}]));
assert.equal(crcRuns.current(), crcRuns.baseline());
const crc = { workload: "64 MiB CRC32, 1,024 chunks of 64 KiB", checksum: crcRuns.current(), ...measurePair(crcRuns) };

const data = freeze(databaseFixture());
const databaseRuns = Object.fromEntries(Object.entries(modules).map(([mode, { database }]) => [mode, () => {
  let result;
  for (let repeat = 0; repeat < 40; repeat += 1) result = database.applyDatabaseView(data);
  return result;
}]));
assert.deepEqual(databaseRuns.current(), databaseRuns.baseline());
const database = { workload: "40 sorts of a valid 200-row database block", ...measurePair(databaseRuns) };
database.operationCountsPerSort = Object.fromEntries(Object.entries(modules).map(([mode, { database }]) => {
  const { value, ...counts } = countSortWork(() => database.applyDatabaseView(data));
  return [mode, counts];
}));

const keys = Array.from({ length: 5000 }, (_, index) => `brainvault:${index}:` + "x".repeat(120));
const storageRuns = Object.fromEntries(Object.entries(modules).map(([mode, { storage }]) => [mode, () => {
  let result;
  for (let repeat = 0; repeat < 10; repeat += 1) result = storage.inspectStorageKeys(makeStorage(keys));
  return result;
}]));
assert.deepEqual(storageRuns.current(), storageRuns.baseline());
const storage = { workload: "10 stable inspections of 5,000 keys (135-character average, three passes)", ...measurePair(storageRuns) };
storage.allocationCountsPerInspection = Object.fromEntries(Object.entries(modules).map(([mode, { storage }]) => {
  const { value, ...counts } = countStorageWork(() => storage.inspectStorageKeys(makeStorage(keys)));
  return [mode, counts];
}));
if (typeof globalThis.gc === "function") {
  storage.heapObservations = {};
  for (const mode of ["baseline", "current"]) {
    const values = [];
    for (let repeat = 0; repeat < 9; repeat += 1) {
      sink = null;
      globalThis.gc();
      const before = process.memoryUsage().heapUsed;
      sink = modules[mode].storage.inspectStorageKeys(makeStorage(keys));
      values.push(process.memoryUsage().heapUsed - before);
    }
    storage.heapObservations[mode] = { medianImmediateHeapDeltaBytes: median(values), samples: values };
  }
  storage.heapObservationCaveat = "Immediate post-call V8 heap differences, not retained memory/leak measurements; garbage collection and representation affect these values.";
}
const report = {
  schemaVersion: 1,
  environment: { node: process.version, v8: process.versions.v8, icu: process.versions.icu, platform: process.platform, arch: process.arch,
    cpu: cpus()[0]?.model, gcExposed: typeof globalThis.gc === "function" },
  scope: "Complete native ESM production modules. Synthetic but valid bounded workloads; no MariaDB/HTTP/full-app throughput claim. Timings are diagnostics, not flaky CI thresholds.",
  sourceHashes: Object.fromEntries(Object.entries(baseline.files).map(([file, record]) => [file, {
    baseline: record.sha256, current: createHash("sha256").update(sourceFor(file)).digest("hex")
  }])),
  crc, database, storage
};
assert.ok(sink !== undefined);
const output = JSON.stringify(report, null, 2) + "\n";
if (args[1]) writeFileSync(args[1], output);
process.stdout.write(output);
