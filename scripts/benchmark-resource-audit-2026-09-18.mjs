// Run with the project's supported Node.js runtime. No project dependencies needed.
// node --experimental-transform-types --expose-gc scripts/benchmark-resource-audit-2026-09-18.mjs
// Reports isolated guard/lexer costs, NOT end-to-end HTTP throughput or resident memory.
import { performance } from "node:perf_hooks";
import { cpus } from "node:os";
import { cycle, reorder, lua, chain, multiParent } from "../tests/helpers/resource-audit-2026-09-18-harness.mjs";

const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
function compare(name, make, input, iterations = 10) {
  const oldFn = make(true), newFn = make(false);
  for (let i = 0; i < 5; i += 1) { oldFn(...input); newFn(...input); }
  const times = { before: [], after: [] }, cpu = { before: [], after: [] };
  for (let round = 0; round < 9; round += 1) {
    for (const [label, fn] of round % 2 ? [["after", newFn], ["before", oldFn]] : [["before", oldFn], ["after", newFn]]) {
      global.gc?.();
      const usage = process.cpuUsage(), start = performance.now();
      for (let i = 0; i < iterations; i += 1) fn(...input);
      times[label].push((performance.now() - start) / iterations);
      const used = process.cpuUsage(usage);
      cpu[label].push((used.user + used.system) / 1000 / iterations);
    }
  }
  const before = {}, after = {};
  make(true, before)(...input); make(false, after)(...input);
  const beforeMs = median(times.before), afterMs = median(times.after);
  return { name, iterationsPerSample: iterations, samples: 9,
    medianMsPerOperation: { before: beforeMs, after: afterMs },
    medianCpuMsPerOperation: { before: median(cpu.before), after: median(cpu.after) },
    elapsedReductionPercent: 100 * (1 - afterMs / beforeMs),
    operationCounts: { before, after }, rawElapsedMsPerOperation: times };
}
const { rows, items } = multiParent();
const flat = Array.from({ length: 500 }, (_, i) => ({ id: `f${i}`, parent_block_id: null, edit_version: 1 }));
const flatItems = flat.map((row, i) => ({ id: row.id, sortOrder: i, expectedVersion: 1 }));
const results = [
  compare("cycle: 2,000-node deep chain", cycle, [chain(2_000), []], 2),
  compare("reorder: 2,000 rows / 500 requested siblings across 500 parents", reorder, [rows, items], 5),
  compare("reorder: 500 flat rows / one parent", reorder, [flat, flatItems], 20),
  compare("Lua: 18,000 unstyled/HTML-special characters", (old, m) => lua(old, m).highlightLuaSource, [" & <> ".repeat(3_000)], 30),
  compare("Lua: representative Lua code", (old, m) => lua(old, m).highlightLuaSource, ['local sum = 0\nfor i = 1, 100 do\n  sum = sum + i\nend\nprint(sum) -- total\n'.repeat(140)], 20),
  compare("Lua: short Lua code", (old, m) => lua(old, m).highlightLuaSource, ['local x = 1\nreturn print(x), nil'], 1_000)
];
console.log(JSON.stringify({ node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
  gcExposed: Boolean(global.gc), method: "Uninstrumented alternating-order timings; independent instrumented counts. Input creation and source compilation excluded. No timing assertion in tests.", results }, null, 2));
