import { performance } from "node:perf_hooks";
import { hasRemotePresenceDecorationChanges } from "../public/collaboration-caret.js";

const blockCount = 4_000;
const updateCount = 2_400;
const remoteCount = 4;
const blockMoveEvery = 240;
const samples = 7;

const users = Array.from({ length: remoteCount }, (_, index) => ({
  id: `user-${index}`,
  username: `user${index}`,
  name: `User ${index}`,
  avatarData: index % 2 ? null : `data:image/png;base64,avatar-${index}`
}));

const basePresence = users.map((user, index) => ({
  connectionId: `connection-${index}`,
  user,
  state: {
    blockId: `block-${index + 1}`,
    field: "markdown",
    control: "text:0",
    selection: { anchor: 0, head: 0 }
  }
}));

function nextPresence(previous, updateIndex) {
  const next = previous.map((client) => ({ ...client, state: { ...client.state } }));
  const active = next[updateIndex % next.length];
  const offset = updateIndex % 500;
  active.state.selection = { anchor: offset, head: offset };
  active.state.control = `text:${updateIndex % 3}`;
  active.state.field = updateIndex % 5 === 0 ? "table" : "markdown";
  if (updateIndex > 0 && updateIndex % blockMoveEvery === 0) {
    active.state.blockId = `block-${(updateIndex / blockMoveEvery) % 32 + 1}`;
  }
  return next;
}

function decorationSignature(presence) {
  return presence.map((client) => [
    client.connectionId,
    client.user?.id ?? null,
    client.user?.username ?? null,
    client.user?.name ?? null,
    client.user?.avatarData ?? null,
    client.state?.blockId ?? null
  ]);
}

function simulateFullPresenceRender(presence) {
  // Mirrors the old scaling shape: every awareness update scanned every rendered
  // block row to clear labels/styles before rebuilding the few rows in use.
  let checksum = 0;
  for (let row = 0; row < blockCount; row += 1) {
    const blockId = `block-${row + 1}`;
    for (const client of presence) {
      if (client.state?.blockId === blockId) checksum += row + client.connectionId.length;
    }
    checksum += row & 1;
  }
  for (const client of presence) {
    checksum += client.connectionId.length + (client.user?.name?.length ?? 0);
  }
  return checksum;
}

const updates = [];
let current = basePresence;
for (let index = 0; index < updateCount; index += 1) {
  current = nextPresence(current, index);
  updates.push(current);
}

let cachedSignature = decorationSignature(basePresence);
let semanticChanges = 0;
let previous = basePresence;
for (const presence of updates) {
  if (hasRemotePresenceDecorationChanges(previous, presence)) {
    cachedSignature = decorationSignature(presence);
    semanticChanges += 1;
  }
  const direct = decorationSignature(presence);
  if (JSON.stringify(cachedSignature) !== JSON.stringify(direct)) {
    throw new Error("optimized presence decision skipped a visible decoration change");
  }
  previous = presence;
}

function runOld() {
  let checksum = simulateFullPresenceRender(basePresence);
  for (const presence of updates) checksum ^= simulateFullPresenceRender(presence);
  return checksum;
}

function runOptimized() {
  let checksum = simulateFullPresenceRender(basePresence);
  let previousPresence = basePresence;
  let fullRenders = 1;
  for (const presence of updates) {
    if (hasRemotePresenceDecorationChanges(previousPresence, presence)) {
      checksum ^= simulateFullPresenceRender(presence);
      fullRenders += 1;
    }
    previousPresence = presence;
  }
  return { checksum, fullRenders };
}

function measure(fn) {
  const values = [];
  let result;
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    result = fn();
    values.push(performance.now() - started);
  }
  values.sort((a, b) => a - b);
  return { medianMs: values[Math.floor(values.length / 2)], minMs: values[0], maxMs: values.at(-1), result };
}

// Warm up JIT paths before timed samples.
runOld();
runOptimized();
const oldResult = measure(runOld);
const optimizedResult = measure(runOptimized);
const expectedOptimizedRenders = semanticChanges + 1;
if (optimizedResult.result.fullRenders !== expectedOptimizedRenders) {
  throw new Error(`unexpected optimized render count: ${optimizedResult.result.fullRenders} !== ${expectedOptimizedRenders}`);
}

console.log(JSON.stringify({
  node: process.version,
  blockCount,
  updateCount,
  remoteCount,
  blockMoveEvery,
  samples,
  semanticDecorationChanges: semanticChanges,
  oldFullRenders: updateCount + 1,
  optimizedFullRenders: optimizedResult.result.fullRenders,
  avoidedFullRenders: (updateCount + 1) - optimizedResult.result.fullRenders,
  avoidedFullRenderPercent: ((updateCount + 1) - optimizedResult.result.fullRenders) / (updateCount + 1) * 100,
  oldMedianMs: oldResult.medianMs,
  optimizedMedianMs: optimizedResult.medianMs,
  speedup: oldResult.medianMs / optimizedResult.medianMs
}, null, 2));
