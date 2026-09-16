import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import test from "node:test";
import {
  baseline, sourceFor, loadModule, seededRandom, freeze, databaseFixture,
  countSortWork, makeStorage, countStorageWork
} from "./helpers/resource-cost-harness.mjs";

const zip = { baseline: await loadModule("src/lib/zip.ts", "baseline"), current: await loadModule("src/lib/zip.ts") };
const storage = { baseline: await loadModule("public/storage-snapshot.js", "baseline"), current: await loadModule("public/storage-snapshot.js") };
const databases = {};
for (const [side, file] of [["client", "public/database-block.js"], ["server", "src/lib/database.ts"]]) {
  databases[side] = { baseline: await loadModule(file, "baseline"), current: await loadModule(file) };
}

for (const [file, record] of Object.entries(baseline.files)) test(`resource baseline preserves original bytes: ${file}`, () => {
  assert.equal(createHash("sha256").update(record.source).digest("hex"), record.sha256);
});

test("native ZIP CRC keeps the standard check vector, empty data, and unsigned seed semantics", () => {
  assert.equal(zip.current.crc32(Buffer.from("123456789")), 0xcbf43926);
  assert.equal(zip.current.crc32(Buffer.alloc(0)), 0);
  for (const seed of [0, 1, 0xffffffff, -1, -4294967296, 4294967296, NaN, Infinity, 1.25]) {
    for (const bytes of [Buffer.alloc(0), Buffer.from([0, 255, 1, 128]), new TextEncoder().encode("한글😀\u0000")]) {
      assert.equal(zip.current.updateCrc32(seed, bytes), zip.baseline.updateCrc32(seed, bytes));
    }
  }
});

test("1000 deterministic byte streams keep exact incremental CRC values and chunk boundaries", () => {
  const random = seededRandom(0x727e18);
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const bytes = Uint8Array.from({ length: Math.floor(random() * 4097) }, () => Math.floor(random() * 256));
    let legacy = 0, current = 0;
    for (let offset = 0; offset < bytes.length;) {
      const end = Math.min(bytes.length, offset + 1 + Math.floor(random() * 137));
      const chunk = bytes.subarray(offset, end);
      legacy = zip.baseline.updateCrc32(legacy, chunk);
      current = zip.current.updateCrc32(current, chunk);
      assert.equal(current, legacy, `stream ${iteration} offset ${offset}`);
      offset = end;
    }
    assert.equal(current, zip.current.crc32(bytes));
  }
});

test("CRC consumes only the view, does not mutate buffers, and accepts SharedArrayBuffer views", () => {
  for (const backing of [new ArrayBuffer(2048), new SharedArrayBuffer(2048)]) {
    const all = new Uint8Array(backing);
    all.forEach((_, index) => { all[index] = index % 251; });
    const before = Buffer.from(all);
    for (const [offset, length] of [[0, 0], [1, 1], [17, 512], [1024, 1024]]) {
      const view = new Uint8Array(backing, offset, length);
      assert.equal(zip.current.crc32(view), zip.baseline.crc32(view));
    }
    assert.deepEqual(Buffer.from(all), before);
  }
});

async function archive(module, data, source = { kind: "buffer", data }, overrides = {}) {
  const chunks = [];
  const output = new Writable({ highWaterMark: 64, write(chunk, _encoding, callback) {
    chunks.push(Buffer.from(chunk));
    setImmediate(callback);
  } });
  const writer = new module.ZipWriter(output);
  await writer.add({ name: "자료/한글😀.bin", size: BigInt(data.length), crc32: zip.baseline.crc32(data),
    sha256: createHash("sha256").update(data).digest("hex"), source,
    modifiedAt: new Date("2026-09-01T12:34:56Z"), ...overrides });
  await writer.finalize();
  output.end();
  if (!output.writableFinished) await new Promise((resolve, reject) => { output.once("finish", resolve); output.once("error", reject); });
  return Buffer.concat(chunks);
}

