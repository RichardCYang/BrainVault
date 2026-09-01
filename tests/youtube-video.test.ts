import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderBlockHtml } from "../src/lib/markdown.js";
import { parseYouTubeVideoUrl } from "../src/lib/youtube.js";
import { parseYouTubeVideoUrl as parseClientYouTubeVideoUrl } from "../public/youtube-block.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const schema = readFileSync(new URL("../src/utils/schemas.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const migration = readFileSync(new URL("../migrations/031_blocks_video_type.sql", import.meta.url), "utf8");

const expectedId = "M7lc1UVf-VE";

const supportedUrls = [
  `https://www.youtube.com/watch?v=${expectedId}`,
  `https://youtu.be/${expectedId}`,
  `https://www.youtube.com/shorts/${expectedId}`,
  `https://www.youtube.com/live/${expectedId}`,
  `https://www.youtube.com/embed/${expectedId}`,
  `<iframe src="https://www.youtube.com/embed/${expectedId}"></iframe>`
];

describe("YouTube video block", () => {
  it.each(supportedUrls)("parses supported YouTube URL form: %s", (url) => {
    expect(parseYouTubeVideoUrl(url)?.videoId).toBe(expectedId);
    expect(parseClientYouTubeVideoUrl(url)?.videoId).toBe(expectedId);
  });

  it("preserves a bounded start time and uses privacy-enhanced embeds", () => {
    const parsed = parseYouTubeVideoUrl(`https://youtu.be/${expectedId}?t=1m30s`);
    expect(parsed?.startSeconds).toBe(90);
    expect(parsed?.embedUrl).toContain("https://www.youtube-nocookie.com/embed/");
    expect(parsed?.embedUrl).toContain("start=90");
    expect(parsed?.watchUrl).toContain("t=90s");
  });

  it("rejects non-YouTube and malformed video URLs", () => {
    expect(parseYouTubeVideoUrl(`https://example.com/watch?v=${expectedId}`)).toBeNull();
    expect(parseYouTubeVideoUrl("javascript:alert(1)")).toBeNull();
    expect(parseYouTubeVideoUrl("https://www.youtube.com/watch?v=bad")).toBeNull();
  });

  it("renders a sanitized responsive iframe", () => {
    const html = renderBlockHtml("VIDEO", `https://youtu.be/${expectedId}?t=45`);
    expect(html).toContain('class="youtube-video-iframe"');
    expect(html).toContain("www.youtube-nocookie.com/embed/M7lc1UVf-VE");
    expect(html).toContain("start=45");
    expect(html).toContain("allowfullscreen");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("removes unapproved iframes and non-checkbox input controls", () => {
    const html = renderBlockHtml(
      "MARKDOWN",
      '<iframe src="https://evil.example/embed"></iframe><input type="password"><input type="checkbox" checked disabled>'
    );
    expect(html).not.toContain("evil.example");
    expect(html).not.toContain("<iframe");
    expect(html).not.toContain('type="password"');
    expect(html).toContain('type="checkbox"');
  });

  it("registers UI, persistence, CSP, migration, and responsive styles", () => {
    expect(appSource).toContain('{ type: "VIDEO", command: "/video", icon: "video" }');
    expect(appSource).toContain("createYouTubeVideoEditor(block)");
    expect(appSource).toContain('row.dataset.blockType === "VIDEO"');
    expect(schema).toContain('"VIDEO"');
    expect(migration).toContain("'VIDEO'");
    expect(server).toContain('frameSrc: ["\'self\'", "data:", "https://www.youtube-nocookie.com", "https://www.youtube.com"]');
    expect(styles).toContain('.editor-block-row[data-block-type="VIDEO"]');
    expect(styles).toContain("min-height: 200px");
    expect(styles).toContain("aspect-ratio: 16 / 9");
  });
});
