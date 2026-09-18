import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { baseline, source, section, cycleSource, reorderSource, keyboardSource, cycle, reorder, lua, keyboard, outcome, chain, multiParent, random } from "./helpers/resource-audit-2026-09-18-harness.mjs";

const oldCycle = cycle(true), newCycle = cycle();
const oldReorder = reorder(true), newReorder = reorder();
const oldLua = lua(true), newLua = lua();
const freeze = rows => Object.freeze(rows.map(row => Object.freeze({ ...row })));

test("resource audit: retained original sources match their SHA-256 fingerprints", () => {
  for (const record of Object.values(baseline.files)) {
    assert.equal(createHash("sha256").update(record.source).digest("hex"), record.sha256);
  }
});

test("resource audit: cycle guard is identical for all 1,441 parent graphs of up to four nodes", () => {
  let count = 0;
  for (let size = 0; size <= 4; size += 1) {
    const total = (size + 2) ** size;
    for (let mask = 0; mask < total; mask += 1) {
      let code = mask;
      const rows = Array.from({ length: size }, (_, i) => {
        const choice = code % (size + 2); code = Math.floor(code / (size + 2));
        return { id: `b${i}`, parent_block_id: choice === size ? null : choice === size + 1 ? "missing" : `b${choice}` };
      });
      assert.deepEqual(outcome(newCycle, freeze(rows), []), outcome(oldCycle, freeze(rows), []), `size=${size}, graph=${mask}`);
      count += 1;
    }
  }
  assert.equal(count, 1441);
});

test("resource audit: cycle guard preserves overrides, disconnected cycles, unusual IDs and call isolation", () => {
  const rng = random();
  for (let run = 0; run < 3_000; run += 1) {
    const size = 1 + rng(35);
    const ids = Array.from({ length: size }, (_, i) => i === 0 ? "__proto__" : i === 1 ? "constructor" : `b${i}`);
    const parents = [null, "", "outside", ...ids];
    const rows = ids.map(id => ({ id, parent_block_id: parents[rng(parents.length)] }));
    if (run % 7 === 0) rows.reverse();
    const items = Array.from({ length: rng(size + 1) }, () => {
      const item = { id: ids[rng(size)] };
      if (rng(3)) item.parentBlockId = parents[rng(parents.length)];
      return item;
    });
    assert.deepEqual(outcome(newCycle, freeze(rows), freeze(items)), outcome(oldCycle, freeze(rows), freeze(items)), `run=${run}`);
  }
  const rows = chain(50);
  assert.equal(outcome(newCycle, rows, [{ id: "b0", parentBlockId: "b49" }]).ok, false);
  assert.equal(outcome(newCycle, rows, []).ok, true);
});

test("resource audit: cycle guard visits a 2,000-node chain at most once per node", () => {
  const metrics = {};
  cycle(false, metrics)(chain(2_000), []);
  assert.ok(metrics.mapGets <= 2_000, JSON.stringify(metrics));
  assert.ok(metrics.sets <= 3, JSON.stringify(metrics));
});

test("resource audit: reorder rejects stale versions, cross-page IDs, missing siblings, gaps, duplicate IDs and cycles identically", () => {
  const rows = [
    { id: "p", parent_block_id: null, edit_version: 1 },
    { id: "q", parent_block_id: null, edit_version: 2 },
    { id: "a", parent_block_id: "p", edit_version: 3 },
    { id: "b", parent_block_id: "p", edit_version: 1 }
  ];
  const valid = [ { id: "b", sortOrder: 0, expectedVersion: 1 }, { id: "a", sortOrder: 1, expectedVersion: 3 } ];
  const cases = [
    valid, [], [valid[0]], [valid[0], valid[0]],
    valid.map(item => ({ ...item, expectedVersion: 99 })),
    valid.map(item => ({ ...item, sortOrder: 0 })),
    valid.map(item => ({ ...item, sortOrder: item.sortOrder + 1 })),
    valid.map(item => ({ ...item, parentBlockId: "outside" })),
    valid.map(item => ({ ...item, parentBlockId: item.id })),
    valid.map(item => ({ ...item, parentBlockId: "q" })),
    [ { id: "outside", expectedVersion: 1, sortOrder: 0 } ],
    [ { id: "p", parentBlockId: "a", expectedVersion: 1, sortOrder: 0 }, { id: "q", expectedVersion: 2, sortOrder: 0 } ],
    [ ...valid, { id: "p", parentBlockId: null, expectedVersion: 1, sortOrder: 0 }, { id: "q", expectedVersion: 2, sortOrder: 1 } ]
  ];
  for (const items of cases) assert.deepEqual(outcome(newReorder, freeze(rows), freeze(items)), outcome(oldReorder, freeze(rows), freeze(items)));
  assert.equal(outcome(newReorder, rows, valid).ok, true);
  assert.equal(outcome(newReorder, rows, cases[5]).code, "INVALID_BLOCK_ORDER");
  assert.equal(outcome(newReorder, rows, cases[2]).code, "BLOCK_EDIT_CONFLICT");
});

