import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const workerMode = process.argv[2] ?? "";
const targetBytes = 4 * 1024 * 1024 - 256;
const chunkSize = 16 * 1024;
const sampleRuns = 5;

function createInput() {
  const record = [
    "ExitNode ABCDEF0123456789",
    "Published 2026-09-14 10:50:21",
    "LastStatus 2026-09-14 20:00:00",
    "ExitAddress 1.1.1.1 2026-09-14 20:28:15"
  ].join("\n") + "\n";
  let text = record.repeat(Math.ceil(targetBytes / Buffer.byteLength(record)));
  text = text.slice(0, targetBytes);
  const bytes = new TextEncoder().encode(text);
  const chunks = [];
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    chunks.push(bytes.slice(offset, Math.min(offset + chunkSize, bytes.byteLength)));
  }
  return { bytes, chunks };
}

function addExitAddress(line, addresses) {
  if (!line.startsWith("ExitAddress ")) return;
  const rawIp = line.split(/\s+/)[1] ?? "";
  if (rawIp) addresses.add(rawIp);
}

function sample(peak) {
  const memory = process.memoryUsage();
  peak.rss = Math.max(peak.rss, memory.rss);
  peak.heapUsed = Math.max(peak.heapUsed, memory.heapUsed);
}

function runWorker(mode) {
  const { bytes, chunks } = createInput();
  global.gc?.();
  const baseline = process.memoryUsage();
  const peak = { rss: baseline.rss, heapUsed: baseline.heapUsed };
  let addresses;

  if (mode === "legacy") {
    const retainedChunks = [];
    let totalBytes = 0;
    for (const value of chunks) {
      totalBytes += value.byteLength;
      retainedChunks.push(value);
    }
    sample(peak);
    const body = Buffer.concat(retainedChunks, totalBytes);
    sample(peak);
    const text = body.toString("utf8");
    sample(peak);
    const lines = text.split(/\r?\n/);
    sample(peak);
    addresses = new Set();
    for (const line of lines) addExitAddress(line, addresses);
    sample(peak);
  } else if (mode === "streaming") {
    const decoder = new TextDecoder();
    addresses = new Set();
    let pendingText = "";
    for (const value of chunks) {
      const text = pendingText + decoder.decode(value, { stream: true });
      let lineStart = 0;
      while (true) {
        const newlineIndex = text.indexOf("\n", lineStart);
        if (newlineIndex < 0) break;
        const lineEnd = newlineIndex > lineStart && text.charCodeAt(newlineIndex - 1) === 13
          ? newlineIndex - 1
          : newlineIndex;
        addExitAddress(text.slice(lineStart, lineEnd), addresses);
        lineStart = newlineIndex + 1;
      }
      pendingText = text.slice(lineStart);
      sample(peak);
    }
    const finalText = pendingText + decoder.decode();
    if (finalText) addExitAddress(finalText, addresses);
    sample(peak);
  } else {
    throw new Error(`Unknown worker mode: ${mode}`);
  }

  return {
    mode,
    inputBytes: bytes.byteLength,
    chunks: chunks.length,
    addresses: addresses.size,
    baselineRss: baseline.rss,
    peakRss: peak.rss,
    peakRssDelta: peak.rss - baseline.rss,
    baselineHeapUsed: baseline.heapUsed,
    peakHeapUsed: peak.heapUsed,
    peakHeapDelta: peak.heapUsed - baseline.heapUsed
  };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function summarize(results) {
  return {
    peakRss: median(results.map((item) => item.peakRss)),
    peakRssDelta: median(results.map((item) => item.peakRssDelta)),
    peakHeapUsed: median(results.map((item) => item.peakHeapUsed)),
    peakHeapDelta: median(results.map((item) => item.peakHeapDelta))
  };
}

if (workerMode) {
  console.log(JSON.stringify(runWorker(workerMode)));
} else {
  const scriptPath = fileURLToPath(import.meta.url);
  const results = { legacy: [], streaming: [] };
  for (const mode of Object.keys(results)) {
    for (let run = 0; run < sampleRuns; run += 1) {
      const child = spawnSync(process.execPath, ["--expose-gc", scriptPath, mode], {
        encoding: "utf8",
        maxBuffer: 1024 * 1024
      });
      if (child.status !== 0) {
        process.stderr.write(child.stderr || child.stdout);
        process.exit(child.status ?? 1);
      }
      results[mode].push(JSON.parse(child.stdout.trim()));
    }
  }

  const legacy = summarize(results.legacy);
  const streaming = summarize(results.streaming);
  const percentage = (before, after) => Number((((before - after) / before) * 100).toFixed(2));
  console.log(JSON.stringify({
    inputBytes: results.legacy[0].inputBytes,
    chunks: results.legacy[0].chunks,
    runsPerMode: sampleRuns,
    legacy,
    streaming,
    reductionPercent: {
      peakRss: percentage(legacy.peakRss, streaming.peakRss),
      peakRssDelta: percentage(legacy.peakRssDelta, streaming.peakRssDelta),
      peakHeapUsed: percentage(legacy.peakHeapUsed, streaming.peakHeapUsed),
      peakHeapDelta: percentage(legacy.peakHeapDelta, streaming.peakHeapDelta)
    }
  }, null, 2));
}
