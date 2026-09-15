import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const serverUrl = new URL("../src/server.ts", import.meta.url);

function simulatePeriodicCleanup({ ticks, durationTicks, guarded }) {
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

  return { started, maxConcurrent };
}

test("periodic data-transfer cleanup cannot overlap itself on slow storage", async () => {
  const source = (await readFile(serverUrl, "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("  let dataTransferCleanupInFlight:");
  const end = source.indexOf("  await initializePermanentTotpIpEnforcement();", start);
  assert.ok(start >= 0 && end > start, "missing periodic cleanup source section");
  const section = source.slice(start, end);

  assert.match(section, /let dataTransferCleanupInFlight: Promise<unknown> \| null = null;/);
  assert.match(section, /if \(dataTransferCleanupInFlight\) return;/);
  assert.match(section, /dataTransferCleanupInFlight = cleanupStaleDataTransferTempFiles\(\)/);
  assert.match(section, /\.finally\(\(\) => \{ dataTransferCleanupInFlight = null; \}\);/);

  const legacy = simulatePeriodicCleanup({ ticks: 30, durationTicks: 5, guarded: false });
  const guarded = simulatePeriodicCleanup({ ticks: 30, durationTicks: 5, guarded: true });
  assert.deepEqual(legacy, { started: 30, maxConcurrent: 5 });
  assert.deepEqual(guarded, { started: 6, maxConcurrent: 1 });
});

test("server shutdown cancels both periodic housekeeping timers", async () => {
  const source = (await readFile(serverUrl, "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("  async function shutdown(signal: string)");
  const end = source.indexOf("  process.on(\"SIGINT\"", start);
  assert.ok(start >= 0 && end > start, "missing shutdown source section");
  const section = source.slice(start, end);

  assert.match(section, /clearInterval\(dataTransferCleanupTimer\);/);
  assert.match(section, /clearInterval\(sessionPruneTimer\);/);
});
