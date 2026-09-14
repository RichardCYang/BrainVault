import test from "node:test";
import assert from "node:assert/strict";
import {
  assignRemoteCaretColors,
  getRemoteCaretClientKey,
  hasRemotePresenceDecorationChanges,
  getTextSelectionControlByKey,
  getTextSelectionControlKey
} from "../public/collaboration-caret.js";

test("remote caret colors are unique and stable for active users", () => {
  const clients = Array.from({ length: 64 }, (_, index) => ({
    connectionId: `connection-${index}`,
    user: { id: `user-${index}`, username: `user${index}` }
  }));
  const forward = assignRemoteCaretColors(clients);
  const reverse = assignRemoteCaretColors([...clients].reverse());
  const colors = clients.map((client) => forward.get(getRemoteCaretClientKey(client)));

  assert.equal(new Set(colors).size, clients.length);
  for (const client of clients) {
    assert.equal(
      forward.get(getRemoteCaretClientKey(client)),
      reverse.get(getRemoteCaretClientKey(client))
    );
  }
});

test("text control awareness keys identify the same control on another render", () => {
  const controls = [
    { value: "first", selectionStart: 0, selectionEnd: 0 },
    { value: "second", selectionStart: 2, selectionEnd: 2 },
    { value: "third", selectionStart: 1, selectionEnd: 3 }
  ];
  const row = { querySelectorAll: () => controls };

  const key = getTextSelectionControlKey(controls[1], row);
  assert.equal(key, "text:1");
  assert.equal(getTextSelectionControlByKey(row, key), controls[1]);
  assert.equal(getTextSelectionControlByKey(row, "text:999"), null);
  assert.equal(getTextSelectionControlByKey(row, "unsafe-selector"), null);
});


test("selection-only awareness changes do not require rebuilding remote presence decorations", () => {
  const user = { id: "user-a", username: "alice", name: "Alice", avatarData: "data:image/png;base64,abc" };
  const previous = [{
    connectionId: "connection-a",
    user,
    state: { blockId: "block-1", field: "markdown", control: "text:0", selection: { anchor: 10, head: 10 } }
  }];
  const selectionOnly = [{
    ...previous[0],
    state: { blockId: "block-1", field: "markdown", control: "text:0", selection: { anchor: 11, head: 11 } }
  }];
  const otherControlSameBlock = [{
    ...previous[0],
    state: { blockId: "block-1", field: "table", control: "text:3", selection: { anchor: 2, head: 4 } }
  }];

  assert.equal(hasRemotePresenceDecorationChanges(previous, selectionOnly), false);
  assert.equal(hasRemotePresenceDecorationChanges(selectionOnly, otherControlSameBlock), false);
});

test("presence decoration changes still trigger a full collaboration chrome refresh", () => {
  const base = [{
    connectionId: "connection-a",
    user: { id: "user-a", username: "alice", name: "Alice", avatarData: null },
    state: { blockId: "block-1", selection: { anchor: 1, head: 1 } }
  }];

  assert.equal(hasRemotePresenceDecorationChanges(base, []), true);
  assert.equal(hasRemotePresenceDecorationChanges(base, [{ ...base[0], state: { ...base[0].state, blockId: "block-2" } }]), true);
  assert.equal(hasRemotePresenceDecorationChanges(base, [{ ...base[0], connectionId: "connection-b" }]), true);
  assert.equal(hasRemotePresenceDecorationChanges(base, [{
    ...base[0],
    user: { ...base[0].user, name: "Alicia" }
  }]), true);
});
