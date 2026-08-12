import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isRedditBookmarkUrl } from "../src/lib/reddit-bookmark.ts";

const bookmarkSource = readFileSync(new URL("../src/lib/bookmark.ts", import.meta.url), "utf8");

test("Reddit bookmark detection is restricted to Reddit-owned hostnames", () => {
  assert.equal(isRedditBookmarkUrl("https://www.reddit.com/r/webdev/comments/abc123/example/"), true);
  assert.equal(isRedditBookmarkUrl("https://old.reddit.com/r/webdev/comments/abc123/example/"), true);
  assert.equal(isRedditBookmarkUrl("https://redd.it/abc123"), true);
  assert.equal(isRedditBookmarkUrl("https://reddit.com.evil.example/r/webdev/comments/abc123/example/"), false);
  assert.equal(isRedditBookmarkUrl("https://evilreddit.com/r/webdev/comments/abc123/example/"), false);
});

test("Reddit OpenGraph fetches use a social crawler User-Agent and skip oEmbed", () => {
  assert.match(bookmarkSource, /const redditBookmarkUserAgent = "Twitterbot\/1\.0";/);
  assert.match(bookmarkSource, /return isRedditBookmarkUrl\(url\) \? redditBookmarkUserAgent : defaultBookmarkUserAgent;/);
  assert.match(bookmarkSource, /"User-Agent": bookmarkFetchUserAgent\(url\)/);
  assert.doesNotMatch(bookmarkSource, /reddit\.com\/oembed|fetchRedditOEmbedPreview|fetchJson\(/i);
});

test("generic bookmark OpenGraph fetches keep the BrainVault browser User-Agent", () => {
  assert.match(bookmarkSource, /const defaultBookmarkUserAgent = "[^"]*BrainVault\/1\.0";/);
});
