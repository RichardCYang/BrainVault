import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = readFileSync(new URL("../public/collaboration.js", import.meta.url), "utf8");
const start = source.indexOf("const unsafeCollaborationObjectKeys");
const end = source.indexOf("function flattenBlocks(", start);
assert.ok(start >= 0 && end > start);
// Minimal Yjs value interfaces isolate the JavaScript property-write behavior.
// Wire decoding is covered separately by the Yjs integration tests.
class TextValue { constructor(value) { this.value = value; } toString() { return this.value; } }
class ArrayValue { constructor(value) { this.value = value; } toArray() { return this.value; } }
class MapValue extends Map {}
const Y = { Text: TextValue, Array: ArrayValue, Map: MapValue };
const context = vm.createContext({});
const read = vm.runInContext(`${source.slice(start, end)}\nreadYValue`, context);

for (const key of ["__proto__", "prototype", "constructor"]) {
  test(`client materialization rejects ${key} at every map depth`, () => {
    const bad = new MapValue([[key, new MapValue([["title", new TextValue("Injected")]])]]);
    assert.throws(() => read(Y, bad), /unsafe object key/);
    assert.throws(() => read(Y, new MapValue([["metadata", bad]])), /unsafe object key/);
    assert.throws(() => read(Y, new ArrayValue([bad])), /unsafe object key/);
    assert.equal(Object.prototype.title, undefined);
  });
}

test("safe client metadata has no prototype and preserves nested data and arbitrary public URLs", () => {
  const input = new MapValue([
    ["title", new TextValue("My note")],
    ["bookmark", new MapValue([["url", new TextValue("https://any-public-host.example/a?b=c")]])],
    ["rows", new ArrayValue([new MapValue([["value", 3]]), true, null])]
  ]);
  const output = read(Y, input);
  assert.equal(Object.getPrototypeOf(output), null);
  assert.equal(Object.getPrototypeOf(output.bookmark), null);
  assert.equal(Object.getPrototypeOf(output.rows[0]), null);
  assert.deepEqual(JSON.parse(JSON.stringify(output)), {
    title: "My note", bookmark: { url: "https://any-public-host.example/a?b=c" }, rows: [{ value: 3 }, true, null]
  });
  assert.equal(Object.getOwnPropertyDescriptor(output, "title").writable, true);
});

test("changed server updates are semantically checked before a successful worker response", () => {
  const worker = readFileSync(new URL("../src/lib/collaboration-update-worker.ts", import.meta.url), "utf8");
  const start = worker.indexOf("candidate = applyValidatedYjsStateUpdate(");
  const body = worker.slice(start);
  assert.match(body, /candidate\.changed \|\| request\.includeMaterialization\s*\? readCollaborationMaterialization\(candidate\.document\)/);
  assert.ok(body.indexOf("readCollaborationMaterialization") < body.indexOf("workerParentPort.postMessage(response"));
});
