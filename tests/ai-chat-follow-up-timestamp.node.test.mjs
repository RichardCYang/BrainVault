import test from "node:test";
import assert from "node:assert/strict";

import { createAiChatFollowUpTurnData } from "../public/ai-chat-block.js";

test("new AI chat follow-up turns inherit the first turn timestamp as their initial value", () => {
  const inherited = createAiChatFollowUpTurnData("2026-08-14T09:45");

  assert.deepEqual(inherited, {
    answeredAt: "2026-08-14T09:45",
    question: "",
    answer: ""
  });
});

test("clearing the first turn timestamp also creates a blank follow-up timestamp", () => {
  assert.equal(createAiChatFollowUpTurnData("").answeredAt, "");
});