test("ZIP output is byte-identical for buffer/file sources, under real writable backpressure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brainvault-crc-"));
  try {
    const data = Buffer.alloc(256 * 1024 + 17);
    for (let index = 0; index < data.length; index += 1) data[index] = index % 251;
    const path = join(directory, "source.bin");
    await writeFile(path, data);
    for (const source of [{ kind: "buffer", data }, { kind: "file", path }]) {
      assert.deepEqual(await archive(zip.current, data, source), await archive(zip.baseline, data, source));
    }
    assert.deepEqual(await archive(zip.current, Buffer.alloc(0)), await archive(zip.baseline, Buffer.alloc(0)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("optimized ZIP writes still reject size, CRC, and cryptographic SHA-256 mismatches", async () => {
  const data = Buffer.from("unaltered private backup bytes");
  for (const overrides of [{ size: BigInt(data.length + 1) }, { crc32: 1 }, { sha256: "0".repeat(64) }, { sha256: "invalid" }]) {
    for (const mode of ["baseline", "current"]) {
      await assert.rejects(archive(zip[mode], data, { kind: "buffer", data }, overrides));
    }
  }
});

test("native ZIP CRC interoperates with directory reads, extraction, and corruption rejection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "brainvault-zip-roundtrip-"));
  try {
    const data = Buffer.from("한글😀\u0000exact attachment bytes".repeat(10000));
    const path = join(directory, "backup.zip");
    await writeFile(path, await archive(zip.current, data));
    for (const [mode, module] of Object.entries(zip)) {
      const entries = await module.readZipDirectory(path);
      assert.equal(entries.length, 1);
      assert.deepEqual(await module.readZipEntryBuffer(path, entries[0], data.length), data);
      const output = join(directory, `${mode}.bin`);
      await module.copyZipEntryToFile(path, entries[0], output, data.length);
      assert.deepEqual(await readFile(output), data);
      await assert.rejects(module.readZipEntryBuffer(path, entries[0], data.length - 1));
      await assert.rejects(module.copyZipEntryToFile(path, entries[0], output, data.length - 1));
    }
    const entries = await zip.current.readZipDirectory(path);
    const corrupt = await readFile(path);
    corrupt[Number(entries[0].dataOffset) + 3] ^= 1;
    await writeFile(path, corrupt);
    for (const [mode, module] of Object.entries(zip)) {
      await assert.rejects(module.readZipEntryBuffer(path, entries[0], data.length), /checksum/i);
      await assert.rejects(module.copyZipEntryToFile(path, entries[0], join(directory, `corrupt-${mode}.bin`), data.length), /checksum/i);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("ZIP reader/writer guards remain unchanged outside the CRC implementation and import", () => {
  const tail = source => source.slice(source.indexOf("export function crc32(data"));
  assert.equal(tail(sourceFor("src/lib/zip.ts")), tail(sourceFor("src/lib/zip.ts", "baseline")));
  assert.match(sourceFor("src/lib/zip.ts"), /import \{ crc32 as nativeCrc32 \} from "node:zlib"/);
});

for (const [side, modules] of Object.entries(databases)) {
  test(`${side}: a 200-row string sort reuses one collator rather than repeated localeCompare setup`, () => {
    const data = freeze(databaseFixture());
    const before = countSortWork(() => modules.baseline.applyDatabaseView(data));
    const after = countSortWork(() => modules.current.applyDatabaseView(data));
    assert.deepEqual(after.value, before.value);
    assert.ok(before.localeCompareCalls > 1000);
    assert.equal(after.localeCompareCalls, 0);
    assert.equal(after.collatorConstructions, 1);
    assert.deepEqual(data.rows.map(row => row.id), Array.from({ length: 200 }, (_, index) => `r${index}`));
  });

  test(`${side}: numeric, checkbox, empty, unsorted, and missing-property paths create no collators`, () => {
    for (const kind of ["number", "checkbox", "missing", "empty", "unsorted", "zero", "one"]) {
      const data = databaseFixture(kind === "zero" ? 0 : kind === "one" ? 1 : 200);
      if (kind === "empty") data.rows.forEach(row => { row.values.title = ""; });
      data.views[0].sorts = kind === "unsorted" ? [] : [{ propertyId: ["empty", "zero", "one"].includes(kind) ? "title" : kind, direction: "ascending" }];
      freeze(data);
      const result = countSortWork(() => modules.current.applyDatabaseView(data));
      assert.equal(result.collatorConstructions, 0, kind);
      assert.deepEqual(result.value, modules.baseline.applyDatabaseView(data));
      assert.notEqual(result.value, data.rows);
    }
  });

  test(`${side}: 600 randomized filters and multi-column sorts exactly preserve row identities/order`, () => {
    const random = seededRandom(0x179aba);
    const propertyIds = ["title", "text", "number", "select", "multi_select", "checkbox", "date", "url", "missing"];
    const operators = ["contains", "equals", "is_empty", "is_not_empty", "checked", "unchecked"];
    for (let iteration = 0; iteration < 600; iteration += 1) {
      const data = databaseFixture(2 + Math.floor(random() * 70), iteration + 37);
      const view = data.views[0];
      view.sorts = Array.from({ length: Math.floor(random() * 9) }, () => ({
        propertyId: propertyIds[Math.floor(random() * propertyIds.length)], direction: random() > .5 ? "ascending" : "descending"
      }));
      view.filters = Array.from({ length: Math.floor(random() * 4) }, () => ({
        propertyId: propertyIds[Math.floor(random() * propertyIds.length)], operator: operators[Math.floor(random() * operators.length)],
        value: [null, "", "a", "o1", 12, true][Math.floor(random() * 6)]
      }));
      freeze(data);
      const before = modules.baseline.applyDatabaseView(data, view);
      const after = modules.current.applyDatabaseView(data, view);
      assert.deepEqual(after, before, `scenario ${iteration}`);
      after.forEach((row, index) => assert.equal(row, before[index]));
    }
  });

  test(`${side}: tied values, multi-select labels, prototype-name identifiers and live edits stay fresh`, () => {
    const data = databaseFixture(200);
    data.properties.push({ id: "__proto__", type: "text", name: "special", options: [] });
    for (const row of data.rows) Object.defineProperty(row.values, "__proto__", { value: "same", enumerable: true });
    for (const propertyId of ["title", "multi_select", "select", "__proto__"]) {
      data.views[0].sorts = [{ propertyId, direction: "descending" }, { propertyId: "number", direction: "ascending" }];
      assert.deepEqual(modules.current.applyDatabaseView(data), modules.baseline.applyDatabaseView(data));
      data.rows[0].values.title = "000 changed";
      data.properties.find(property => property.id === "select").options[0].name = "renamed";
      assert.deepEqual(modules.current.applyDatabaseView(data), modules.baseline.applyDatabaseView(data));
    }
    data.rows.forEach(row => { row.values.title = "equal"; });
    data.views[0].sorts = [{ propertyId: "title", direction: "ascending" }];
    assert.deepEqual(modules.current.applyDatabaseView(data), data.rows);
  });
}

test("storage stability retains no serialized full-key signature or sorted temporary arrays", () => {
  const keys = Array.from({ length: 5000 }, (_, index) => `brainvault:${index}:` + "x".repeat(120));
  const before = countStorageWork(() => storage.baseline.inspectStorageKeys(makeStorage(keys)));
  const after = countStorageWork(() => storage.current.inspectStorageKeys(makeStorage(keys)));
  assert.deepEqual(after.value, before.value);
  assert.equal(before.signatureCalls, 3);
  assert.ok(before.signatureCodeUnits > 2_000_000);
  assert.equal(after.signatureCalls, 0);
  assert.equal(after.sortedKeyCount, 0);
});

class MutatingStorage {
  constructor(keys, mutations = [], throwAt = -1) {
    this.keys = [...keys]; this.mutations = new Map(mutations.map(item => [item.at, item]));
    this.throwAt = throwAt; this.operations = 0; this.trace = [];
  }
  touch(kind, index = "") {
    this.trace.push(`${kind}:${index}`);
    this.operations += 1;
    if (this.operations === this.throwAt) throw new Error("Storage denied");
    const mutation = this.mutations.get(this.operations);
    if (!mutation) return;
    if (mutation.kind === "add") this.keys.push(mutation.value);
    else if (mutation.kind === "remove") this.keys.splice(mutation.index % Math.max(1, this.keys.length), 1);
    else if (mutation.kind === "reverse") this.keys.reverse();
    else if (mutation.kind === "rotate" && this.keys.length) this.keys.push(this.keys.shift());
    else if (mutation.kind === "replace") this.keys = [...mutation.value];
  }
  get length() { this.touch("length"); return this.keys.length; }
  key(index) { this.touch("key", index); return this.keys[index] ?? null; }
}
const comparable = result => ({ keys: result.keys, reliable: result.reliable, error: result.error ? { name: result.error.name, message: result.error.message } : null });

test("1000 deterministic storage races retain exact reads, observed keys, failure boundaries, and reliability", () => {
  const random = seededRandom(0x99bef0);
  const candidates = ["draft", "draft\u0000survivor", "survivor", "__proto__", "constructor", "😀", "", null, "a&b", "a=b"];
  for (let iteration = 0; iteration < 1000; iteration += 1) {
    const keys = Array.from({ length: Math.floor(random() * 14) }, () => candidates[Math.floor(random() * candidates.length)]);
    const mutations = Array.from({ length: 12 }, () => {
      const kind = ["add", "remove", "reverse", "rotate", "replace"][Math.floor(random() * 5)];
      return { at: 1 + Math.floor(random() * 100), kind, index: Math.floor(random() * 10), value: kind === "replace" ? ["a", "b\u0000c"] : candidates[Math.floor(random() * candidates.length)] };
    });
    const throwAt = iteration % 7 ? -1 : 1 + Math.floor(random() * 100);
    const options = { maxPasses: 1 + Math.floor(random() * 12), stablePasses: 1 + Math.floor(random() * 5) };
    const a = new MutatingStorage(keys, mutations, throwAt), b = new MutatingStorage(keys, mutations, throwAt);
    assert.deepEqual(comparable(storage.current.inspectStorageKeys(b, options)), comparable(storage.baseline.inspectStorageKeys(a, options)), `scenario ${iteration}`);
    assert.deepEqual(b.trace, a.trace, `read trace ${iteration}`);
  }
});

test("storage delimiter collisions, changing enumeration order, unavailable storage and invalid options stay safe", () => {
  for (const keys of [[], ["a", "b\u0000c"], ["a\u0000b", "c"], ["__proto__", "constructor"], ["", "valid"], ["a", "a"]]) {
    for (const options of [{}, { maxPasses: 0, stablePasses: -1 }, { maxPasses: 2, stablePasses: 3 }, { stablePasses: 1 }]) {
      assert.deepEqual(comparable(storage.current.inspectStorageKeys(makeStorage(keys), options)), comparable(storage.baseline.inspectStorageKeys(makeStorage(keys), options)));
    }
  }
  for (const value of [null, undefined]) assert.deepEqual(comparable(storage.current.inspectStorageKeys(value)), comparable(storage.baseline.inspectStorageKeys(value)));
  // Same cardinality and same NUL-delimited representation are not equality.
  for (const module of Object.values(storage)) {
    const alternating = { reads: 0, get length() { return 2; }, key(index) {
      const pass = Math.floor(this.reads++ / 4);
      return (pass % 2 ? ["a\u0000b", "c"] : ["a", "b\u0000c"])[index];
    } };
    const result = module.inspectStorageKeys(alternating, { maxPasses: 6, stablePasses: 3 });
    assert.equal(result.reliable, false);
    assert.deepEqual(result.keys, ["a", "b\u0000c", "a\u0000b", "c"]);
    const reordered = { reads: 0, get length() { return 2; }, key(index) {
      return (Math.floor(this.reads++ / 4) % 2 ? ["b", "a"] : ["a", "b"])[index];
    } };
    assert.equal(module.inspectStorageKeys(reordered).reliable, true);
    assert.equal(reordered.reads, 12);
  }
});

test("server table/board/list HTML stays byte-identical with Unicode and hostile text/URLs", () => {
  const modules = databases.server;
  for (const type of ["table", "board", "list"]) {
    const data = databaseFixture(200);
    data.title = '<img src=x onerror=alert(1)> 한글 😀 & "';
    data.properties[0].name = '<script>alert(1)</script>';
    data.rows[0].values.title = '<svg onload=alert(1)> & é e\u0301';
    data.rows[1].values.url = 'javascript:alert(1)';
    data.rows[2].values.url = 'https://example.invalid/" onmouseover="alert(1)';
    data.views[0].type = type;
    data.views[0].groupPropertyId = type === "board" ? "select" : null;
    const input = freeze({ database: data });
    const before = modules.baseline.renderDatabaseHtml(input);
    const after = modules.current.renderDatabaseHtml(input);
    assert.equal(after, before);
    assert.doesNotMatch(after, /<(?:script|img|svg|iframe)\b/i);
    assert.doesNotMatch(after, /href=["']javascript:/i);
  }
});
