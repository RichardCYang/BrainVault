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
  const listeners = new Map();
  const attributes = new Map();
  const element = {
    tagName,
    className: "",
    classList: createClassList(),
    dataset: {},
    style: {},
    textContent: "",
    children: [],
    hidden: false,
    isConnected: true,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    querySelector(selector) {
      const className = selector.startsWith(".") ? selector.slice(1) : "";
      return this.children.find((child) => String(child.className || "").split(/\s+/).includes(className)) ?? null;
    },
    contains(target) { return target === this || this.children.includes(target); },
    getBoundingClientRect() { return { left: 20, right: 120, top: 20, bottom: 44, width: 100, height: 24 }; },
    dispatch(name, event = {}) { listeners.get(name)?.({ preventDefault() {}, target: this, ...event }); }
  };
  Object.defineProperty(element, "ariaExpanded", {
    get() { return attributes.get("aria-expanded"); }
  });
  return element;
}

function createMarkdownLink({ href, textContent }) {
  return {
    href,
    textContent,
    replacement: null,
    replaceWith(node) { this.replacement = node; }
  };
}

test("AI read mode turns only numeric Markdown references into compact domain/favicon citations", async () => {
  const sourceUrl = "https://docs.github.com/en/get-started/start-your-journey";
  const referenceLink = createMarkdownLink({ href: sourceUrl, textContent: "1" });
  const ordinaryLink = createMarkdownLink({ href: "https://google.com/search?q=test", textContent: "Google search" });
  const root = {
    querySelectorAll(selector) {
      assert.equal(selector, ".rendered-ai-chat-answer .rendered-ai-chat-content a[href]");
      return [referenceLink, ordinaryLink];
    }
  };

  const body = createElement("body");
  body.append = (...children) => {
    children.forEach((child) => { child.isConnected = true; });
    body.children.push(...children);
  };
  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = {
    createElement,
    body,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    addEventListener() {}
  };
  delete globalThis.IntersectionObserver;

  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async (url) => {
      requests += 1;
      assert.equal(url, sourceUrl);
      return { title: "GitHub Docs", faviconUrl: faviconDataUrl };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const citation = referenceLink.replacement;
    assert.ok(citation);
    assert.equal(ordinaryLink.replacement, null);
    assert.equal(requests, 1);
    assert.equal(citation.tagName, "button");
    assert.equal(citation.dataset.aiChatLinkUrl, sourceUrl);
    assert.equal(citation.dataset.aiChatLinkDomain, "github");
    assert.equal(citation.dataset.aiChatLinkTitle, "GitHub Docs");
    assert.equal(citation.dataset.aiChatLinkPreviewState, "loaded");
    assert.equal(citation.children[1].className, "rendered-ai-chat-link-domain");
    assert.equal(citation.children[1].textContent, "github");
    assert.equal(citation.children[0].children[0]?.src, faviconDataUrl);

    // The full title is intentionally absent from the inline chip. It appears
    // only after the citation is activated, and remains the actual source link.
    citation.dispatch("click");
    const popover = body.children.find((child) => child.className === "rendered-ai-chat-link-tooltip");
    assert.ok(popover);
    assert.equal(popover.hidden, false);
    assert.equal(citation.ariaExpanded, "true");
    assert.equal(popover.children[0].textContent, "GitHub Docs");
    assert.equal(popover.children[0].href, sourceUrl);
    assert.equal(popover.children[0].target, "_blank");
    assert.equal(popover.children[0].rel, "noopener noreferrer");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("citation chips handle bracketed references and country-code domains without touching ordinary links", async () => {
  const sourceUrl = "https://news.example.co.kr/article/1";
  const referenceLink = createMarkdownLink({ href: sourceUrl, textContent: "[2]" });
  const ordinaryLink = createMarkdownLink({ href: "https://example.com", textContent: "2 examples" });
  const root = { querySelectorAll: () => [referenceLink, ordinaryLink] };

  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = { createElement };
  delete globalThis.IntersectionObserver;
  try {
    hydrateRenderedAiChatLinks(root, async () => ({ title: "Example Korea", faviconUrl: "" }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }

  assert.equal(referenceLink.replacement?.dataset?.aiChatLinkDomain, "example");
  assert.equal(ordinaryLink.replacement, null);
});

test("read mode hydrates citation links through the existing secured URL preview API", () => {
  assert.match(appSource, /hydrateRenderedAiChatLinks\(row, fetchDatabaseUrlPreview\)/);
  assert.match(appSource, /hydrateRenderedAiChatLinks\(preview, fetchDatabaseUrlPreview\)/);
  assert.match(appSource, /body: \{ url, mode: "database-url" \}/);
  assert.match(appSource, /\.rendered-ai-chat-page, \.rendered-ai-chat-link-preview/);
  assert.match(styles, /\.page-view\.is-read-only \.rendered-ai-chat-answer \.rendered-ai-chat-link-preview\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-favicon img\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-domain\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-tooltip\s*\{/);
  assert.match(styles, /\.rendered-ai-chat-link-tooltip-title\s*\{/);
});
