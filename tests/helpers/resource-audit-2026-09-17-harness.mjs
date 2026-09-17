import { readFileSync } from "node:fs";

export const resourceAuditBaseline = JSON.parse(readFileSync(
  new URL("../fixtures/resource-audit-2026-09-17-baseline.json", import.meta.url), "utf8"
));

export function auditSource(name, mode = "current") {
  const record = resourceAuditBaseline.records[name];
  if (!record) throw new Error(`Unknown resource audit section: ${name}`);
  if (mode === "baseline") return record.source;
  const source = readFileSync(new URL(`../../${record.path}`, import.meta.url), "utf8");
  if (!record.start) return source;
  const start = source.indexOf(`function ${record.start}(`);
  const end = source.indexOf(`function ${record.end}(`, start + 1);
  if (start < 0 || end < 0) throw new Error(`Missing production section: ${name}`);
  return source.slice(start, end);
}

export function makeAuditBlock(id, sortOrder = 0, parentBlockId = null) {
  return {
    id, pageId: "p", parentBlockId, sortOrder, version: 1,
    type: "MARKDOWN", markdown: "한글 😀 <script>text</script>",
    metadata: { nested: ["kept", { value: 7 }] }
  };
}

export function insertionFixture(count = 2000, reorder = false) {
  const before = Array.from({ length: count }, (_, index) => makeAuditBlock(`b${index}`, index));
  const created = makeAuditBlock("new", count);
  const ordered = [...before.map(block => block.id), created.id];
  if (reorder && count) ordered.splice(Math.floor(count / 2), 0, ordered.pop());
  const originalById = new Map([...before, created].map(block => [block.id, block]));
  const canonical = ordered.map((id, sortOrder) => ({ ...originalById.get(id), version: 2, sortOrder }));
  return {
    pageId: "p", baseContentVersion: 10, currentContentVersion: reorder ? 12 : 11,
    beforeBlocks: before,
    currentBlocks: reorder ? canonical.filter(block => block.id !== created.id) : structuredClone(before),
    parentBlockId: null, orderedIds: ordered,
    createResult: {
      block: created, pageContentVersion: 11, pageUpdatedAt: "2026-09-17T00:00:00.000Z",
      pageContentVersionAuthoritative: true
    },
    orderResult: reorder ? { blocks: canonical, pageContentVersion: 12, pageUpdatedAt: "2026-09-17T00:00:01.000Z" } : null
  };
}

export function loadInsertion(mode = "current") {
  return new Function(`${auditSource("insertion", mode).replace("export function", "function")}\nreturn planConfirmedBlockInsertion;`)();
}

export function measureInsertionReads(run, input) {
  let indexedReads = 0;
  const orderedIds = new Proxy(input.orderedIds, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) indexedReads += 1;
      return Reflect.get(target, key, receiver);
    }
  });
  return { result: run({ ...input, orderedIds }), indexedReads };
}

export function collaborationTreeFixture(count = 2000, spine = 128, leafFirst = false) {
  spine = Math.min(spine, count);
  const path = Array.from({ length: spine }, (_, index) => makeAuditBlock(`d${index}`, index, index ? `d${index - 1}` : null));
  const leaves = Array.from({ length: count - spine }, (_, index) => makeAuditBlock(`l${index}`, index, spine ? `d${spine - 1}` : null));
  return leafFirst ? [...leaves, ...path.reverse()] : [...path, ...leaves];
}

export function loadCollaborationTree(mode = "current", { instrument = false } = {}) {
  const metrics = { mapGets: 0, mapAllocations: 0, setAllocations: 0 };
  class CountedMap extends Map {
    constructor(...args) { super(...args); metrics.mapAllocations += 1; }
    get(key) { metrics.mapGets += 1; return super.get(key); }
  }
  class CountedSet extends Set {
    constructor(...args) { super(...args); metrics.setAllocations += 1; }
  }
  const state = { selectedPage: { blocks: [] } };
  const run = new Function("Map", "Set", "state", `${auditSource("tree", mode)}\nreturn buildCollaborationBlockTree;`)(
    instrument ? CountedMap : Map, instrument ? CountedSet : Set, state
  );
  return { run, state, metrics };
}

export function seededRandom(seed = 0x20260917) {
  return () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
}

export function freezeAuditInput(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) freezeAuditInput(child);
  }
  return value;
}
