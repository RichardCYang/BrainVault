import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { hydrateRenderedAiChatLinks } from "../public/ai-chat-block.js";

const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const styles = readFileSync(new URL("../public/styles.css", import.meta.url), "utf8");
const faviconDataUrl = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9WlR0y8AAAAASUVORK5CYII=";

function createClassList() {
  const values = new Set();
  return {
    add(...items) { items.forEach((item) => values.add(item)); },
    remove(...items) { items.forEach((item) => values.delete(item)); },
    contains(item) { return values.has(item); }
  };
}

function createElement(tagName) {
  return {
    tagName,
    className: "",
    classList: createClassList(),
    textContent: "",
    children: [],
    setAttribute() {},
    addEventListener() {},
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); }
  };
}

test("AI answer links become title/favicon links without changing their destination", async () => {
  const sourceUrl = "https://example.com/docs/start?item=1#section";
  const link = {
    href: sourceUrl,
    textContent: sourceUrl,
    dataset: {},
    classList: createClassList(),
    isConnected: true,
    children: [],
    replaceChildren(...children) { this.children = children; },
    querySelector(selector) {
      if (selector === ".rendered-ai-chat-link-favicon") return this.children[0] ?? null;
      if (selector === ".rendered-ai-chat-link-title") return this.children[1] ?? null;
      return null;
    }
  };
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, ".rendered-ai-chat-answer .rendered-ai-chat-content a[href]");
      return [link];
    }
  };

  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = { createElement };
  delete globalThis.IntersectionObserver;

  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async (url) => {
      requests += 1;
      assert.equal(url, sourceUrl);
      return { title: "Example Documentation", faviconUrl: faviconDataUrl };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }

  assert.equal(requests, 1);
  assert.equal(link.href, sourceUrl);
  assert.equal(link.target, "_blank");
  assert.equal(link.rel, "noopener noreferrer");
  assert.equal(link.referrerPolicy, "no-referrer");
  assert.equal(link.dataset.aiChatLinkPreviewState, "loaded");
  assert.equal(link.children[1].textContent, "Example Documentation");
  assert.equal(link.children[0].children[0]?.src, faviconDataUrl);
});

test("read mode hydrates AI answer links through the existing secured URL preview API", () => {
  assert.match(appSource, /hydrateRenderedAiChatLinks\(row, fetchDatabaseUrlPreview\)/);
  assert.match(appSource, /hydrateRenderedAiChatLinks\(preview, fetchDatabaseUrlPreview\)/);
  assert.match(appSource, /body: \{ url, mode: "database-url" \}/);
  assert.match(styles, /\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-ai-chat-link-preview\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-favicon img\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-title\s*\{/);
});
