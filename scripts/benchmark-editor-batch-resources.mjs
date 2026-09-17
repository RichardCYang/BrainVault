// Run: node --expose-gc scripts/benchmark-editor-batch-resources.mjs
// Original snippets are from the uploaded archive. Timings are advisory;
// operation-count regressions live in tests/editor-batch-resource.node.test.mjs.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { makeApp, makeBlocks, makeRow, makeCaret, makeControls } from '../tests/helpers/editor-batch-resource-harness.mjs';

const sizes = [100, 1000, 2000];
const samples = 9;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function benchmarkPair(before, after) {
  for (let i = 0; i < 5; i++) { before(); after(); }
  const results = [[], []], cpu = [[], []];
  for (let i = 0; i < samples; i++) for (const index of i % 2 ? [1, 0] : [0, 1]) {
    globalThis.gc?.();
    const startCpu = process.cpuUsage(), start = performance.now();
    (index ? after : before)();
    results[index].push(performance.now() - start);
    const delta = process.cpuUsage(startCpu);
    cpu[index].push((delta.user + delta.system) / 1000);
  }
  return { baselineMedianMs: median(results[0]), fixedMedianMs: median(results[1]),
    baselineMedianCpuMs: median(cpu[0]), fixedMedianCpuMs: median(cpu[1]),
    baselineSamplesMs: results[0], fixedSamplesMs: results[1] };
}
const rows = [];
for (const count of sizes) {
  for (const operation of ['reorder', 'keepalive']) {
    const apps = ['baseline', 'current'].map(mode => makeApp(mode));
    const fixture = makeBlocks(count); const ids = [...fixture.ids].reverse();
    const saveRows = new Map(fixture.ids.map(id => [id, makeRow(id)]));
    for (const app of apps) app.state.selectedPage.blocks = fixture.roots;
    const actions = apps.map(app => operation === 'reorder' ? () => app.task(null, ids)
      : () => app.bytes({ saveTitle: true, rowsToSave: saveRows }));
    assert.deepEqual(actions[1](), actions[0]());
    const timing = benchmarkPair(...actions);
    const counts = ['baseline', 'current'].map(mode => {
      const app = makeApp(mode, { instrument: true });
      const f = makeBlocks(count, { metrics: app.metrics }); app.state.selectedPage.blocks = f.roots;
      app.resetMetrics();
      if (operation === 'reorder') app.task(null, ids);
      else app.bytes({ saveTitle: true, rowsToSave: saveRows });
      return { ...app.metrics };
    });
    rows.push({ operation, count, ...timing, baselineOperations: counts[0], fixedOperations: counts[1] });
  }
}
{
  const fixture = makeControls(1000), apis = ['baseline', 'current'].map(makeCaret);
  const actions = apis.map(api => () => {
    for (let i = 0; i < 1000; i++) { api.key(fixture.controls[0], fixture.row); api.byKey(fixture.row, 'text:0'); }
  });
  const timing = benchmarkPair(...actions);
  const counts = ['baseline', 'current'].map(mode => {
    const metrics = { selectionReads: 0, queries: 0 }, f = makeControls(1000, { metrics }), api = makeCaret(mode);
    api.key(f.controls[0], f.row); api.byKey(f.row, 'text:0'); return metrics;
  });
  rows.push({ operation: 'caret-1000-roundtrips', controls: 1000, ...timing,
    baselineOperationsPerRoundtrip: counts[0], fixedOperationsPerRoundtrip: counts[1] });
}
console.log(JSON.stringify({ node: process.version, platform: process.platform, samples,
  gcBeforeSamples: typeof globalThis.gc === 'function', rows,
  note: 'Synthetic component benchmarks, not production CPU/RSS percentages. Operation counts are deterministic; timings vary by machine.'
}, null, 2));