test("resource audit: reorder guard preserves success, error and error precedence in 4,000 seeded requests", () => {
  const rng = random(180926);
  for (let run = 0; run < 4_000; run += 1) {
    const size = 2 + rng(45);
    const rows = Array.from({ length: size }, (_, i) => ({ id: `b${i}`, parent_block_id: i && rng(3) ? `b${rng(i)}` : null, edit_version: 1 + rng(3) }));
    const orders = new Map();
    const items = rows.map(row => {
      const p = row.parent_block_id, n = orders.get(p) ?? 0;
      orders.set(p, n + 1);
      return { id: row.id, sortOrder: n, expectedVersion: row.edit_version };
    });
    if (run % 8 === 1) items.splice(rng(items.length), 1);
    if (run % 8 === 2) items[rng(items.length)].expectedVersion += 1;
    if (run % 8 === 3) items[rng(items.length)].parentBlockId = `b${rng(size)}`;
    if (run % 8 === 4) items[rng(items.length)].sortOrder += 1;
    if (run % 8 === 5) items[rng(items.length)].parentBlockId = null;
    if (run % 8 === 6) items[rng(items.length)].id = "outside";
    if (run % 8 === 7) { items.push({ ...items[0] }); items.reverse(); }
    assert.deepEqual(outcome(newReorder, freeze(rows), freeze(items)), outcome(oldReorder, freeze(rows), freeze(items)), `run=${run}`);
  }
});

test("resource audit: sibling validation is linear across 500 affected parents and 2,000 rows", () => {
  const { rows, items } = multiParent();
  const metrics = {};
  assert.equal(reorder(false, metrics)(rows, items), true);
  assert.ok(metrics.mapGets <= 20_000, JSON.stringify(metrics));
  assert.ok(metrics.mapHas <= 10_000, JSON.stringify(metrics));
});

test("resource audit: Lua output is byte-identical over lexer branches, escaping and size boundaries", () => {
  const cases = [null, undefined, "", 17, { toString: () => "local test = 42" },
    'local x=0xff + 0x1.fp+2 + 1e-2 + .5 .. "x" --hi\nreturn nil, true, false',
    '--[==[ <script>alert(1)</script> ]==]\n[=[long\nstring]=] --unfinished',
    '"escaped \\" quote"\n\'unfinished',
    `& < > " ' \u0000 \uD800 😀 한글 __proto__ constructor`,
    '<img src=x onerror="globalThis.__auditXss=1">',
    " ".repeat(20_000), "-".repeat(20_000), "x".repeat(20_001),
    'local\n'.repeat(3_333) + 'xx', '[==[ unclosed long comment', '0x1..4 1..2 0x.2p2 2.e2',
    'print type tostring string math pairs ipairs assert error require table coroutine os io return'
  ];
  for (const value of cases) assert.equal(newLua.highlightLuaSource(value), oldLua.highlightLuaSource(value));
  assert.equal(newLua.highlightLuaSource("a".repeat(20_001)), null);
  assert.deepEqual(newLua.highlightResourceLimits, oldLua.highlightResourceLimits);
});

test("resource audit: Lua output is byte-identical for 5,000 seeded adversarial inputs", () => {
  const rng = random(0xc0ffee);
  const atoms = ['local', 'return', 'function', 'nil', 'print', 'foo', ' ', '\n', '\t', '-', '--', '[', ']', '=', '"', "'", '\\', '0x', '4e-', '12', '..', '.', '<', '>', '&', '😀', '한', '\uD800', '\u0000'];
  for (let run = 0; run < 5_000; run += 1) {
    let value = '';
    for (let i = 0, size = rng(150); i < size; i += 1) value += atoms[rng(atoms.length)];
    assert.equal(newLua.highlightLuaSource(value), oldLua.highlightLuaSource(value), `run=${run}`);
  }
});

test("resource audit: unstyled Lua text is escaped in one run, not once per character", () => {
  const metrics = {};
  const highlighter = lua(false, metrics).highlightLuaSource;
  assert.equal(highlighter(" & <> ".repeat(3_000)), oldLua.highlightLuaSource(" & <> ".repeat(3_000)));
  assert.equal(metrics.escapes, 1);
});

test("resource audit: irrelevant tree keys perform no node lookup or visible-tree traversal", () => {
  const metrics = {}, send = keyboard(false, metrics);
  for (const key of ["Tab", "Shift", "Control", "a", "Escape", "F5", "Dead"]) assert.equal(send(key), false);
  assert.equal(metrics.visibleTraversals ?? 0, 0);
  assert.equal(metrics.nodeLookups ?? 0, 0);
});

test("resource audit: horizontal/selection keys avoid visible traversal; four vertical navigation keys retain it", () => {
  const metrics = {}, send = keyboard(false, metrics);
  for (const key of ["ArrowLeft", "ArrowRight", "Enter", " "]) send(key);
  assert.equal(metrics.visibleTraversals ?? 0, 0);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End"]) send(key);
  assert.equal(metrics.visibleTraversals, 4);
  for (const key of ["ArrowDown", "ArrowUp", "Home", "End", "ArrowRight", "ArrowLeft", "Enter", " ", "Tab"]) assert.equal(keyboard()(key), keyboard(true)(key));
});

test("resource audit: all production code outside the four reviewed regions remains identical", () => {
  const routeRemainder = original => source("src/routes/block.routes.ts", original)
    .replace(cycleSource(original), "<cycle>")
    .replace(section(reorderSource(original), "        const requestedParentById", "        assertReorderDoesNotCreateCycle"), "<grouping>");
  assert.equal(routeRemainder(false), routeRemainder(true), "SQL, auth, transactions, request schema and version fences must not change");
  for (const [path, start, end] of [
    ["public/code-highlighting.js", "export function highlightLuaSource(", "function highlightSource("],
    ["public/treeview-block.js", '  tree.addEventListener("keydown", (event) => {', "\n  return editor;"]
  ]) {
    const remove = original => { const text = source(path, original); return text.replace(section(text, start, end), "<reviewed>"); };
    assert.equal(remove(false), remove(true), path);
  }
});
