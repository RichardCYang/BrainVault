import test from "node:test";
import assert from "node:assert/strict";
import {
  assignRemoteCaretColors,
  getRemoteCaretClientKey,
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
