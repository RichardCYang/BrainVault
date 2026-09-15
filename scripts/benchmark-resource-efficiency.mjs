// Run: node --expose-gc scripts/benchmark-resource-efficiency.mjs > results.json
// Uses exact pre-fix excerpts and current source, not a simulated algorithm.
// Timings are descriptive, not portable CI thresholds. Run on an otherwise idle host.
import { performance } from "node:perf_hooks";
import { createHash } from "node:crypto";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import {
  baseline, currentSources, makeAppHarness, makeDraftNormalizer, makeHistoryFactory, makeBlocks, makeOrder
} from "../tests/helpers/resource-efficiency-harness.mjs";

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const round = value => Number(value.toFixed(3));
function measure(run, samples = 7) {
  for (let i = 0; i < 2; i += 1) run();
  const timings = [], cpu = [];
  for (let i = 0; i < samples; i += 1) {
    globalThis.gc?.();
    const startedCpu = process.cpuUsage(); const started = performance.now();
    run();
    timings.push(performance.now() - started);
    const elapsedCpu = process.cpuUsage(startedCpu); cpu.push((elapsedCpu.user + elapsedCpu.system) / 1000);
  }
  return { samples, medianWallMs: round(median(timings)), medianCpuMs: round(median(cpu)), allWallMs: timings.map(round) };
}
function makeHistoryPayload(index, revision) {
  return { markdown: `block ${index} revision ${revision}`, metadata: { rows: Array.from({ length: 200 }, (_, row) => ({ id: `${index}-${row}`, label: `value-${row}-` + "내용abcdef".repeat(10), checked: row % 2 === 0 })) } };
}
if (process.argv[2] === "--memory-child") {
  if (!globalThis.gc) throw new Error("Memory child requires --expose-gc");
  const mode = process.argv[3]; const create = makeHistoryFactory(mode);
  // Warm the module before measuring the retained history; collect the same way
  // for both modes. The history and input-generation workload are identical.
  const warm = create(); warm.seed("warm", "key", makeHistoryPayload(0, 0)); warm.clear();
  globalThis.gc(); globalThis.gc();
  const start = process.memoryUsage();
  const history = create();
  for (let i = 0; i < 48; i += 1) {
    history.seed("page", `block-${i}`, makeHistoryPayload(i, 0));
    history.record({ pageId: "page", key: `block-${i}`, value: makeHistoryPayload(i, 1), coalesce: false, now: i });
  }
  globalThis.gc(); globalThis.gc();
  const retained = process.memoryUsage(); const historyState = history.getState("page");
  let sample = history.peek("page", "undo"); assert.equal(sample.after.metadata.rows.length, 200);
  sample = null; // Do not keep the defensive peek clone alive during the clear check.
  history.clear(); globalThis.gc(); globalThis.gc();
  const cleared = process.memoryUsage();
  console.log(JSON.stringify({ mode, historyState, retainedHeapDeltaBytes: retained.heapUsed - start.heapUsed, heapAfterClearDeltaBytes: cleared.heapUsed - start.heapUsed, rssBytes: retained.rss, externalBytes: retained.external }));
  process.exit(0);
}
const results = {
  schemaVersion: 1, generatedAt: new Date().toISOString(), originalArchiveSha256: baseline.originalArchiveSha256,
  environment: { node: process.version, v8: process.versions.v8, platform: process.platform, arch: process.arch, exposedGc: !!globalThis.gc, cpuModel: os.cpus()[0]?.model, logicalCpus: os.cpus().length, hostMemoryBytes: os.totalmem() },
  sourceTextSha256: Object.fromEntries(Object.entries(currentSources).map(([name, text]) => [name, createHash("sha256").update(text).digest("hex")])),
  scope: "CPU/heap microbenchmarks of real changed functions; not a server, database, or whole-app load test.",
  collaborationTree: [], localSnapshots: [], recoveryOrder: [], historyClones: [], historyEditCpu: [], historyRetainedHeap: []
};
for (const count of [1000, 3000, 6000]) {
  const { roots, flat } = makeBlocks(count);
  const byMode = {};
  for (const mode of ["baseline", "current"]) {
    const h = makeAppHarness(mode); h.state.selectedPage = { blocks: roots };
    const cost = measure(() => { const out = h.build(flat); assert.equal(out.length, count); });
    const counted = makeAppHarness(mode, { instrument: true }); counted.state.selectedPage = { blocks: roots };
    const output = counted.build(flat);
    byMode[mode] = output;
    results.collaborationTree.push({ mode, blocks: count, ...cost, ...counted.metrics });
  }
  assert.deepEqual(byMode.current, byMode.baseline);
}
for (const mode of ["baseline", "current"]) {
  const count = 2500; const fixture = makeBlocks(count);
  fixture.flat.forEach((b, i) => { b.markdown = `row ${i} ` + "x".repeat(1024); });
  // Measure complete local apply (including rebuilding and normal state updates).
  const h = makeAppHarness(mode); h.state.selectedPage = { id: "page", title: "Title", blocks: fixture.roots };
  const snapshot = { title: "Title", blocks: fixture.flat };
  const cost = measure(() => { h.events.length = 0; h.apply(snapshot, { source: "local" }); });
  const counted = makeAppHarness(mode, { instrument: true }); counted.state.selectedPage = { id: "page", blocks: fixture.roots };
  counted.apply(snapshot, { source: "local" });
  results.localSnapshots.push({ mode, blocks: count, ...cost, signatureCalls: counted.metrics.signatureCalls });
}
for (const count of [1000, 5000, 10000]) {
  const order = makeOrder(count); const outputs = {};
  for (const mode of ["baseline", "current"]) {
    const h = makeDraftNormalizer(mode);
    const cost = measure(() => { assert.ok(h.normalize(order)); });
    const counted = makeDraftNormalizer(mode, { instrument: true }); outputs[mode] = counted.normalize(order);
    results.recoveryOrder.push({ mode, ids: count, ...cost, ...counted.metrics });
  }
  assert.deepEqual(outputs.current, outputs.baseline);
}
for (const mode of ["baseline", "current"]) {
  let calls = 0, clonedJsonCodeUnits = 0;
  const createCounted = makeHistoryFactory(mode, { clone: value => { calls += 1; clonedJsonCodeUnits += (JSON.stringify(value) ?? "").length; return structuredClone(value); } });
  const history = createCounted(); history.seed("p", "b", makeHistoryPayload(0, 0)); calls = 0; clonedJsonCodeUnits = 0;
  for (let i = 1; i <= 100; i += 1) history.record({ pageId: "p", key: "b", value: makeHistoryPayload(0, i), now: i });
  results.historyClones.push({ mode, records: 100, cloneCalls: calls, clonedJsonCodeUnits, state: history.getState("p") });
  const create = makeHistoryFactory(mode);
  const values = Array.from({ length: 101 }, (_, i) => makeHistoryPayload(0, i));
  results.historyEditCpu.push({ mode, records: 100, ...measure(() => {
    const h = create(); h.seed("p", "b", values[0]);
    for (let i = 1; i < values.length; i += 1) h.record({ pageId: "p", key: "b", value: values[i], now: i });
    assert.equal(h.getState("p").undoDepth, 1);
  }) });
}
for (const mode of ["baseline", "current"]) {
  const samples = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const run = spawnSync(process.execPath, ["--expose-gc", fileURLToPath(import.meta.url), "--memory-child", mode], { encoding: "utf8", timeout: 30_000 });
    if (run.status !== 0) throw new Error(`Heap benchmark failed: ${run.stderr}`);
    samples.push(JSON.parse(run.stdout));
  }
  results.historyRetainedHeap.push({ mode, independentProcesses: 5, medianRetainedHeapDeltaBytes: median(samples.map(x => x.retainedHeapDeltaBytes)), samples });
}
assert.deepEqual(results.historyClones[0].state, results.historyClones[1].state);
assert.deepEqual(results.historyRetainedHeap[0].samples[0].historyState, results.historyRetainedHeap[1].samples[0].historyState);
console.log(JSON.stringify(results, null, 2));
