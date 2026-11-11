import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const root = new URL("../", import.meta.url);
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
  }), { status: 200, headers: { "content-type": "text/csv" } });
}

test("country batch JSON decoding remains correct when Uint8Array chunks are retained without copying", async () => {
  const originalFetch = globalThis.fetch;
  const geoCountryUrl = new URL(`src/lib/geo-country.ts?test=${Date.now()}-${Math.random()}`, root);
  const geoCountry = await import(geoCountryUrl.href);
  const bytes = new TextEncoder().encode('[{"ip":"1.1.1.1","country":"US"}]');
  globalThis.fetch = async () => responseFromChunks([bytes.slice(0, 7), bytes.slice(7, 19), bytes.slice(19)]);
  try {
    const result = await geoCountry.lookupCountryCodes(["1.1.1.1"]);
    assert.equal(result.get("1.1.1.1"), "US");
  } finally {
    globalThis.fetch = originalFetch;
    geoCountry.resetCountryInfoCacheForTests();
  }
});

