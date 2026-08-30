import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";

const originalAnswerLimit = process.env.AI_CHAT_ANSWER_MAX_LENGTH;
const originalNodeEnv = process.env.NODE_ENV;

async function resetAnswerLimitModules() {
  vi.resetModules();
  return Promise.all([
    import("../src/config/ai-chat-limits.js"),
    import("../src/lib/ai-chat.js"),
    import("../src/lib/structured-metadata-integrity.js")
  ]);
}

afterEach(() => {
  if (originalAnswerLimit === undefined) delete process.env.AI_CHAT_ANSWER_MAX_LENGTH;
  else process.env.AI_CHAT_ANSWER_MAX_LENGTH = originalAnswerLimit;
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
  vi.resetModules();
});

describe("AI chat answer Markdown limit", () => {
  it("defaults to 50,000 characters", async () => {
    process.env.AI_CHAT_ANSWER_MAX_LENGTH = "50000";
    const [config, aiChat, integrity] = await resetAnswerLimitModules();

    expect(config.AI_CHAT_ANSWER_MAX_LENGTH_DEFAULT).toBe(50_000);
    expect(config.aiChatAnswerMaxLengthSchema.parse(undefined)).toBe(50_000);
    expect(config.getAiChatAnswerMaxLength()).toBe(50_000);
    expect(aiChat.getAiChatData({ aiChat: { answer: "a".repeat(50_000) } }).turns[0].answer).toHaveLength(50_000);
    expect(() => integrity.assertStructuredBlockMetadataIntegrity("AI_CHAT", {
      aiChat: { answer: "a".repeat(50_001) }
    })).toThrow(/maximum is 50000/);
  });

  it("uses AI_CHAT_ANSWER_MAX_LENGTH as the shared server-side limit", async () => {
    process.env.AI_CHAT_ANSWER_MAX_LENGTH = "75000";
    const [config, aiChat, integrity] = await resetAnswerLimitModules();

    expect(config.getAiChatAnswerMaxLength()).toBe(75_000);
    expect(aiChat.getAiChatData({ aiChat: { answer: "a".repeat(75_001) } }).turns[0].answer).toHaveLength(75_000);
    expect(() => integrity.assertStructuredBlockMetadataIntegrity("AI_CHAT", {
      aiChat: { answer: "a".repeat(75_001) }
    })).toThrow(/maximum is 75000/);
  });

  it("serves the configured limit to the browser runtime module without caching it", async () => {
    process.env.NODE_ENV = "test";
    process.env.AI_CHAT_ANSWER_MAX_LENGTH = "64000";
    vi.resetModules();
    const { createApp } = await import("../src/app.js");
    const response = await request(createApp()).get("/runtime-config.js").expect(200);

    expect(response.headers["content-type"]).toMatch(/text\/javascript/);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.text).toBe("export const AI_CHAT_ANSWER_MAX_LENGTH = 64000;\n");
  });
});
