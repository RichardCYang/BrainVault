import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { normalizeAiChatMetadata } from "../src/lib/ai-chat.ts";
import {
  assertStructuredBlockMetadataIntegrity,
  StructuredMetadataIntegrityError
} from "../src/lib/structured-metadata-integrity.ts";

const original = {
  aiChat: {
    provider: "chatgpt",
    model: "gpt-test",
    answeredAt: "2026-07-30T09:28",
    question: "reproduction",
    answer: "A".repeat(12_001)
  }
};

// This is the exact destructive projection used by the pre-fix save path.
const oldStored = normalizeAiChatMetadata(original);
assert.equal(original.aiChat.answer.length, 12_001);
assert.equal(oldStored.aiChat.answer.length, 12_000);

let rejectedPath = "";
try {
  assertStructuredBlockMetadataIntegrity("AI_CHAT", original);
} catch (error) {
  if (!(error instanceof StructuredMetadataIntegrityError)) throw error;
  rejectedPath = error.path;
}
assert.equal(rejectedPath, "metadata.aiChat.answer");

const blockRoute = await readFile(new URL("../src/routes/block.routes.ts", import.meta.url), "utf8");
const collaborationRoute = await readFile(new URL("../src/routes/collaboration.routes.ts", import.meta.url), "utf8");
assert.ok(!blockRoute.includes("normalizeAiChatMetadata(metadata)"));
assert.ok(!collaborationRoute.includes("normalizeAiChatMetadata(metadata)"));

console.log(JSON.stringify({
  vulnerability: {
    originalCharacters: original.aiChat.answer.length,
    oldStoredCharacters: oldStored.aiChat.answer.length,
    silentlyLostCharacters: original.aiChat.answer.length - oldStored.aiChat.answer.length
  },
  fixedBehavior: {
    rejectedBeforeWrite: true,
    rejectedPath,
    authoritativeMetadataIsNoLongerReplacedByTheProjection: true
  }
}, null, 2));
