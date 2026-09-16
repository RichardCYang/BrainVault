import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

export const rootUrl = new URL("../../", import.meta.url);
export const baseline = JSON.parse(readFileSync(new URL("../fixtures/resource-cost-baseline.json", import.meta.url), "utf8"));

export function sourceFor(file, mode = "current") {
  if (mode === "baseline") {
    const record = baseline.files[file];
    if (!record || createHash("sha256").update(record.source).digest("hex") !== record.sha256) {
      throw new Error(`Invalid resource baseline: ${file}`);
    }
    return record.source;
  }
  return readFileSync(new URL(file, rootUrl), "utf8");
}

// Execute complete production modules as native ESM, not reimplemented algorithms.
// Strip only TypeScript syntax; all unmodified relative dependencies stay native.
export async function loadModule(file, mode = "current") {
  let source = sourceFor(file, mode);
  if (file.endsWith(".ts")) source = stripTypeScriptTypes(source);
  source = source.replace(/(from\s+["'])(\.\.?\/[^"']+)(["'])/g,
    (_, prefix, relative, suffix) => prefix + new URL(relative, new URL(file, rootUrl)).href + suffix);
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

export function seededRandom(seed = 0x51ab19) {
  return () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) / 0x1_0000_0000;
  };
}

export function freeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) freeze(item);
  }
  return value;
}

export function databaseFixture(count = 200, seed = 179) {
  const random = seededRandom(seed);
  const options = Array.from({ length: 30 }, (_, index) => ({ id: `o${index}`, name: `항목 ${index}`, color: "blue" }));
  const properties = ["title", "text", "number", "select", "multi_select", "checkbox", "date", "url"].map(type => ({
    id: type, type, name: type, options: ["select", "multi_select"].includes(type) ? options : []
  }));
  const titles = ["가나다", "나", "Z", "a", "Ä", "á", "Å", "i", "İ", "ı", "東京", "😀", "e\u0301", "é", "item", ""];
  const rows = Array.from({ length: count }, (_, index) => ({
    id: `r${index}`,
    values: {
      title: `${titles[Math.floor(random() * titles.length)]} ${Math.floor(random() * 1000)}`,
      text: titles[Math.floor(random() * titles.length)],
      number: index % 7 ? Math.floor(random() * 100) - 50 : null,
      select: index % 7 ? `o${Math.floor(random() * 30)}` : null,
      multi_select: index % 5 ? [`o${Math.floor(random() * 30)}`, `o${Math.floor(random() * 30)}`] : [],
      checkbox: random() > .5,
      date: index % 6 ? `2026-09-${String(1 + Math.floor(random() * 28)).padStart(2, "0")}` : "",
      url: index % 8 ? `https://example.invalid/${Math.floor(random() * 100)}` : ""
    }
  }));
  const view = { id: "v", name: "test", type: "table", filters: [], sorts: [{ id: "s", propertyId: "title", direction: "ascending" }], groupPropertyId: null, hiddenPropertyIds: [] };
  return { title: "fixture", properties, rows, views: [view], activeViewId: view.id };
}

export function countSortWork(run) {
  const localeCompare = String.prototype.localeCompare;
  const Collator = Intl.Collator;
  const result = { localeCompareCalls: 0, collatorConstructions: 0 };
  String.prototype.localeCompare = function (...args) {
    result.localeCompareCalls += 1;
    return Reflect.apply(localeCompare, this, args);
  };
  Intl.Collator = new Proxy(Collator, {
    construct(target, args) {
      result.collatorConstructions += 1;
      return Reflect.construct(target, args);
    }
  });
  try { result.value = run(); } finally {
    String.prototype.localeCompare = localeCompare;
    Intl.Collator = Collator;
  }
  return result;
}

export function makeStorage(keys) {
  return { get length() { return keys.length; }, key(index) { return keys[index] ?? null; } };
}

export function countStorageWork(run) {
  const stringify = JSON.stringify;
  const sort = Array.prototype.sort;
  const result = { signatureCalls: 0, signatureCodeUnits: 0, sortedKeyCount: 0 };
  JSON.stringify = function (...args) {
    const value = Reflect.apply(stringify, this, args);
    result.signatureCalls += 1;
    result.signatureCodeUnits += value?.length ?? 0;
    return value;
  };
  Array.prototype.sort = function (...args) {
    result.sortedKeyCount += this.length;
    return Reflect.apply(sort, this, args);
  };
  try { result.value = run(); } finally {
    JSON.stringify = stringify;
    Array.prototype.sort = sort;
  }
  return result;
}
