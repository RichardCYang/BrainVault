import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  isRedditBookmarkUrl,
  parseRedditOEmbedPayload,
  redditBookmarkFaviconUrl
} from "../src/lib/reddit-bookmark.ts";

const bookmarkSource = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8");

test("Reddit bookmark detection is restricted to Reddit-owned hostnames", () => {
  assert.equal(isRedditBookmarkUrl("https://www.reddit.com/r/webdev/comments/abc123/example/"), true);
  assert.equal(isRedditBookmarkUrl("https://old.reddit.com/r/webdev/comments/abc123/example/"), true);
  assert.equal(isRedditBookmarkUrl("https://redd.it/abc123"), true);
  assert.equal(isRedditBookmarkUrl("https://reddit.com.evil.example/r/webdev/comments/abc123/example/"), false);
  assert.equal(isRedditBookmarkUrl("https://evilreddit.com/r/webdev/comments/abc123/example/"), false);
});

test("Reddit post oEmbed data produces a useful title and contextual description", () => {
  const preview = parseRedditOEmbedPayload(
    {
      author_name: "avitorio",
      provider_name: "reddit",
      title: "I built an open source content curation directory",
      thumbnail_url: "https://preview.redd.it/example.png"
    },
    "https://www.reddit.com/r/webdev/comments/1sowvc7/i_built_an_open_source_content_curation_directory/#fragment"
  );

  assert.deepEqual(preview, {
    url: "https://www.reddit.com/r/webdev/comments/1sowvc7/i_built_an_open_source_content_curation_directory/",
    title: "I built an open source content curation directory",
    description: "u/avitorio · r/webdev",
    imageUrl: "https://preview.redd.it/example.png",
    faviconUrl: redditBookmarkFaviconUrl,
    siteName: "Reddit"
  });
});

test("Reddit comment oEmbed data keeps the comment text as the description", () => {
  const preview = parseRedditOEmbedPayload(
    {
      author_name: "yankeltank",
      title: "We should start keeping giraffes a secret from young children."
    },
    "https://www.reddit.com/r/Showerthoughts/comments/2safxv/we_should_start_keeping_giraffes_a_secret_from/cno7zic"
  );

  assert.equal(preview?.title, "Reddit comment by u/yankeltank");
  assert.equal(preview?.description, "We should start keeping giraffes a secret from young children.");
  assert.equal(preview?.siteName, "Reddit");
});

test("non-Reddit URLs cannot be converted through the Reddit fallback parser", () => {
  assert.equal(
    parseRedditOEmbedPayload({ title: "Do not trust this" }, "https://example.com/reddit-looking-page"),
    null
  );
});

test("bookmark fetch wiring keeps the generic OpenGraph path and scopes oEmbed to Reddit failures", () => {
  assert.match(bookmarkSource, /if \(!isReddit\) \{\s*return fetchBookmarkPreviewFromHtml\(value, deadline\);/);
  assert.match(bookmarkSource, /return await fetchBookmarkPreviewFromHtml\(value, directDeadline\);/);
  assert.match(bookmarkSource, /if \(!shouldUseRedditOEmbedFallback\(directError\)\) throw directError;/);
  assert.match(bookmarkSource, /return await fetchRedditOEmbedPreview\(normalizedInput!, deadline\);/);
  assert.match(bookmarkSource, /https:\/\/www\.reddit\.com\/oembed/);
});

test("Reddit fallback identifies BrainVault instead of impersonating a third-party crawler", () => {
  assert.match(bookmarkSource, /User-Agent": "BrainVault\/1\.0 \(user-initiated bookmark preview; Reddit oEmbed\)"/);
  assert.doesNotMatch(bookmarkSource, /"User-Agent":\s*"[^"]*(?:Googlebot\/|facebookexternalhit\/|Discordbot\/)/i);
});
