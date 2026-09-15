import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = (await readFile(new URL("../src/server.ts", import.meta.url), "utf8")).replace(/\r\n/g, "\n");
const cleanupStart = source.indexOf("  let dataTransferCleanupInFlight:");
const cleanupEnd = source.indexOf("  await initializePermanentTotpIpEnforcement();", cleanupStart);
assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart, "periodic cleanup guard is missing");
const cleanupSection = source.slice(cleanupStart, cleanupEnd);
assert.match(cleanupSection, /if \(dataTransferCleanupInFlight\) return;/);
assert.match(cleanupSection, /\.finally\(\(\) => \{ dataTransferCleanupInFlight = null; \}\);/);

function simulate({ ticks, durationTicks, guarded }) {
  const activeUntil = [];
  let started = 0;
  let maxConcurrent = 0;
  for (let tick = 0; tick < ticks; tick += 1) {
    for (let index = activeUntil.length - 1; index >= 0; index -= 1) {
      if (activeUntil[index] <= tick) activeUntil.splice(index, 1);
    }
    if (!guarded || activeUntil.length === 0) {
      activeUntil.push(tick + durationTicks);
      started += 1;
    }
    maxConcurrent = Math.max(maxConcurrent, activeUntil.length);
  }
  return { started, maxConcurrent, activeAtEnd: activeUntil.length };
}

const scenario = {
  description: "30 one-minute timer ticks with each filesystem cleanup taking five minutes",
  legacy: simulate({ ticks: 30, durationTicks: 5, guarded: false }),
  guarded: simulate({ ticks: 30, durationTicks: 5, guarded: true })
};

assert.equal(scenario.legacy.maxConcurrent, 5);
assert.equal(scenario.guarded.maxConcurrent, 1);
console.log(JSON.stringify(scenario, null, 2));
