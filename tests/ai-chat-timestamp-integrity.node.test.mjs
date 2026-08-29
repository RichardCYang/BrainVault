import test from "node:test";
import assert from "node:assert/strict";

import {
  createDefaultAiChatData,
  normalizeAiChatData
} from "../public/ai-chat-block.js";
import { getAiChatData } from "../src/lib/ai-chat.ts";

const fallbackAnsweredAt = "2026-08-29T07:30";

function canonicalChat(turns) {
  return {
    title: "Timestamp round trip",
    provider: "chatgpt",
    model: "GPT Test",
    layout: "stacked",
    hideAnswerBorder: false,
    turns
  };
}

test("AI chat normalization preserves intentionally blank answer timestamps", () => {
  const value = canonicalChat([
    { answeredAt: "", question: "First", answer: "One" },
    { answeredAt: "2026-08-28T12:34", question: "Second", answer: "Two" },
    { answeredAt: "", question: "Third", answer: "Three" }
  ]);

  const client = normalizeAiChatData(value, { fallbackAnsweredAt });
  const server = getAiChatData({ aiChat: value });

  assert.deepEqual(client, server);
  assert.deepEqual(client.turns.map((turn) => turn.answeredAt), ["", "2026-08-28T12:34", ""]);
});

test("canonical multi-turn metadata does not invent timestamps for omitted fields", () => {
  const value = canonicalChat([
    { question: "No timestamp", answer: "Still valid" },
    { answeredAt: "", question: "Explicitly blank", answer: "Also valid" }
  ]);

  const normalized = normalizeAiChatData(value, { fallbackAnsweredAt });

  assert.deepEqual(normalized.turns.map((turn) => turn.answeredAt), ["", ""]);
});

test("legacy single-turn metadata may still derive a missing timestamp from block updatedAt", () => {
  const normalized = normalizeAiChatData(
    { provider: "chatgpt", question: "Legacy question", answer: "Legacy answer" },
    { fallbackAnsweredAt }
  );

  assert.equal(normalized.turns[0].answeredAt, fallbackAnsweredAt);
});

test("an explicitly cleared legacy timestamp stays cleared", () => {
  const normalized = normalizeAiChatData(
    { provider: "chatgpt", answeredAt: "", question: "Legacy question", answer: "Legacy answer" },
    { fallbackAnsweredAt }
  );

  assert.equal(normalized.turns[0].answeredAt, "");
});

test("new AI chat blocks still receive an initial local timestamp", () => {
  const answeredAt = createDefaultAiChatData().turns[0].answeredAt;
  assert.match(answeredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
});
