import assert from "node:assert/strict";
import test from "node:test";
import { mergeConcurrentValue } from "../public/collaboration.js";

// A structured block editor (table, board, database...) sends its whole value
// on every keystroke. Each send waits for durable recovery storage first, so a
// peer's change can land in between. The editor's change must then be merged
// onto the shared value instead of overwriting the peer's change with the
// editor's older copy. `base` is what this editor last sent.

const table = (rows) => ({ table: { rows, headerRow: false, headerColumn: false } });
const card = (id, title) => ({ id, title, description: "", icon: null, color: "default", tags: [] });
const board = (...columns) => ({
  kanban: { title: "Board", columns: columns.map(([id, cards]) => ({ id, title: id, color: "gray", cards })) }
});

test("a peer's edit to another table cell survives this editor's keystroke", () => {
  const base = table([["a", "b"], ["c", "d"]]);
  const live = table([["a", "b"], ["c", "d - peer note"]]);
  const local = table([["a!", "b"], ["c", "d"]]);
  assert.deepEqual(mergeConcurrentValue(base, live, local), table([["a!", "b"], ["c", "d - peer note"]]));
});

test("two people typing into the same cell keep both insertions", () => {
  const merged = mergeConcurrentValue(table([["hello"]]), table([["hello world"]]), table([["Oh hello"]]));
  assert.deepEqual(merged, table([["Oh hello world"]]));
});

test("a row added by a peer and a cell edited here are both kept", () => {
  const base = table([["a", "b"]]);
  const live = table([["a", "b"], ["c", "d"]]);
  const local = table([["a", "B"]]);
  assert.deepEqual(mergeConcurrentValue(base, live, local), table([["a", "B"], ["c", "d"]]));
});

test("a column added here and a cell edited by a peer are both kept", () => {
  const base = table([["a", "b"], ["c", "d"]]);
  const live = table([["a", "b"], ["c", "D"]]);
  const local = table([["a", "b", ""], ["c", "d", ""]]);
  assert.deepEqual(mergeConcurrentValue(base, live, local), table([["a", "b", ""], ["c", "D", ""]]));
});

test("a card a peer added stays when this editor renames another card", () => {
  const base = board(["todo", [card("c1", "One")]]);
  const live = board(["todo", [card("c1", "One"), card("c2", "Two")]]);
  const local = board(["todo", [card("c1", "One renamed")]]);
  assert.deepEqual(
    mergeConcurrentValue(base, live, local),
    board(["todo", [card("c1", "One renamed"), card("c2", "Two")]])
  );
});

test("this editor's reorder keeps a peer's edit to a moved card", () => {
  const base = board(["todo", [card("c1", "One"), card("c2", "Two")]]);
  const live = board(["todo", [card("c1", "One (peer)"), card("c2", "Two")]]);
  const local = board(["todo", [card("c2", "Two"), card("c1", "One")]]);
  assert.deepEqual(
    mergeConcurrentValue(base, live, local),
    board(["todo", [card("c2", "Two"), card("c1", "One (peer)")]])
  );
});

test("a card removed here but changed by a peer meanwhile is kept, not lost", () => {
  const base = board(["todo", [card("c1", "One"), card("c2", "Two")]]);
  const live = board(["todo", [card("c1", "One"), card("c2", "Two, with peer notes")]]);
  const local = board(["todo", [card("c1", "One")]]);
  assert.deepEqual(mergeConcurrentValue(base, live, local), live);
});

test("removals nobody else touched still go through", () => {
  const base = board(["todo", [card("c1", "One"), card("c2", "Two")]]);
  const removedHere = board(["todo", [card("c1", "One")]]);
  assert.deepEqual(mergeConcurrentValue(base, base, removedHere), removedHere);
  const removedByPeer = board(["todo", [card("c2", "Two")]]);
  const editedHere = board(["todo", [card("c1", "One"), card("c2", "Two!")]]);
  assert.deepEqual(mergeConcurrentValue(base, removedByPeer, editedHere), board(["todo", [card("c2", "Two!")]]));
});

test("a card moved between columns here lands in the new column", () => {
  const base = board(["todo", [card("c1", "One")]], ["done", []]);
  const local = board(["todo", []], ["done", [card("c1", "One")]]);
  assert.deepEqual(mergeConcurrentValue(base, base, local), local);
});

test("an unchanged editor value never overwrites the shared value", () => {
  const base = table([["a"]]);
  const live = table([["peer"]]);
  assert.deepEqual(mergeConcurrentValue(base, live, base), live);
});
