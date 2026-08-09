import { describe, expect, it } from "vitest";
import { getTwemojiAssetKey } from "../public/emoji-renderer.js";

describe("Twemoji asset keys", () => {
  it("matches Twemoji asset naming for standalone, keycap, ZWJ, modifier, and tag sequences", () => {
    expect(getTwemojiAssetKey("❤️")).toBe("2764");
    expect(getTwemojiAssetKey("👩🏻‍🐰‍👩🏾")).toBe("1f469-1f3fb-200d-1f430-200d-1f469-1f3fe");
    expect(getTwemojiAssetKey("🧑🏻‍🫯‍🧑🏼")).toBe("1f9d1-1f3fb-200d-1faef-200d-1f9d1-1f3fc");
    expect(getTwemojiAssetKey("🏳️‍🌈")).toBe("1f3f3-fe0f-200d-1f308");
    expect(getTwemojiAssetKey("👩‍⚕️")).toBe("1f469-200d-2695-fe0f");
    expect(getTwemojiAssetKey("#️⃣")).toBe("23-20e3");
  });
});
