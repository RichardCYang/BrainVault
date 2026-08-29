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


function createDomClassList(element) {
  return {
    add(...items) {
      const values = new Set(String(element.className || "").split(/\s+/).filter(Boolean));
      items.forEach((item) => values.add(item));
      element.className = [...values].join(" ");
    },
    remove(...items) {
      const remove = new Set(items);
      element.className = String(element.className || "").split(/\s+/).filter((item) => item && !remove.has(item)).join(" ");
    },
    contains(item) {
      return String(element.className || "").split(/\s+/).includes(item);
    }
  };
}

function connectDomNode(node, connected) {
  node.isConnected = connected;
  for (const child of node.childNodes ?? []) connectDomNode(child, connected);
}

function appendDomNodes(parent, nodes) {
  for (const node of nodes) {
    if (!node) continue;
    if (node.nodeType === 11) {
      const children = [...node.childNodes];
      node.childNodes.length = 0;
      appendDomNodes(parent, children);
      continue;
    }
    if (node.parentNode) node.remove?.();
    node.parentNode = parent;
    parent.childNodes.push(node);
    connectDomNode(node, parent.isConnected !== false);
  }
}

function replaceDomNode(node, replacements) {
  const parent = node.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(node);
  if (index < 0) return;
  const flattened = [];
  for (const replacement of replacements) {
    if (!replacement) continue;
    if (replacement.nodeType === 11) flattened.push(...replacement.childNodes);
    else flattened.push(replacement);
  }
  parent.childNodes.splice(index, 1, ...flattened);
  node.parentNode = null;
  connectDomNode(node, false);
  flattened.forEach((replacement) => {
    replacement.parentNode = parent;
    connectDomNode(replacement, parent.isConnected !== false);
  });
}

function createDomText(value) {
  const node = {
    nodeType: 3,
    nodeValue: String(value),
    parentNode: null,
    isConnected: true,
    get textContent() { return this.nodeValue; },
    set textContent(next) { this.nodeValue = String(next); },
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; },
    get previousSibling() {
      const siblings = this.parentNode?.childNodes ?? [];
      const index = siblings.indexOf(this);
      return index > 0 ? siblings[index - 1] : null;
    },
    replaceWith(...nodes) { replaceDomNode(this, nodes); },
    remove() { replaceDomNode(this, []); }
  };
  return node;
}

function createDomFragment() {
  return {
    nodeType: 11,
    childNodes: [],
    parentNode: null,
    isConnected: true,
    append(...nodes) { appendDomNodes(this, nodes); }
  };
}

function createDomElement(tagName) {
  const attributes = new Map();
  const listeners = new Map();
  const element = {
    nodeType: 1,
    tagName: String(tagName).toUpperCase(),
    className: "",
    dataset: {},
    style: {},
    childNodes: [],
    parentNode: null,
    isConnected: true,
    hidden: false,
    setAttribute(name, value) { attributes.set(name, String(value)); },
    getAttribute(name) { return attributes.get(name) ?? null; },
    addEventListener(name, listener) { listeners.set(name, listener); },
    append(...nodes) { appendDomNodes(this, nodes); },
    replaceChildren(...nodes) {
      this.childNodes.forEach((child) => { child.parentNode = null; connectDomNode(child, false); });
      this.childNodes.length = 0;
      appendDomNodes(this, nodes);
    },
    replaceWith(...nodes) { replaceDomNode(this, nodes); },
    remove() { replaceDomNode(this, []); },
    querySelectorAll(selector) {
      const matches = [];
      const visit = (node) => {
        for (const child of node.childNodes ?? []) {
          if (child.nodeType !== 1) continue;
          const isAnchor = selector === "a[href]" && child.tagName === "A" && Boolean(child.getAttribute("href") ?? child.href);
          const className = selector.startsWith(".") ? selector.slice(1) : "";
          const isClass = className && child.classList.contains(className);
          if (isAnchor || isClass) matches.push(child);
          visit(child);
        }
      };
      visit(this);
      return matches;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; },
    contains(target) {
      if (target === this) return true;
      return this.childNodes.some((child) => child === target || child.contains?.(target));
    },
    getBoundingClientRect() { return { left: 20, right: 120, top: 20, bottom: 44, width: 100, height: 24 }; },
    dispatch(name, event = {}) { listeners.get(name)?.({ preventDefault() {}, target: this, ...event }); },
    get children() { return this.childNodes.filter((child) => child.nodeType === 1); },
    get parentElement() { return this.parentNode?.nodeType === 1 ? this.parentNode : null; },
    get previousSibling() {
      const siblings = this.parentNode?.childNodes ?? [];
      const index = siblings.indexOf(this);
      return index > 0 ? siblings[index - 1] : null;
    },
    get nextElementSibling() {
      const siblings = this.parentElement?.children ?? [];
      const index = siblings.indexOf(this);
      return index >= 0 ? siblings[index + 1] ?? null : null;
    },
    get textContent() { return this.childNodes.map((child) => child.textContent ?? "").join(""); },
    set textContent(value) {
      this.childNodes.forEach((child) => { child.parentNode = null; connectDomNode(child, false); });
      this.childNodes.length = 0;
      appendDomNodes(this, [createDomText(value)]);
    }
  };
  element.classList = createDomClassList(element);
  Object.defineProperty(element, "href", {
    get() { return attributes.get("href") ?? ""; },
    set(value) { attributes.set("href", String(value)); }
  });
  return element;
}

