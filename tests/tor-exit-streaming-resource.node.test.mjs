import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const root = new URL("../", import.meta.url);
const torSourceUrl = new URL("src/lib/tor-exit-list.ts", root);
const torListMaxBytes = 4 * 1024 * 1024;

async function importTorExitModuleForBehaviorTest() {
  const geoCountryUrl = new URL("src/lib/geo-country.ts", root).href;
  const directory = await mkdtemp(join(tmpdir(), "brainvault-tor-exit-stream-test-"));
  const source = (await readFile(torSourceUrl, "utf8"))
    .replace('from "./geo-country.js"', `from ${JSON.stringify(geoCountryUrl)}`);
  const modulePath = join(directory, "tor-exit-list.ts");
  await writeFile(modulePath, source, "utf8");
  const module = await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
  return { module, cleanup: () => rm(directory, { recursive: true, force: true }) };
}

function responseFromChunks(chunks, { onCancel } = {}) {
  let index = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close();
        return;
      }
      controller.enqueue(chunks[index]);
      index += 1;
    },
    cancel() {
      onCancel?.();
    }
  }), { status: 200, headers: { "content-type": "text/plain" } });
}

test("Tor exit directory parsing is incremental instead of materializing the full body and line array", async () => {
  const [torSource, policySource] = await Promise.all([
    readFile(torSourceUrl, "utf8"),
    readFile(new URL("src/lib/vpn-access-policy.ts", root), "utf8")
  ]);

  assert.match(torSource, /const decoder = new TextDecoder\(\)/);
  assert.match(torSource, /totalBytes \+= value\.byteLength/);
  assert.match(torSource, /decoder\.decode\(value, \{ stream: true \}\)/);
  assert.doesNotMatch(torSource, /Buffer\.concat/);
  assert.doesNotMatch(torSource, /const chunks:/);
  assert.doesNotMatch(torSource, /\.split\(\/\\r\?\\n\//);
  assert.match(policySource, /return readTorExitAddresses\(response, torListMaxBytes\);/);
  assert.doesNotMatch(
    policySource,
    /const text = await fetchLimitedText\(torExitListEndpoint[\s\S]*?text\.split\(\/\\r\?\\n\//
  );
});

test("streaming Tor parser preserves chunk boundaries, CRLF, final unterminated lines, deduplication, and public-IP filtering", async () => {
  const { module, cleanup } = await importTorExitModuleForBehaviorTest();
  const encoder = new TextEncoder();
  const text = [
    "ExitNode ABCDEF0123456789",
    "Published 2026-09-14 10:50:21 한글",
    "LastStatus 2026-09-14 20:00:00",
    "ExitAddress 1.1.1.1 2026-09-14 20:28:15",
    "ExitAddress 192.168.1.9 2026-09-14 20:28:15",
    "ExitAddress 1.1.1.1 2026-09-14 20:29:15",
    "ExitAddress 8.8.8.8 2026-09-14 20:30:15"
  ].join("\r\n");
  const bytes = encoder.encode(text);
  const cuts = [1, 2, 7, 19, 37, 64, 93, 129, 167, bytes.length - 3, bytes.length];
  const chunks = [];
  let start = 0;
  for (const end of cuts) {
    if (end <= start) continue;
    chunks.push(bytes.slice(start, end));
    start = end;
  }

  try {
    const addresses = await module.readTorExitAddresses(responseFromChunks(chunks), torListMaxBytes);
    assert.deepEqual([...addresses].sort(), ["1.1.1.1", "8.8.8.8"]);
  } finally {
    await cleanup();
  }
});

test("streaming Tor parser rejects and cancels an oversized chunked body without publishing partial data", async () => {
  const { module, cleanup } = await importTorExitModuleForBehaviorTest();
  const encoder = new TextEncoder();
  const validPrefix = encoder.encode("ExitAddress 1.1.1.1 2026-09-14 20:28:15\n");
  const oneMiB = new Uint8Array(1024 * 1024);
  oneMiB.fill(65);
  let canceled = false;

  try {
    await assert.rejects(
      module.readTorExitAddresses(
        responseFromChunks([validPrefix, oneMiB, oneMiB, oneMiB, oneMiB, oneMiB], {
          onCancel: () => { canceled = true; }
        }),
        torListMaxBytes
      ),
      /configured size limit/
    );
    assert.equal(canceled, true);
  } finally {
    await cleanup();
  }
});

test("declared Tor bodies above the byte limit are rejected before body access", async () => {
  const { module, cleanup } = await importTorExitModuleForBehaviorTest();
  let bodyAccessed = false;
  const response = {
    headers: {
      get(name) {
        return String(name).toLowerCase() === "content-length" ? String(torListMaxBytes + 1) : null;
      }
    },
    get body() {
      bodyAccessed = true;
      throw new Error("body must not be read");
    }
  };

  try {
    await assert.rejects(module.readTorExitAddresses(response, torListMaxBytes), /configured size limit/);
    assert.equal(bodyAccessed, false);
  } finally {
    await cleanup();
  }
});
