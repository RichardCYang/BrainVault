import { describe, expect, it } from "vitest";
import {
  isValidIconValue,
  maxCustomIconBytes,
  normalizeIconValue
} from "../src/lib/icon-value.js";

const onePixelPng = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=";

describe("page and collection icon values", () => {
  it("preserves legacy emoji values and canonicalizes built-in icons", () => {
    expect(normalizeIconValue("🧠")).toBe("🧠");
    expect(normalizeIconValue(" ICON:Folder ")).toBe("icon:folder");
    expect(normalizeIconValue(null)).toBeNull();
  });

  it("accepts HTTP(S) image URLs and supported image data URLs", () => {
    expect(normalizeIconValue("image:https://example.com/note.png")).toBe(
      "image:https://example.com/note.png"
    );
    expect(normalizeIconValue(`image:${onePixelPng}`)).toBe(`image:${onePixelPng}`);
  });

  it("rejects unsafe schemes, unsupported formats, malformed images, and oversized uploads", () => {
    expect(isValidIconValue("image:javascript:alert(1)")).toBe(false);
    expect(isValidIconValue("image:https://user:secret@example.com/icon.png")).toBe(false);
    expect(isValidIconValue("image:data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
    expect(isValidIconValue("image:data:image/png;base64,AAAA")).toBe(false);
    const oversized = Buffer.alloc(maxCustomIconBytes + 1, 0);
    oversized.set(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(isValidIconValue(`image:data:image/png;base64,${oversized.toString("base64")}`)).toBe(false);
  });
});