function appendText(element, value) {
  element.append(createDomText(value));
  return element;
}

function appendSourceLine(content, referenceNumber, href, label, prefix = "") {
  const paragraph = createDomElement("p");
  paragraph.append(createDomText(`[${referenceNumber}] ${prefix}`));
  const link = createDomElement("a");
  link.href = href;
  link.textContent = label;
  paragraph.append(link);
  content.append(paragraph);
  return paragraph;
}

test("AI read mode turns HTTP(S) Markdown links into compact domain/favicon citations", async () => {
  const sourceUrl = "https://docs.github.com/en/get-started/start-your-journey";
  const referenceLink = createMarkdownLink({ href: sourceUrl, textContent: "1" });
  const ordinaryLink = createMarkdownLink({ href: "https://google.com/search?q=test", textContent: "Google search" });
  const root = {
    querySelectorAll(selector) {
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content") return [];
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
      if (url === sourceUrl) return { title: "GitHub Docs", faviconUrl: faviconDataUrl };
      if (url === ordinaryLink.href) return { title: "Google", faviconUrl: "" };
      throw new Error(`Unexpected preview URL: ${url}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const citation = referenceLink.replacement;
    const ordinaryCitation = ordinaryLink.replacement;
    assert.ok(citation);
    assert.ok(ordinaryCitation);
    assert.equal(requests, 2);
    assert.equal(citation.tagName, "button");
    assert.equal(citation.dataset.aiChatLinkUrl, sourceUrl);
    assert.equal(citation.dataset.aiChatLinkDomain, "github");
    assert.equal(citation.dataset.aiChatLinkTitle, "GitHub Docs");
    assert.equal(citation.dataset.aiChatLinkPreviewState, "loaded");
    assert.equal(citation.children[1].className, "rendered-ai-chat-link-domain");
    assert.equal(citation.children[1].textContent, "github");
    assert.equal(citation.children[0].children[0]?.src, faviconDataUrl);
    assert.equal(ordinaryCitation.dataset.aiChatLinkDomain, "google");
    assert.equal(ordinaryCitation.dataset.aiChatLinkTitle, "Google");
    assert.equal(ordinaryCitation.children[1].textContent, "google");

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

test("citation chips handle bracketed references, named links, and country-code domains", async () => {
  const sourceUrl = "https://news.example.co.kr/article/1";
  const referenceLink = createMarkdownLink({ href: sourceUrl, textContent: "[2]" });
  const namedLink = createMarkdownLink({ href: "https://developer.mozilla.org/en-US/docs/Web/API/URL", textContent: "MDN URL docs" });
  const mailLink = createMarkdownLink({ href: "mailto:hello@example.com", textContent: "Email" });
  const root = { querySelectorAll: () => [referenceLink, namedLink, mailLink] };

  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = { createElement };
  delete globalThis.IntersectionObserver;
  try {
    hydrateRenderedAiChatLinks(root, async (url) => (
      url === sourceUrl ? { title: "Example Korea", faviconUrl: "" } : null
    ));
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }

  assert.equal(referenceLink.replacement?.dataset?.aiChatLinkDomain, "example");
  assert.equal(referenceLink.replacement?.dataset?.aiChatReference, "2");
  assert.equal(namedLink.replacement?.dataset?.aiChatLinkDomain, "mozilla");
  assert.equal(namedLink.replacement?.dataset?.aiChatLinkTitle, "MDN URL docs");
  assert.equal(namedLink.replacement?.dataset?.aiChatReference, undefined);
  assert.equal(mailLink.replacement, null);
});


test("plain [1] and grouped [2, 13] markers receive relocated source chips instead of leaving chips at the Markdown tail", async () => {
  const content = createDomElement("div");
  const firstClaim = appendText(createDomElement("p"), "First claim [1].");
  const groupedClaim = appendText(createDomElement("p"), "Grouped claim [2, 13].");
  content.append(firstClaim, groupedClaim);

  const sourceOne = appendSourceLine(content, "1", "https://docs.github.com/en/get-started", "GitHub Docs");
  const sourceTwo = appendSourceLine(content, "2", "https://developer.mozilla.org/en-US/docs/Web/API/URL", "MDN URL");
  const sourceThirteen = appendSourceLine(
    content,
    "13",
    "https://news.example.co.kr/article/13",
    "https://news.example.co.kr/article/13",
    "Example Korea — "
  );
  const root = {
    querySelectorAll(selector) {
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content") return [content];
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content a[href]") return content.querySelectorAll("a[href]");
      return [];
    }
  };

  const body = createDomElement("body");
  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = {
    createElement: createDomElement,
    createTextNode: createDomText,
    createDocumentFragment: createDomFragment,
    body,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    addEventListener() {}
  };
  delete globalThis.IntersectionObserver;

  try {
    hydrateRenderedAiChatLinks(root, async (url) => ({
      title: `Preview ${new URL(url).hostname}`,
      faviconUrl: ""
    }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const firstChips = firstClaim.querySelectorAll(".rendered-ai-chat-link-preview");
    const groupedChips = groupedClaim.querySelectorAll(".rendered-ai-chat-link-preview");
    assert.deepEqual(firstChips.map((chip) => chip.dataset.aiChatReference), ["1"]);
    assert.deepEqual(groupedChips.map((chip) => chip.dataset.aiChatReference), ["2", "13"]);
    assert.equal(firstChips[0].dataset.aiChatLinkDomain, "github");
    assert.equal(groupedChips[0].dataset.aiChatLinkDomain, "mozilla");
    assert.equal(groupedChips[1].dataset.aiChatLinkDomain, "example");
    assert.doesNotMatch(firstClaim.textContent, /\[1\]/);
    assert.doesNotMatch(groupedClaim.textContent, /\[2,\s*13\]/);

    assert.equal(sourceOne.isConnected, false);
    assert.equal(sourceTwo.isConnected, false);
    assert.equal(sourceThirteen.isConnected, false);
    assert.equal(content.querySelectorAll("a[href]").length, 0);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("named links under a Sources heading are mapped by source order and the exhausted tail section is removed", async () => {
  const content = createDomElement("div");
  const claim = appendText(createDomElement("p"), "Claim [1] and [2].");
  const heading = appendText(createDomElement("h3"), "Sources");
  const list = createDomElement("ul");
  const firstItem = createDomElement("li");
  const firstLink = createDomElement("a");
  firstLink.href = "https://openai.com/research";
  firstLink.textContent = "OpenAI Research";
  firstItem.append(firstLink);
  const secondItem = createDomElement("li");
  const secondLink = createDomElement("a");
  secondLink.href = "https://www.nasa.gov/mission-pages";
  secondLink.textContent = "NASA Missions";
  secondItem.append(secondLink);
  list.append(firstItem, secondItem);
  content.append(claim, heading, list);

  const root = {
    querySelectorAll(selector) {
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content") return [content];
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content a[href]") return content.querySelectorAll("a[href]");
      return [];
    }
  };
  const body = createDomElement("body");
  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = {
    createElement: createDomElement,
    createTextNode: createDomText,
    createDocumentFragment: createDomFragment,
    body,
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    addEventListener() {}
  };
  delete globalThis.IntersectionObserver;

  try {
    hydrateRenderedAiChatLinks(root, async () => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const chips = claim.querySelectorAll(".rendered-ai-chat-link-preview");
    assert.deepEqual(chips.map((chip) => chip.dataset.aiChatReference), ["1", "2"]);
    assert.equal(chips[0].dataset.aiChatLinkTitle, "OpenAI Research");
    assert.equal(chips[1].dataset.aiChatLinkTitle, "NASA Missions");
    assert.equal(heading.isConnected, false);
    assert.equal(list.isConnected, false);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("source-only Markdown links keep the existing bottom chip behavior when there is no inline citation marker", async () => {
  const content = createDomElement("div");
  const heading = appendText(createDomElement("h3"), "Sources");
  const list = createDomElement("ul");
  const item = createDomElement("li");
  const link = createDomElement("a");
  link.href = "https://example.com/source";
  link.textContent = "Example Source";
  item.append(link);
  list.append(item);
  content.append(heading, list);

  const root = {
    querySelectorAll(selector) {
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content") return [content];
      if (selector === ".rendered-ai-chat-answer .rendered-ai-chat-content a[href]") return content.querySelectorAll("a[href]");
      return [];
    }
  };
  const originalDocument = globalThis.document;
  const originalIntersectionObserver = globalThis.IntersectionObserver;
  globalThis.document = {
    createElement: createDomElement,
    createTextNode: createDomText,
    createDocumentFragment: createDomFragment,
    body: createDomElement("body"),
    documentElement: { clientWidth: 1280, clientHeight: 720 },
    addEventListener() {}
  };
  delete globalThis.IntersectionObserver;

  try {
    hydrateRenderedAiChatLinks(root, async () => null);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const chips = list.querySelectorAll(".rendered-ai-chat-link-preview");
    assert.equal(chips.length, 1);
    assert.equal(chips[0].dataset.aiChatLinkDomain, "example");
    assert.equal(heading.isConnected, true);
    assert.equal(list.isConnected, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
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
