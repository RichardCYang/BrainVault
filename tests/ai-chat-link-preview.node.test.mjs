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

test("AI read mode turns only paragraph-end numeric HTTP(S) citations into compact domain/favicon chips", async () => {
  const sourceUrl = "https://docs.github.com/en/get-started/start-your-journey";
  const ordinaryUrl = "https://google.com/search?q=test";
  const content = createDomElement("div");
  const citationParagraph = createDomElement("p");
  citationParagraph.append(createDomText("Claim "));
  const referenceLink = createDomElement("a");
  referenceLink.href = sourceUrl;
  referenceLink.textContent = "1";
  citationParagraph.append(referenceLink, createDomText("."));

  const ordinaryParagraph = createDomElement("p");
  ordinaryParagraph.append(createDomText("Read "));
  const ordinaryLink = createDomElement("a");
  ordinaryLink.href = ordinaryUrl;
  ordinaryLink.textContent = "Google search";
  ordinaryParagraph.append(ordinaryLink, createDomText(" for details."));
  content.append(citationParagraph, ordinaryParagraph);

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

  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async (url) => {
      requests += 1;
      if (url === sourceUrl) return { title: "GitHub Docs", faviconUrl: faviconDataUrl };
      throw new Error(`Unexpected preview URL: ${url}`);
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const citation = citationParagraph.querySelector(".rendered-ai-chat-link-preview");
    assert.ok(citation);
    assert.equal(requests, 1);
    assert.equal(citation.tagName, "BUTTON");
    assert.equal(citation.dataset.aiChatLinkUrl, sourceUrl);
    assert.equal(citation.dataset.aiChatLinkDomain, "github");
    assert.equal(citation.dataset.aiChatLinkTitle, "GitHub Docs");
    assert.equal(citation.dataset.aiChatLinkPreviewState, "loaded");
    assert.equal(citation.dataset.aiChatReference, "1");
    assert.equal(citation.children[1].className, "rendered-ai-chat-link-domain");
    assert.equal(citation.children[1].textContent, "github");
    assert.equal(citation.children[0].children[0]?.src, faviconDataUrl);

    // Ordinary Markdown links must stay ordinary highlighted anchors. They are
    // neither replaced with a chip nor sent through the URL-preview request.
    assert.equal(ordinaryLink.isConnected, true);
    assert.equal(ordinaryLink.parentElement, ordinaryParagraph);
    assert.equal(ordinaryLink.href, ordinaryUrl);
    assert.equal(ordinaryParagraph.querySelectorAll(".rendered-ai-chat-link-preview").length, 0);

    citation.dispatch("click");
    const popover = body.children.find((child) => child.className === "rendered-ai-chat-link-tooltip");
    assert.ok(popover);
    assert.equal(popover.hidden, false);
    assert.equal(citation.getAttribute("aria-expanded"), "true");
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

test("citation chips handle bracketed references and country-code domains while named links stay ordinary", async () => {
  const sourceUrl = "https://news.example.co.kr/article/1";
  const namedUrl = "https://developer.mozilla.org/en-US/docs/Web/API/URL";
  const content = createDomElement("div");

  const citationParagraph = createDomElement("p");
  citationParagraph.append(createDomText("Claim "));
  const referenceLink = createDomElement("a");
  referenceLink.href = sourceUrl;
  referenceLink.textContent = "[2]";
  citationParagraph.append(referenceLink, createDomText("."));

  const namedParagraph = createDomElement("p");
  namedParagraph.append(createDomText("See "));
  const namedLink = createDomElement("a");
  namedLink.href = namedUrl;
  namedLink.textContent = "MDN URL docs";
  namedParagraph.append(namedLink, createDomText("."));

  const mailParagraph = createDomElement("p");
  const mailLink = createDomElement("a");
  mailLink.href = "mailto:hello@example.com";
  mailLink.textContent = "Email";
  mailParagraph.append(mailLink);
  content.append(citationParagraph, namedParagraph, mailParagraph);

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
  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async (url) => {
      requests += 1;
      return url === sourceUrl ? { title: "Example Korea", faviconUrl: "" } : null;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }

  const citation = citationParagraph.querySelector(".rendered-ai-chat-link-preview");
  assert.ok(citation);
  assert.equal(requests, 1);
  assert.equal(citation.dataset.aiChatLinkDomain, "example");
  assert.equal(citation.dataset.aiChatReference, "2");
  assert.equal(namedLink.isConnected, true);
  assert.equal(namedLink.parentElement, namedParagraph);
  assert.equal(namedLink.href, namedUrl);
  assert.equal(mailLink.isConnected, true);
  assert.equal(namedParagraph.querySelectorAll(".rendered-ai-chat-link-preview").length, 0);
});

test("AI read mode treats wrapper parentheses around a normalized numeric reference link as citation syntax", async () => {
  const sourceUrl = "https://docs.github.com/en/get-started";
  const content = createDomElement("div");
  const paragraph = createDomElement("p");
  paragraph.append(createDomText("Claim ("));
  const link = createDomElement("a");
  link.href = sourceUrl;
  link.textContent = "1";
  paragraph.append(link, createDomText(")."));
  content.append(paragraph);

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
    hydrateRenderedAiChatLinks(root, async () => ({ title: "GitHub Docs", faviconUrl: faviconDataUrl }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const chip = paragraph.querySelector(".rendered-ai-chat-link-preview");
    assert.ok(chip);
    assert.equal(chip.dataset.aiChatReference, "1");
    assert.equal(chip.dataset.aiChatLinkDomain, "github");
    assert.equal(chip.querySelector(".rendered-ai-chat-link-favicon").children[0]?.src, faviconDataUrl);
    assert.equal(paragraph.textContent, "Claim github.");
    assert.doesNotMatch(paragraph.textContent, /[()]/);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("AI read mode removes wrapper parentheses around a trailing named reference link only", async () => {
  const content = createDomElement("div");
  const trailingParagraph = createDomElement("p");
  trailingParagraph.append(createDomText("Claim ("));
  const trailingLink = createDomElement("a");
  trailingLink.href = "https://example.com/reference";
  trailingLink.textContent = "Reference title";
  trailingParagraph.append(trailingLink, createDomText(")."));

  const middleParagraph = createDomElement("p");
  middleParagraph.append(createDomText("See ("));
  const middleLink = createDomElement("a");
  middleLink.href = "https://example.org/details";
  middleLink.textContent = "Details";
  middleParagraph.append(middleLink, createDomText(") for context."));
  content.append(trailingParagraph, middleParagraph);

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

  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async () => {
      requests += 1;
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.equal(requests, 0);
    assert.equal(trailingParagraph.textContent, "Claim Reference title.");
    assert.equal(trailingLink.isConnected, true);
    assert.equal(trailingLink.parentElement, trailingParagraph);
    assert.equal(middleParagraph.textContent, "See (Details) for context.");
    assert.equal(middleLink.isConnected, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});


test("plain [1] and grouped [2, 13] markers receive relocated source chips instead of leaving chips at the Markdown tail", async () => {
  const content = createDomElement("div");
  const firstClaim = appendText(createDomElement("p"), "First claim ([1]).");
  const groupedClaim = appendText(createDomElement("p"), "Grouped claim ([2, 13]).");
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
    assert.deepEqual(groupedChips.map((chip) => chip.dataset.aiChatReference), ["2"]);
    assert.equal(firstChips[0].dataset.aiChatLinkDomain, "github");
    assert.equal(groupedChips[0].dataset.aiChatLinkDomain, "mozilla");
    assert.equal(groupedChips[0].dataset.aiChatReferences, "2,13");
    assert.deepEqual(
      groupedChips[0].aiChatCitationSources.map((source) => [source.referenceNumber, source.domain]),
      [["2", "mozilla"], ["13", "example"]]
    );
    assert.doesNotMatch(firstClaim.textContent, /\[1\]/);
    assert.doesNotMatch(groupedClaim.textContent, /\[2,\s*13\]/);
    assert.doesNotMatch(firstClaim.textContent, /[()]/);
    assert.doesNotMatch(groupedClaim.textContent, /[()]/);
    assert.equal(firstClaim.textContent, "First claim github.");
    assert.equal(groupedClaim.textContent, "Grouped claim mozilla.");

    groupedChips[0].dispatch("click");
    const popover = body.children.find((child) => child.className === "rendered-ai-chat-link-tooltip");
    assert.ok(popover);
    const navigation = popover.querySelector(".rendered-ai-chat-link-tooltip-navigation");
    const counter = popover.querySelector(".rendered-ai-chat-link-tooltip-counter");
    const previousButton = popover.querySelector(".rendered-ai-chat-link-tooltip-nav--previous");
    const nextButton = popover.querySelector(".rendered-ai-chat-link-tooltip-nav--next");
    assert.equal(popover.children[0].href, "https://developer.mozilla.org/en-US/docs/Web/API/URL");
    assert.equal(counter.textContent, "1 / 2");
    assert.equal(navigation.hidden, false);
    assert.equal(previousButton.disabled, true);
    assert.equal(nextButton.disabled, false);

    nextButton.dispatch("click");
    assert.equal(popover.children[0].href, "https://news.example.co.kr/article/13");
    assert.equal(popover.children[0].textContent, "news.example.co.kr");
    assert.equal(counter.textContent, "2 / 2");
    assert.equal(previousButton.disabled, false);
    assert.equal(nextButton.disabled, true);

    previousButton.dispatch("click");
    assert.equal(popover.children[0].href, "https://developer.mozilla.org/en-US/docs/Web/API/URL");
    assert.equal(counter.textContent, "1 / 2");

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

test("grouped [1, 2, 3] sources render one representative chip and remove the exhausted source section", async () => {
  const content = createDomElement("div");
  const claim = appendText(createDomElement("p"), "Claim [1, 2, 3].");
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
  const thirdItem = createDomElement("li");
  const thirdLink = createDomElement("a");
  thirdLink.href = "https://developer.mozilla.org/en-US/docs/Web/API/URL";
  thirdLink.textContent = "MDN URL";
  thirdItem.append(thirdLink);
  list.append(firstItem, secondItem, thirdItem);
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
    assert.deepEqual(chips.map((chip) => chip.dataset.aiChatReference), ["1"]);
    assert.equal(chips[0].dataset.aiChatReferences, "1,2,3");
    assert.equal(chips[0].dataset.aiChatLinkTitle, "OpenAI Research");
    assert.deepEqual(
      chips[0].aiChatCitationSources.map((source) => source.title),
      ["OpenAI Research", "NASA Missions", "MDN URL"]
    );
    assert.equal(heading.isConnected, false);
    assert.equal(list.isConnected, false);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("read mode removes duplicate numeric markers that trail an already-rendered citation chip", async () => {
  const content = createDomElement("div");

  const single = createDomElement("p");
  single.append(createDomText("Single "));
  const singleLink = createDomElement("a");
  singleLink.href = "https://docs.github.com/en/get-started";
  singleLink.textContent = "1";
  single.append(singleLink, createDomText(" [1]."));

  const grouped = createDomElement("p");
  grouped.append(createDomText("Grouped "));
  const firstLink = createDomElement("a");
  firstLink.href = "https://developer.mozilla.org/en-US/docs/Web/API/URL";
  firstLink.textContent = "1";
  const secondLink = createDomElement("a");
  secondLink.href = "https://news.example.co.kr/article/2";
  secondLink.textContent = "2";
  grouped.append(firstLink, createDomText(" "), secondLink, createDomText(" [1, 2]."));
  content.append(single, grouped);

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
    hydrateRenderedAiChatLinks(root, async () => ({ title: "Preview", faviconUrl: "" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    assert.deepEqual(
      single.querySelectorAll(".rendered-ai-chat-link-preview").map((chip) => chip.dataset.aiChatReference),
      ["1"]
    );
    assert.deepEqual(
      grouped.querySelectorAll(".rendered-ai-chat-link-preview").map((chip) => chip.dataset.aiChatReference),
      ["1", "2"]
    );
    assert.equal(single.textContent, "Single github.");
    assert.equal(grouped.textContent, "Grouped mozilla example.");
    assert.doesNotMatch(single.textContent, /\[1\]/);
    assert.doesNotMatch(grouped.textContent, /\[(?:1|2|1,\s*2)\]/);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("source-only Markdown links stay ordinary when there is no paragraph-end inline citation marker", async () => {
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

  let requests = 0;
  try {
    hydrateRenderedAiChatLinks(root, async () => {
      requests += 1;
      return null;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const chips = list.querySelectorAll(".rendered-ai-chat-link-preview");
    assert.equal(chips.length, 0);
    assert.equal(requests, 0);
    assert.equal(link.isConnected, true);
    assert.equal(link.parentElement, item);
    assert.equal(heading.isConnected, true);
    assert.equal(list.isConnected, true);
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalIntersectionObserver === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = originalIntersectionObserver;
  }
});

test("numeric citation links in the middle of prose stay ordinary while paragraph-end citations become chips", async () => {
  const content = createDomElement("div");
  const paragraph = createDomElement("p");
  paragraph.append(createDomText("Middle "));
  const middleCitationLikeLink = createDomElement("a");
  middleCitationLikeLink.href = "https://example.com/middle";
  middleCitationLikeLink.textContent = "1";
  paragraph.append(middleCitationLikeLink, createDomText(" continues; final "));
  const finalCitationLink = createDomElement("a");
  finalCitationLink.href = "https://example.org/final";
  finalCitationLink.textContent = "2";
  paragraph.append(finalCitationLink, createDomText("."));
  content.append(paragraph);

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

  const requestedUrls = [];
  try {
    hydrateRenderedAiChatLinks(root, async (url) => {
      requestedUrls.push(url);
      return { title: "Preview", faviconUrl: "" };
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const chips = paragraph.querySelectorAll(".rendered-ai-chat-link-preview");
    assert.equal(chips.length, 1);
    assert.equal(chips[0].dataset.aiChatReference, "2");
    assert.deepEqual(requestedUrls, ["https://example.org/final"]);
    assert.equal(middleCitationLikeLink.isConnected, true);
    assert.equal(middleCitationLikeLink.parentElement, paragraph);
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
