import { performance } from "node:perf_hooks";

const trackedIps = 4_096;
const rejectedNewIps = 20_000;
const windowMs = 60_000;
const limit = 30;
const now = 1_000_000;

function seededMap() {
  const windows = new Map();
  for (let index = 0; index < trackedIps; index += 1) {
    windows.set(`10.0.${Math.floor(index / 256)}.${index % 256}`, {
      startedAt: now - 1_000,
      attempts: 1
    });
  }
  return windows;
}

function consumeLegacy(windows, sourceIp) {
  const existing = windows.get(sourceIp);
  if (existing && now - existing.startedAt < windowMs) {
    if (existing.attempts >= limit) return false;
    existing.attempts += 1;
    return true;
  }
  if (!existing && windows.size >= trackedIps) {
    for (const [ip, entry] of windows) {
      if (now - entry.startedAt >= windowMs) windows.delete(ip);
    }
    if (windows.size >= trackedIps) return false;
  }
  windows.set(sourceIp, { startedAt: now, attempts: 1 });
  return true;
}

function consumeOptimized(windows, sourceIp) {
  const existing = windows.get(sourceIp);
  if (existing && now - existing.startedAt < windowMs) {
    if (existing.attempts >= limit) return false;
    existing.attempts += 1;
    return true;
  }
  if (existing) windows.delete(sourceIp);
  while (windows.size >= trackedIps) {
    const oldest = windows.entries().next().value;
    if (!oldest) break;
    const [ip, entry] = oldest;
    if (now - entry.startedAt < windowMs) return false;
    windows.delete(ip);
  }
  windows.set(sourceIp, { startedAt: now, attempts: 1 });
  return true;
}

function measure(consume) {
  const windows = seededMap();
  let accepted = 0;
  const started = performance.now();
  for (let index = 0; index < rejectedNewIps; index += 1) {
    if (consume(windows, `203.0.${Math.floor(index / 256)}.${index % 256}`)) accepted += 1;
  }
  return {
    milliseconds: performance.now() - started,
    accepted,
    retainedEntries: windows.size
  };
}

measure(consumeLegacy);
measure(consumeOptimized);
const legacy = measure(consumeLegacy);
const optimized = measure(consumeOptimized);
if (legacy.accepted !== optimized.accepted || legacy.retainedEntries !== optimized.retainedEntries) {
  throw new Error("upgrade-budget behavior changed during CPU reproduction");
}

console.log(JSON.stringify({
  node: process.version,
  trackedIps,
  rejectedNewIps,
  legacy,
  optimized,
  speedup: legacy.milliseconds / optimized.milliseconds
}, null, 2));
