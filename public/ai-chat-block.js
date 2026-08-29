import { formatDateTime, t } from "./i18n.js";

export const aiProviderPresets = Object.freeze([
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
  { id: "claude", label: "Claude" },
  { id: "deepseek", label: "DeepSeek" },
  { id: "grok", label: "Grok" }
]);

export const aiChatLayouts = Object.freeze(["stacked", "paginated"]);

export const aiChatLimits = Object.freeze({
  titleLength: 120,
  turns: 50,
  questionLength: 8_000,
  answerLength: 12_000,
  modelLength: 120
});

const providerById = new Map(aiProviderPresets.map((provider) => [provider.id, provider]));
const svgNamespace = "http://www.w3.org/2000/svg";

const aiChatLinkPreviewCache = new Map();
const aiChatLinkPreviewObservers = new WeakMap();
const aiChatLinkPreviewFaviconDataUrlMaxLength = Math.ceil((128 * 1024 * 4) / 3) + 128;
const aiChatLinkPreviewFaviconDataPattern = /^data:image\/(?:png|jpeg|gif|webp|vnd\.microsoft\.icon);base64,[a-z0-9+/]+={0,2}$/i;
const aiChatCountrySecondLevelDomains = new Set(["ac", "co", "com", "edu", "go", "gov", "net", "ne", "or", "org"]);
const aiChatCitationPopoverId = "rendered-ai-chat-citation-popover";
const aiChatCitationMarkerPattern = /\[\s*(\d{1,3}(?:\s*,\s*\d{1,3})*)\s*\]/g;
const aiChatCitationSourceHeadingPattern = /^(?:sources?|references?|citations?|source\s+links?|reference\s+links?|sources?\s*(?:&|and)\s*references?|출처(?:\s*(?:및|\/|&)\s*참고\s*자료)?|참고\s*(?:문헌|자료|링크)?|참조\s*(?:문헌|자료|링크)?)\s*[:：]?\s*$/i;
const aiChatCitationTextExcludedTags = new Set(["A", "BUTTON", "CODE", "PRE", "SCRIPT", "STYLE", "TEXTAREA"]);
const aiChatCitationBlockEndTags = new Set(["P", "LI"]);
const aiChatCitationTailMarkerPattern = /\[\s*\d{1,3}(?:\s*,\s*\d{1,3})*\s*\]/g;
const aiChatCitationTailSeparatorPattern = /^[\s,.;:!?…，。；：！？、(){}\[\]\'"“”‘’\-–—]*$/;
const aiChatCitationTailInlineTags = new Set(["SPAN", "EM", "STRONG", "S", "DEL", "SUP"]);
const aiChatReferenceWrapperPlaceholder = "\ufffc";
const aiChatReferenceWrapperBarrier = "\ufffd";
const aiChatReferenceWrapperPattern = /\(\s*\ufffc(?:[\s,;，；、]*\ufffc)*\s*\)([\s,.;:!?…，。；：！？、{}\[\]\'"“”‘’\-–—]*)$/;
let activeAiChatCitation = null;
let aiChatCitationPopover = null;
let aiChatCitationPopoverEventsBound = false;

function getAiChatWebUrl(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) return null;
  try {
    const url = globalThis.location?.href ? new URL(raw, globalThis.location.href) : new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function getAiChatReferenceNumber(link) {
  const label = typeof link?.textContent === "string" ? link.textContent.trim().replace(/\s+/g, "") : "";
  const match = label.match(/^(?:\[(\d{1,3})\]|(\d{1,3}))$/);
  return match?.[1] ?? match?.[2] ?? "";
}

function getAiChatLinkFallbackTitle(link, url, referenceNumber = "") {
  const relocatedTitle = typeof link?.dataset?.aiChatSourceTitle === "string"
    ? link.dataset.aiChatSourceTitle.trim().replace(/\s+/g, " ")
    : "";
  if (referenceNumber && relocatedTitle) return relocatedTitle;
  if (referenceNumber) return getAiChatCitationFallbackTitle(url);
  const label = typeof link?.textContent === "string" ? link.textContent.trim().replace(/\s+/g, " ") : "";
  if (
    label
    && !/^https?:\/\//i.test(label)
    && label.toLowerCase() !== url.hostname.toLowerCase()
    && label.toLowerCase() !== url.toString().toLowerCase()
  ) {
    return label;
  }
  return getAiChatCitationFallbackTitle(url);
}

function getAiChatCitationDomainLabel(url) {
  const hostname = url.hostname.toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.includes(":")) return hostname || url.hostname;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return hostname;

  const parts = hostname.split(".").filter(Boolean);
  if (parts.length < 2) return hostname;
  const tld = parts.at(-1) ?? "";
  const secondLevel = parts.at(-2) ?? "";
  const useThirdLevel = tld.length === 2 && aiChatCountrySecondLevelDomains.has(secondLevel) && parts.length >= 3;
  return parts.at(useThirdLevel ? -3 : -2) || hostname;
}

function getAiChatCitationFallbackTitle(url) {
  return url.hostname.toLowerCase().replace(/^www\./, "") || url.toString();
}

function getAiChatLinkPreviewFavicon(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  if (
    raw.length <= aiChatLinkPreviewFaviconDataUrlMaxLength
    && aiChatLinkPreviewFaviconDataPattern.test(raw)
  ) return raw;
  return "";
}

function resetAiChatLinkFavicon(slot) {
  if (!slot) return;
  slot.replaceChildren();
  slot.classList.add("is-fallback");
}

function hideAiChatCitationPopover({ restoreFocus = false } = {}) {
  const citation = activeAiChatCitation;
  if (citation) citation.setAttribute("aria-expanded", "false");
  if (aiChatCitationPopover) aiChatCitationPopover.hidden = true;
  activeAiChatCitation = null;
  if (restoreFocus && citation?.isConnected) citation.focus?.();
}

function positionAiChatCitationPopover(citation, popover) {
  if (!citation?.getBoundingClientRect || !popover?.getBoundingClientRect) return;
  const triggerRect = citation.getBoundingClientRect();
  const viewportWidth = document.documentElement?.clientWidth || globalThis.innerWidth || 0;
  const viewportHeight = document.documentElement?.clientHeight || globalThis.innerHeight || 0;
  const edge = 8;
  const gap = 7;

  popover.style.left = `${Math.max(edge, triggerRect.left)}px`;
  popover.style.top = `${triggerRect.bottom + gap}px`;
  const popoverRect = popover.getBoundingClientRect();
  const maxLeft = Math.max(edge, viewportWidth - popoverRect.width - edge);
  const left = Math.min(Math.max(triggerRect.left, edge), maxLeft);
  let top = triggerRect.bottom + gap;
  if (viewportHeight && top + popoverRect.height > viewportHeight - edge) {
    const above = triggerRect.top - popoverRect.height - gap;
    if (above >= edge) top = above;
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${Math.max(edge, top)}px`;
}

function ensureAiChatCitationPopover() {
  if (aiChatCitationPopover?.isConnected) return aiChatCitationPopover;
  if (!document?.body) return null;

  const popover = document.createElement("div");
  popover.id = aiChatCitationPopoverId;
  popover.className = "rendered-ai-chat-link-tooltip";
  popover.hidden = true;
  popover.setAttribute("role", "dialog");
  popover.setAttribute("aria-modal", "false");

  const sourceLink = document.createElement("a");
  sourceLink.className = "rendered-ai-chat-link-tooltip-title";
  sourceLink.target = "_blank";
  sourceLink.rel = "noopener noreferrer";
  sourceLink.referrerPolicy = "no-referrer";
  sourceLink.addEventListener("click", () => hideAiChatCitationPopover());
  popover.append(sourceLink);
  document.body.append(popover);
  aiChatCitationPopover = popover;

  if (!aiChatCitationPopoverEventsBound) {
    document.addEventListener("pointerdown", (event) => {
      if (!activeAiChatCitation || !aiChatCitationPopover || aiChatCitationPopover.hidden) return;
      const target = event.target;
      if (activeAiChatCitation.contains?.(target) || aiChatCitationPopover.contains?.(target)) return;
      hideAiChatCitationPopover();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !activeAiChatCitation) return;
      event.preventDefault();
      hideAiChatCitationPopover({ restoreFocus: true });
    });
    document.addEventListener("scroll", () => hideAiChatCitationPopover(), true);
    globalThis.addEventListener?.("resize", () => hideAiChatCitationPopover());
    aiChatCitationPopoverEventsBound = true;
  }

  return popover;
}

function showAiChatCitationPopover(citation) {
  if (!citation?.dataset?.aiChatLinkUrl) return;
  if (activeAiChatCitation === citation && aiChatCitationPopover && !aiChatCitationPopover.hidden) {
    hideAiChatCitationPopover();
    return;
  }

  const popover = ensureAiChatCitationPopover();
  const sourceLink = popover?.querySelector?.(".rendered-ai-chat-link-tooltip-title");
  if (!popover || !sourceLink) return;

  if (activeAiChatCitation && activeAiChatCitation !== citation) {
    activeAiChatCitation.setAttribute("aria-expanded", "false");
  }
  activeAiChatCitation = citation;
  citation.setAttribute("aria-expanded", "true");
  citation.setAttribute("aria-controls", aiChatCitationPopoverId);
  sourceLink.href = citation.dataset.aiChatLinkUrl;
  sourceLink.textContent = citation.dataset.aiChatLinkTitle || citation.dataset.aiChatLinkDomain || citation.dataset.aiChatLinkUrl;
  popover.setAttribute("aria-label", sourceLink.textContent);
  popover.hidden = false;
  positionAiChatCitationPopover(citation, popover);
}

function getAiChatElementTagName(node) {
  return typeof node?.tagName === "string" ? node.tagName.toUpperCase() : "";
}

function getAiChatChildElements(node) {
  return Array.from(node?.children ?? []);
}

function getAiChatCitationBlockEndBoundary(node) {
  let current = node?.parentElement ?? node?.parentNode ?? null;
  while (current) {
    if (aiChatCitationBlockEndTags.has(getAiChatElementTagName(current))) return current;
    current = current.parentElement ?? current.parentNode ?? null;
  }
  return null;
}

function getAiChatFollowingNodesWithinBoundary(node, boundary) {
  const following = [];
  let current = node;
  while (current && current !== boundary) {
    const parent = current.parentNode ?? current.parentElement ?? null;
    if (!parent) return null;
    const siblings = Array.from(parent.childNodes ?? []);
    const index = siblings.indexOf(current);
    if (index < 0) return null;
    following.push(...siblings.slice(index + 1));
    current = parent;
  }
  return current === boundary ? following : null;
}

function isAiChatCitationTailText(value) {
  const raw = typeof value === "string" ? value : "";
  const stripped = raw.replace(aiChatCitationTailMarkerPattern, "");
  aiChatCitationTailMarkerPattern.lastIndex = 0;
  return aiChatCitationTailSeparatorPattern.test(stripped);
}

function isAiChatCitationTailNode(node) {
  if (!node) return true;
  if (node.nodeType === 3) {
    return isAiChatCitationTailText(typeof node.nodeValue === "string" ? node.nodeValue : (node.textContent ?? ""));
  }
  if (node.nodeType !== 1) return true;

  const tagName = getAiChatElementTagName(node);
  if (tagName === "A") {
    return Boolean(getAiChatReferenceNumber(node) && getAiChatWebUrl(node?.href ?? node?.getAttribute?.("href")));
  }
  if (tagName === "BUTTON" && node?.classList?.contains?.("rendered-ai-chat-link-preview")) return true;
  if (!aiChatCitationTailInlineTags.has(tagName)) return false;
  const children = Array.from(node.childNodes ?? []);
  return children.length > 0 && children.every((child) => isAiChatCitationTailNode(child));
}

function isAiChatNodeAtCitationBlockEnd(node, ownTail = "") {
  const boundary = getAiChatCitationBlockEndBoundary(node);
  if (!boundary || !isAiChatCitationTailText(ownTail)) return false;
  const following = getAiChatFollowingNodesWithinBoundary(node, boundary);
  return Array.isArray(following) && following.every((candidate) => isAiChatCitationTailNode(candidate));
}

function isAiChatInlineCitationLink(link) {
  if (!getAiChatReferenceNumber(link)) return false;
  if (link?.dataset?.aiChatRelocatedCitation === "true") return true;
  return isAiChatNodeAtCitationBlockEnd(link);
}

function collectAiChatReferenceWrapperUnits(node, units) {
  for (const child of Array.from(node?.childNodes ?? [])) {
    if (child?.nodeType === 3) {
      const value = typeof child.nodeValue === "string" ? child.nodeValue : (child.textContent ?? "");
      for (let index = 0; index < value.length; index += 1) {
        units.push({ char: value[index], node: child, offset: index });
      }
      continue;
    }
    if (child?.nodeType !== 1) continue;

    const tagName = getAiChatElementTagName(child);
    const isWebLink = tagName === "A" && Boolean(getAiChatWebUrl(child?.href ?? child?.getAttribute?.("href")));
    const isCitationChip = tagName === "BUTTON" && child?.classList?.contains?.("rendered-ai-chat-link-preview");
    if (isWebLink || isCitationChip) {
      units.push({ char: aiChatReferenceWrapperPlaceholder });
      continue;
    }
    if (aiChatCitationTailInlineTags.has(tagName)) {
      collectAiChatReferenceWrapperUnits(child, units);
      continue;
    }
    units.push({ char: aiChatReferenceWrapperBarrier });
  }
}

function stripAiChatTrailingReferenceParentheses(block) {
  const units = [];
  collectAiChatReferenceWrapperUnits(block, units);
  if (!units.some((unit) => unit.char === aiChatReferenceWrapperPlaceholder)) return;

  const linearText = units.map((unit) => unit.char).join("");
  const match = linearText.match(aiChatReferenceWrapperPattern);
  if (!match || match.index === undefined) return;

  const openingIndex = match.index;
  const closingIndex = linearText.lastIndexOf(")", linearText.length - match[1].length - 1);
  const opening = units[openingIndex];
  const closing = units[closingIndex];
  if (opening?.char !== "(" || closing?.char !== ")" || !opening.node || !closing.node) return;

  const edits = new Map();
  for (const point of [opening, closing]) {
    const offsets = edits.get(point.node) ?? new Set();
    offsets.add(point.offset);
    edits.set(point.node, offsets);
  }
  edits.forEach((offsets, textNode) => {
    const value = typeof textNode.nodeValue === "string" ? textNode.nodeValue : (textNode.textContent ?? "");
    textNode.nodeValue = value.split("").filter((_, index) => !offsets.has(index)).join("");
  });
}

function stripRenderedAiChatReferenceParentheses(root) {
  const contents = [];
  if (root?.matches?.(".rendered-ai-chat-answer .rendered-ai-chat-content")) contents.push(root);
  root?.querySelectorAll?.(".rendered-ai-chat-answer .rendered-ai-chat-content")?.forEach?.((content) => contents.push(content));

  const visit = (node) => {
    for (const child of getAiChatChildElements(node)) {
      const tagName = getAiChatElementTagName(child);
      if (aiChatCitationBlockEndTags.has(tagName)) stripAiChatTrailingReferenceParentheses(child);
      visit(child);
    }
  };
  [...new Set(contents)].forEach((content) => visit(content));
}

function stripAiChatDuplicateTrailingReferenceMarkers(block) {
  const renderedReferences = new Set();

  const visit = (node) => {
    for (const child of Array.from(node?.childNodes ?? [])) {
      if (child?.nodeType === 3) {
        if (!renderedReferences.size) continue;
        const value = typeof child.nodeValue === "string" ? child.nodeValue : (child.textContent ?? "");
        aiChatCitationMarkerPattern.lastIndex = 0;
        const matches = [...value.matchAll(aiChatCitationMarkerPattern)];
        aiChatCitationMarkerPattern.lastIndex = 0;
        if (!matches.length) continue;

        let cursor = 0;
        let nextValue = "";
        let changed = false;
        matches.forEach((match) => {
          const matchIndex = match.index ?? 0;
          const references = match[1].split(",").map((part) => part.trim()).filter(Boolean);
          const isDuplicateTail = references.length > 0
            && references.every((reference) => renderedReferences.has(reference))
            && isAiChatNodeAtCitationBlockEnd(child, value.slice(matchIndex));
          if (!isDuplicateTail) return;

          const between = value.slice(cursor, matchIndex);
          nextValue += /^\s*$/.test(nextValue + between) ? "" : between;
          cursor = matchIndex + match[0].length;
          changed = true;
        });
        if (!changed) continue;
        nextValue += value.slice(cursor);
        child.nodeValue = nextValue.replace(/^\s+(?=[,.;:!?…，。；：！？、])/, "");
        continue;
      }
      if (child?.nodeType !== 1) continue;

      if (child.classList?.contains?.("rendered-ai-chat-link-preview")) {
        const reference = typeof child.dataset?.aiChatReference === "string"
          ? child.dataset.aiChatReference.trim()
          : "";
        if (reference) renderedReferences.add(reference);
        continue;
      }
      if (aiChatCitationTailInlineTags.has(getAiChatElementTagName(child))) visit(child);
    }
  };

  visit(block);
}

function stripRenderedAiChatDuplicateReferenceMarkers(root) {
  const contents = [];
  if (root?.matches?.(".rendered-ai-chat-answer .rendered-ai-chat-content")) contents.push(root);
  root?.querySelectorAll?.(".rendered-ai-chat-answer .rendered-ai-chat-content")?.forEach?.((content) => contents.push(content));

  const visit = (node) => {
    for (const child of getAiChatChildElements(node)) {
      const tagName = getAiChatElementTagName(child);
      if (aiChatCitationBlockEndTags.has(tagName)) stripAiChatDuplicateTrailingReferenceMarkers(child);
      visit(child);
    }
  };
  [...new Set(contents)].forEach((content) => visit(content));
}

function isAiChatHeadingElement(node) {
  return /^H[1-6]$/.test(getAiChatElementTagName(node));
}

function isAiChatCitationSourceHeading(node) {
  if (!isAiChatHeadingElement(node)) return false;
  const label = typeof node.textContent === "string" ? node.textContent.trim().replace(/\s+/g, " ") : "";
  return aiChatCitationSourceHeadingPattern.test(label);
}

function getAiChatHttpLinks(node) {
  return [...(node?.querySelectorAll?.("a[href]") ?? [])]
    .filter((link) => Boolean(getAiChatWebUrl(link?.href ?? link?.getAttribute?.("href"))));
}

function getAiChatClosestSourceItem(link, boundary) {
  let node = link?.parentElement ?? null;
  let fallback = null;
  while (node && node !== boundary) {
    const tagName = getAiChatElementTagName(node);
    if (tagName === "LI" || tagName === "P") return node;
    fallback = node;
    node = node.parentElement ?? null;
  }
  return fallback && fallback !== boundary ? fallback : null;
}

function getAiChatTopLevelBlock(node, boundary) {
  let current = node;
  while (current?.parentElement && current.parentElement !== boundary) current = current.parentElement;
  return current?.parentElement === boundary ? current : null;
}

function getAiChatLinePrefixBeforeLink(link) {
  const parts = [];
  let current = link?.previousSibling ?? null;
  while (current) {
    if (getAiChatElementTagName(current) === "BR") break;
    parts.unshift(typeof current.textContent === "string" ? current.textContent : "");
    current = current.previousSibling ?? null;
  }
  return parts.join("").replace(/\s+/g, " ").trim();
}

function getAiChatExplicitSourceReference(link, item, { allowNumericLink = false } = {}) {
  const prefix = getAiChatLinePrefixBeforeLink(link);
  const prefixMatch = prefix.match(/(?:^|\s)(?:\[(\d{1,3})\]|(\d{1,3})\s*[.)])\s*$/);
  if (prefixMatch) return prefixMatch[1] ?? prefixMatch[2] ?? "";
  const leadingMatch = prefix.match(/^\s*(?:\[(\d{1,3})\]|(\d{1,3})\s*[.)])(?:\s|$)/);
  if (leadingMatch) return leadingMatch[1] ?? leadingMatch[2] ?? "";

  if (!allowNumericLink) return "";
  const referenceNumber = getAiChatReferenceNumber(link);
  if (!referenceNumber) return "";
  const itemText = typeof item?.textContent === "string" ? item.textContent.trim().replace(/\s+/g, "") : "";
  const linkText = typeof link?.textContent === "string" ? link.textContent.trim().replace(/\s+/g, "") : "";
  return itemText === linkText ? referenceNumber : "";
}

function getAiChatSourceTitle(link, url) {
  const titleAttribute = typeof link?.getAttribute === "function"
    ? (link.getAttribute("title") ?? "").trim().replace(/\s+/g, " ")
    : "";
  const label = typeof link?.textContent === "string" ? link.textContent.trim().replace(/\s+/g, " ") : "";
  if (
    label
    && !getAiChatReferenceNumber(link)
    && !/^https?:\/\//i.test(label)
    && label.toLowerCase() !== url.hostname.toLowerCase()
    && label.toLowerCase() !== url.toString().toLowerCase()
  ) return label;
  return titleAttribute || getAiChatCitationFallbackTitle(url);
}

function createAiChatCitationSourceRecord(referenceNumber, link, item, topBlock, sourceHeading = null) {
  const url = getAiChatWebUrl(link?.href ?? link?.getAttribute?.("href"));
  if (!referenceNumber || !url) return null;
  return {
    referenceNumber: String(referenceNumber),
    url: url.toString(),
    title: getAiChatSourceTitle(link, url),
    link,
    item: item ?? topBlock ?? null,
    topBlock: topBlock ?? item ?? null,
    sourceHeading
  };
}

function getAiChatListItemReference(item) {
  const parent = item?.parentElement;
  if (!parent || getAiChatElementTagName(item) !== "LI" || getAiChatElementTagName(parent) !== "OL") return "";
  const items = getAiChatChildElements(parent).filter((child) => getAiChatElementTagName(child) === "LI");
  const index = items.indexOf(item);
  return index >= 0 ? String(index + 1) : "";
}

function collectAiChatSourceSectionRecords(content, topLevelBlocks) {
  const records = [];
  const sourceLinks = new Set();
  const sourceContainers = new Set();
  const sourceHeadings = new Set();

  topLevelBlocks.forEach((heading, headingIndex) => {
    if (!isAiChatCitationSourceHeading(heading)) return;
    sourceHeadings.add(heading);
    let sequentialReference = 1;
    for (let index = headingIndex + 1; index < topLevelBlocks.length; index += 1) {
      const block = topLevelBlocks[index];
      if (isAiChatHeadingElement(block)) break;
      const links = getAiChatHttpLinks(block);
      if (!links.length) continue;
      links.forEach((link) => {
        const item = getAiChatClosestSourceItem(link, content) ?? block;
        const explicitReference = getAiChatExplicitSourceReference(link, item, { allowNumericLink: true });
        const listReference = getAiChatListItemReference(item);
        const referenceNumber = explicitReference || listReference || String(sequentialReference);
        sequentialReference += 1;
        const record = createAiChatCitationSourceRecord(referenceNumber, link, item, block, heading);
        if (!record) return;
        records.push(record);
        sourceLinks.add(link);
        sourceContainers.add(item);
      });
    }
  });

  return { records, sourceLinks, sourceContainers, sourceHeadings };
}

function isAiChatDedicatedExplicitSourceItem(link, item) {
  if (!item) return false;
  if (getAiChatElementTagName(item) === "LI") return true;
  if (getAiChatElementTagName(item) !== "P") return false;

  const referenceNumber = getAiChatExplicitSourceReference(link, item, { allowNumericLink: true });
  if (!referenceNumber) return false;
  const firstChild = item.childNodes?.[0] ?? null;
  if (firstChild === link) {
    const itemText = typeof item.textContent === "string" ? item.textContent.trim().replace(/\s+/g, "") : "";
    const linkText = typeof link.textContent === "string" ? link.textContent.trim().replace(/\s+/g, "") : "";
    return itemText === linkText;
  }

  const prefix = getAiChatLinePrefixBeforeLink(link);
  return /^\s*(?:\[\d{1,3}\]|\d{1,3}\s*[.)])(?:\s|$)/.test(prefix)
    && !link.previousSibling?.previousSibling;
}

function collectAiChatExplicitSourceRecords(content, existingSourceLinks) {
  const records = [];
  const sourceLinks = new Set();
  const sourceContainers = new Set();
  getAiChatHttpLinks(content).forEach((link) => {
    if (existingSourceLinks.has(link)) return;
    const item = getAiChatClosestSourceItem(link, content);
    if (!isAiChatDedicatedExplicitSourceItem(link, item)) return;
    const referenceNumber = getAiChatExplicitSourceReference(link, item, { allowNumericLink: true });
    const topBlock = getAiChatTopLevelBlock(item, content) ?? item;
    const record = createAiChatCitationSourceRecord(referenceNumber, link, item, topBlock);
    if (!record) return;
    records.push(record);
    sourceLinks.add(link);
    sourceContainers.add(item);
  });
  return { records, sourceLinks, sourceContainers };
}

function collectAiChatTextNodes(root, excludedElements = new Set()) {
  const textNodes = [];
  const visit = (node) => {
    for (const child of Array.from(node?.childNodes ?? [])) {
      if (child?.nodeType === 3) {
        textNodes.push(child);
        continue;
      }
      if (child?.nodeType !== 1 || excludedElements.has(child)) continue;
      if (aiChatCitationTextExcludedTags.has(getAiChatElementTagName(child))) continue;
      visit(child);
    }
  };
  visit(root);
  return textNodes;
}

function getAiChatCitationNumbersFromTextNodes(textNodes) {
  const references = new Set();
  textNodes.forEach((textNode) => {
    const value = typeof textNode?.nodeValue === "string" ? textNode.nodeValue : (textNode?.textContent ?? "");
    aiChatCitationMarkerPattern.lastIndex = 0;
    let match = null;
    while ((match = aiChatCitationMarkerPattern.exec(value))) {
      if (!isAiChatNodeAtCitationBlockEnd(textNode, value.slice(match.index))) continue;
      match[1].split(",").map((part) => part.trim()).filter(Boolean).forEach((reference) => references.add(reference));
    }
  });
  aiChatCitationMarkerPattern.lastIndex = 0;
  return references;
}

function collectAiChatTrailingListSourceRecords(content, topLevelBlocks, existingSourceLinks, existingSourceContainers) {
  const records = [];
  const sourceLinks = new Set();
  const sourceContainers = new Set();
  const trailingBlock = [...topLevelBlocks].reverse().find((block) => (
    typeof block?.textContent !== "string" || block.textContent.trim() || getAiChatHttpLinks(block).length
  ));
  if (!trailingBlock || !["OL", "UL"].includes(getAiChatElementTagName(trailingBlock))) {
    return { records, sourceLinks, sourceContainers };
  }

  const items = getAiChatChildElements(trailingBlock).filter((child) => getAiChatElementTagName(child) === "LI");
  if (!items.length || items.some((item) => getAiChatHttpLinks(item).length !== 1)) {
    return { records, sourceLinks, sourceContainers };
  }

  const candidateContainers = new Set([...existingSourceContainers, ...items]);
  const markerReferences = getAiChatCitationNumbersFromTextNodes(collectAiChatTextNodes(content, candidateContainers));
  if (!markerReferences.size) return { records, sourceLinks, sourceContainers };
  const maxReference = Math.max(...[...markerReferences].map((value) => Number.parseInt(value, 10)).filter(Number.isFinite));
  if (!Number.isFinite(maxReference) || maxReference > items.length) return { records, sourceLinks, sourceContainers };

  items.forEach((item, index) => {
    const link = getAiChatHttpLinks(item)[0];
    if (!link || existingSourceLinks.has(link)) return;
    const record = createAiChatCitationSourceRecord(String(index + 1), link, item, trailingBlock);
    if (!record) return;
    records.push(record);
    sourceLinks.add(link);
    sourceContainers.add(item);
  });
  return { records, sourceLinks, sourceContainers };
}

function createRelocatedAiChatCitationLink(referenceNumber, source) {
  const link = document.createElement("a");
  link.href = source.url;
  link.textContent = referenceNumber;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.referrerPolicy = "no-referrer";
  link.dataset.aiChatSourceTitle = source.title;
  link.dataset.aiChatRelocatedCitation = "true";
  return link;
}

function replaceAiChatCitationMarkers(textNode, sourcesByReference) {
  const value = typeof textNode?.nodeValue === "string" ? textNode.nodeValue : (textNode?.textContent ?? "");
  if (!value || typeof textNode?.replaceWith !== "function") return new Set();
  aiChatCitationMarkerPattern.lastIndex = 0;
  const matches = [...value.matchAll(aiChatCitationMarkerPattern)]
    .filter((match) => isAiChatNodeAtCitationBlockEnd(textNode, value.slice(match.index ?? 0)));
  aiChatCitationMarkerPattern.lastIndex = 0;
  if (!matches.some((match) => match[1].split(",").some((part) => sourcesByReference.has(part.trim())))) return new Set();

  const fragment = document.createDocumentFragment();
  const usedReferences = new Set();
  let cursor = 0;
  matches.forEach((match) => {
    const matchIndex = match.index ?? 0;
    if (matchIndex > cursor) fragment.append(document.createTextNode(value.slice(cursor, matchIndex)));
    const references = match[1].split(",").map((part) => part.trim()).filter(Boolean);
    const hasMappedReference = references.some((reference) => sourcesByReference.has(reference));
    if (!hasMappedReference) {
      fragment.append(document.createTextNode(match[0]));
    } else {
      references.forEach((reference, index) => {
        if (index > 0) fragment.append(document.createTextNode(" "));
        const source = sourcesByReference.get(reference);
        if (source) {
          fragment.append(createRelocatedAiChatCitationLink(reference, source));
          usedReferences.add(reference);
        } else {
          fragment.append(document.createTextNode(`[${reference}]`));
        }
      });
    }
    cursor = matchIndex + match[0].length;
  });
  if (cursor < value.length) fragment.append(document.createTextNode(value.slice(cursor)));
  textNode.replaceWith(fragment);
  return usedReferences;
}

function cleanupRelocatedAiChatSourceRecords(records, usedReferences, sourceHeadings) {
  const recordsByItem = new Map();
  records.forEach((record) => {
    if (!record.item) return;
    const itemRecords = recordsByItem.get(record.item) ?? [];
    itemRecords.push(record);
    recordsByItem.set(record.item, itemRecords);
  });

  const listParents = new Set();
  recordsByItem.forEach((itemRecords, item) => {
    if (!itemRecords.length || !itemRecords.every((record) => usedReferences.has(record.referenceNumber))) return;
    if (item?.parentElement && ["OL", "UL"].includes(getAiChatElementTagName(item.parentElement))) listParents.add(item.parentElement);
    item?.remove?.();
  });

  listParents.forEach((list) => {
    const remainingItems = getAiChatChildElements(list).filter((child) => getAiChatElementTagName(child) === "LI");
    if (!remainingItems.length) list.remove?.();
  });

  sourceHeadings.forEach((heading) => {
    if (!heading?.isConnected) return;
    let next = heading.nextElementSibling ?? null;
    let hasSourceContent = false;
    while (next && !isAiChatHeadingElement(next)) {
      if (getAiChatHttpLinks(next).length || (typeof next.textContent === "string" && next.textContent.trim())) {
        hasSourceContent = true;
        break;
      }
      next = next.nextElementSibling ?? null;
    }
    if (!hasSourceContent) heading.remove?.();
  });
}

function relocateRenderedAiChatCitationSources(content) {
  if (!content?.querySelectorAll) return;
  const topLevelBlocks = getAiChatChildElements(content);
  const sectionSources = collectAiChatSourceSectionRecords(content, topLevelBlocks);
  const explicitSources = collectAiChatExplicitSourceRecords(content, sectionSources.sourceLinks);
  const knownSourceLinks = new Set([...sectionSources.sourceLinks, ...explicitSources.sourceLinks]);
  const knownSourceContainers = new Set([...sectionSources.sourceContainers, ...explicitSources.sourceContainers]);
  const trailingSources = collectAiChatTrailingListSourceRecords(
    content,
    topLevelBlocks,
    knownSourceLinks,
    knownSourceContainers
  );

  const records = [...sectionSources.records, ...explicitSources.records, ...trailingSources.records];
  if (!records.length) return;
  const sourceContainers = new Set([...knownSourceContainers, ...trailingSources.sourceContainers]);

  const sourcesByReference = new Map();
  records.forEach((record) => {
    if (!sourcesByReference.has(record.referenceNumber)) sourcesByReference.set(record.referenceNumber, record);
  });

  const markerTextNodes = collectAiChatTextNodes(content, sourceContainers);
  const usedReferences = new Set();
  markerTextNodes.forEach((textNode) => {
    replaceAiChatCitationMarkers(textNode, sourcesByReference).forEach((reference) => usedReferences.add(reference));
  });
  if (!usedReferences.size) return;
  records.forEach((record) => {
    if (usedReferences.has(record.referenceNumber) && record.link?.dataset) {
      record.link.dataset.aiChatSourceDefinition = "true";
    }
  });
  cleanupRelocatedAiChatSourceRecords(records, usedReferences, sectionSources.sourceHeadings);
}

function relocateRenderedAiChatCitationLinks(root) {
  const contents = [];
  if (root?.matches?.(".rendered-ai-chat-answer .rendered-ai-chat-content")) contents.push(root);
  root?.querySelectorAll?.(".rendered-ai-chat-answer .rendered-ai-chat-content")?.forEach?.((content) => contents.push(content));
  [...new Set(contents)].forEach((content) => relocateRenderedAiChatCitationSources(content));
}

function prepareRenderedAiChatLink(link) {
  const referenceNumber = getAiChatReferenceNumber(link);
  const url = getAiChatWebUrl(link?.href ?? link?.getAttribute?.("href"));
  if (!referenceNumber || !url || !isAiChatInlineCitationLink(link)) return null;

  const normalizedUrl = url.toString();
  const domainLabel = getAiChatCitationDomainLabel(url);
  const fallbackTitle = getAiChatLinkFallbackTitle(link, url, referenceNumber);
  const citation = document.createElement("button");
  citation.type = "button";
  citation.className = "rendered-ai-chat-link-preview";
  citation.dataset.aiChatLinkUrl = normalizedUrl;
  citation.dataset.aiChatLinkDomain = domainLabel;
  citation.dataset.aiChatLinkTitle = fallbackTitle;
  citation.dataset.aiChatLinkPreviewState = "pending";
  if (referenceNumber) citation.dataset.aiChatReference = referenceNumber;
  citation.setAttribute("aria-expanded", "false");
  citation.setAttribute("aria-haspopup", "dialog");
  citation.setAttribute(
    "aria-label",
    referenceNumber ? `[${referenceNumber}] ${domainLabel}` : `${domainLabel}: ${fallbackTitle}`
  );

  const favicon = document.createElement("span");
  favicon.className = "rendered-ai-chat-link-favicon is-fallback";
  favicon.setAttribute("aria-hidden", "true");

  const domain = document.createElement("span");
  domain.className = "rendered-ai-chat-link-domain";
  domain.textContent = domainLabel;

  citation.append(favicon, domain);
  citation.addEventListener("click", (event) => {
    event.preventDefault();
    showAiChatCitationPopover(citation);
  });
  link.replaceWith(citation);
  return citation;
}

function applyRenderedAiChatLinkPreview(citation, previewData, requestedUrl) {
  if (!citation?.isConnected || citation.dataset?.aiChatLinkUrl !== requestedUrl) return;
  const title = typeof previewData?.title === "string" ? previewData.title.trim() : "";
  if (title) citation.dataset.aiChatLinkTitle = title;

  const faviconSlot = citation.querySelector?.(".rendered-ai-chat-link-favicon");
  const faviconUrl = getAiChatLinkPreviewFavicon(previewData?.faviconUrl);
  resetAiChatLinkFavicon(faviconSlot);
  if (faviconSlot && faviconUrl) {
    const image = document.createElement("img");
    image.src = faviconUrl;
    image.alt = "";
    image.width = 16;
    image.height = 16;
    image.loading = "lazy";
    image.referrerPolicy = "no-referrer";
    image.addEventListener("load", () => faviconSlot.classList.remove("is-fallback"), { once: true });
    image.addEventListener("error", () => resetAiChatLinkFavicon(faviconSlot), { once: true });
    faviconSlot.append(image);
  }
  citation.dataset.aiChatLinkPreviewState = "loaded";

  if (activeAiChatCitation === citation && aiChatCitationPopover && !aiChatCitationPopover.hidden) {
    const sourceLink = aiChatCitationPopover.querySelector?.(".rendered-ai-chat-link-tooltip-title");
    if (sourceLink) {
      sourceLink.textContent = citation.dataset.aiChatLinkTitle;
      aiChatCitationPopover.setAttribute("aria-label", sourceLink.textContent);
    }
    positionAiChatCitationPopover(citation, aiChatCitationPopover);
  }
}

function getAiChatLinkPreviewRequest(url, fetchPreview) {
  const cached = aiChatLinkPreviewCache.get(url);
  if (cached) return cached;

  const request = Promise.resolve()
    .then(() => fetchPreview(url))
    .then((value) => value?.preview ?? value ?? null)
    .catch(() => null)
    .then((value) => {
      if (!value) aiChatLinkPreviewCache.delete(url);
      return value;
    });
  aiChatLinkPreviewCache.set(url, request);
  if (aiChatLinkPreviewCache.size > 250) {
    const oldest = aiChatLinkPreviewCache.keys().next().value;
    if (oldest) aiChatLinkPreviewCache.delete(oldest);
  }
  return request;
}

async function hydrateRenderedAiChatLink(citation, fetchPreview) {
  const url = citation?.dataset?.aiChatLinkUrl;
  if (!url || ["loading", "loaded"].includes(citation.dataset.aiChatLinkPreviewState)) return;
  citation.dataset.aiChatLinkPreviewState = "loading";
  const previewData = await getAiChatLinkPreviewRequest(url, fetchPreview);
  if (!citation?.isConnected || citation.dataset?.aiChatLinkUrl !== url) return;
  if (!previewData) {
    citation.dataset.aiChatLinkPreviewState = "failed";
    return;
  }
  applyRenderedAiChatLinkPreview(citation, previewData, url);
}

export function hydrateRenderedAiChatLinks(root, fetchPreview) {
  if (!root || typeof fetchPreview !== "function") return;
  relocateRenderedAiChatCitationLinks(root);
  const citations = [...root.querySelectorAll(".rendered-ai-chat-answer .rendered-ai-chat-content a[href]")]
    .filter((link) => link?.dataset?.aiChatSourceDefinition !== "true")
    .filter((link) => isAiChatInlineCitationLink(link))
    .map((link) => prepareRenderedAiChatLink(link))
    .filter(Boolean)
    .filter((citation) => !["loading", "loaded"].includes(citation.dataset.aiChatLinkPreviewState));
  stripRenderedAiChatDuplicateReferenceMarkers(root);
  stripRenderedAiChatReferenceParentheses(root);
  if (!citations.length) return;

  if (typeof IntersectionObserver !== "function") {
    citations.forEach((citation) => { void hydrateRenderedAiChatLink(citation, fetchPreview); });
    return;
  }

  let observerState = aiChatLinkPreviewObservers.get(root);
  if (!observerState || observerState.fetchPreview !== fetchPreview) {
    observerState?.observer?.disconnect();
    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        void hydrateRenderedAiChatLink(entry.target, fetchPreview);
      });
    }, { rootMargin: "160px" });
    observerState = { observer, fetchPreview };
    aiChatLinkPreviewObservers.set(root, observerState);
  }
  citations.forEach((citation) => observerState.observer.observe(citation));
}

function normalizeText(value, maxLength) {
  return (value === null || value === undefined ? "" : String(value))
    .replace(/\u0000/g, "")
    .slice(0, maxLength);
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

export function createLocalDateTimeValue(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
}

function daysInMonth(year, month) {
  if (month === 2) {
    const isLeapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    return isLeapYear ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function normalizeLocalDateTime(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().slice(0, 16);
  const match = normalized.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/);
  if (!match) return "";

  const [, year, month, day, hour, minute] = match;
  const yearNumber = Number(year);
  const monthNumber = Number(month);
  const dayNumber = Number(day);
  const hourNumber = Number(hour);
  const minuteNumber = Number(minute);
  if (
    yearNumber < 1 ||
    monthNumber < 1 ||
    monthNumber > 12 ||
    dayNumber < 1 ||
    dayNumber > daysInMonth(yearNumber, monthNumber) ||
    hourNumber > 23 ||
    minuteNumber > 59
  ) {
    return "";
  }
  return normalized;
}

function normalizeLayout(value) {
  return value === "paginated" ? "paginated" : "stacked";
}

export function getAiProviderPreset(value) {
  return providerById.get(typeof value === "string" ? value.toLowerCase() : "") ?? aiProviderPresets[0];
}

function normalizeTurn(value, { fallbackAnsweredAt = "", defaultAnsweredAt = false } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hasAnsweredAt = Object.prototype.hasOwnProperty.call(source, "answeredAt");
  const answeredAt = normalizeLocalDateTime(source.answeredAt)
    || (!hasAnsweredAt ? normalizeLocalDateTime(fallbackAnsweredAt) : "")
    || (defaultAnsweredAt ? createLocalDateTimeValue() : "");
  return {
    answeredAt,
    question: normalizeText(source.question, aiChatLimits.questionLength),
    answer: normalizeText(source.answer, aiChatLimits.answerLength)
  };
}

export function createDefaultAiChatData({ question = "", answeredAt = "" } = {}) {
  return {
    title: "",
    provider: "chatgpt",
    model: "",
    layout: "stacked",
    hideAnswerBorder: false,
    turns: [normalizeTurn({ question, answeredAt }, { defaultAnsweredAt: true })]
  };
}

export function normalizeAiChatData(value, { fallbackAnsweredAt = "" } = {}) {
  const source = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const hasTurnCollection = Array.isArray(source.turns);
  const rawTurns = hasTurnCollection
    ? source.turns.slice(0, aiChatLimits.turns)
    : [source];
  const turns = rawTurns.map((turn, index) => normalizeTurn(turn, {
    fallbackAnsweredAt: !hasTurnCollection && index === 0 ? fallbackAnsweredAt : ""
  }));

  return {
    title: normalizeText(source.title, aiChatLimits.titleLength).trim(),
    provider: getAiProviderPreset(source.provider).id,
    model: normalizeText(source.model, aiChatLimits.modelLength).trim(),
    layout: normalizeLayout(source.layout),
    hideAnswerBorder: source.hideAnswerBorder === true,
    turns: turns.length ? turns : [normalizeTurn({})]
  };
}

export function summarizeAiChatData(value) {
  const data = normalizeAiChatData(value);
  const provider = getAiProviderPreset(data.provider).label;
  return [
    data.title,
    `${provider}${data.model ? ` · ${data.model}` : ""}`,
    ...data.turns.flatMap((turn, index) => [
      `Question ${index + 1}`,
      turn.answeredAt,
      turn.question,
      turn.answer
    ])
  ]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 20_000);
}

function addSvgShape(svg, tagName, attributes, text = "") {
  const shape = document.createElementNS(svgNamespace, tagName);
  Object.entries(attributes).forEach(([name, value]) => shape.setAttribute(name, String(value)));
  if (text) shape.textContent = text;
  svg.append(shape);
}

function drawProviderIcon(svg, provider) {
  if (provider === "gemini") {
    addSvgShape(svg, "path", { d: "M12 2.8c.7 4.8 2.4 7.5 7.2 8.2-4.8.7-7.5 3.4-8.2 8.2-.7-4.8-2.4-7.5-7.2-8.2 4.8-.7 7.5-3.4 8.2-8.2Z" });
    return;
  }

  if (provider === "claude") {
    addSvgShape(svg, "circle", { cx: 12, cy: 12, r: 2.2 });
    [0, 45, 90, 135].forEach((angle) => {
      addSvgShape(svg, "path", { d: "M12 3.2v3.4M12 17.4v3.4", transform: `rotate(${angle} 12 12)` });
    });
    return;
  }

  if (provider === "deepseek") {
    addSvgShape(svg, "path", { d: "M4 13.4c2.2-3 5.2-4.4 8.7-4.2 2.4.1 4.4 1 6.1 2.6-1.1 4.3-4.1 6.8-8.5 6.8-3.1 0-5.4-1.7-6.3-5.2Z" });
    addSvgShape(svg, "path", { d: "M17.6 8.8c.8-1.4 1.8-2.2 3-2.5-.2 1.8-.8 3.2-1.9 4.2" });
    addSvgShape(svg, "circle", { cx: 14.7, cy: 12.5, r: 0.75, fill: "currentColor", stroke: "none" });
    addSvgShape(svg, "path", { d: "M6.2 14.3c1.7.7 3.4.8 5.1.2" });
    return;
  }

  if (provider === "grok") {
    addSvgShape(svg, "path", { d: "M5 5.5 18.5 19" });
    addSvgShape(svg, "path", { d: "M18.8 5.2 9.6 14.4" });
    addSvgShape(svg, "path", { d: "M14.8 5.2h4v4" });
    return;
  }

  addSvgShape(svg, "path", { d: "M12 3.2 15.8 5.4 20 7.8v4.4l-3.8 2.2v4.3L12 21l-3.8-2.3v-4.3L4 12V7.8l4.2-2.4L12 7.6l3.8-2.2" });
  addSvgShape(svg, "path", { d: "m8.2 5.4 3.8 2.2v4.3l4.2 2.5M20 7.8l-4.2 2.4L12 8M8.2 18.7V14.4L4 12" });
}

export function createAiProviderIcon(providerValue, className = "") {
  const provider = getAiProviderPreset(providerValue);
  const wrapper = document.createElement("span");
  wrapper.className = ["ai-provider-icon", className].filter(Boolean).join(" ");
  wrapper.dataset.provider = provider.id;
  wrapper.setAttribute("aria-hidden", "true");

  const svg = document.createElementNS(svgNamespace, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", provider.id === "claude" ? "1.65" : "1.7");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  drawProviderIcon(svg, provider.id);
  wrapper.append(svg);
  return wrapper;
}

function autoGrow(textarea) {
  const minimum = textarea.classList.contains("ai-chat-question-input") ? 38 : 112;
  textarea.style.height = "auto";

  // Read mode hides the whole editing surface with display:none. In that state
  // the textarea has no layout box, so scrollHeight cannot describe the actual
  // wrapped content height. Leave the height unset and measure again after the
  // editor becomes visible instead of freezing the control at its minimum size.
  if (textarea.getClientRects?.().length === 0) {
    textarea.style.removeProperty("height");
    return;
  }

  textarea.style.height = `${Math.max(textarea.scrollHeight, minimum)}px`;
}

export function syncAiChatTextareaHeights(root = document) {
  root?.querySelectorAll?.(".ai-chat-question-input, .ai-chat-answer-input").forEach((textarea) => {
    autoGrow(textarea);
  });
}

function formatLocalDateTime(value) {
  const normalized = normalizeLocalDateTime(value);
  if (!normalized) return t("aiChat.timeNotSet");
  const [datePart, timePart] = normalized.split("T");
  const [year, month, day] = datePart.split("-").map(Number);
  const [hour, minute] = timePart.split(":").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, 0, 0);
  try {
    return formatDateTime(date, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" });
  } catch {
    return normalized.replace("T", " ");
  }
}

function createLabeledField(labelText, input) {
  const label = document.createElement("label");
  label.className = "ai-chat-setting-field";
  const caption = document.createElement("span");
  caption.textContent = labelText;
  label.append(caption, input);
  return label;
}

function syncEditorPreview(editor) {
  const provider = getAiProviderPreset(editor.dataset.aiProvider);
  const modelInput = editor.querySelector(".ai-chat-model-input");

  editor.dataset.aiProvider = provider.id;
  editor.querySelectorAll(".ai-chat-provider-option").forEach((button) => {
    button.classList.toggle("is-selected", button.dataset.aiProvider === provider.id);
    button.setAttribute("aria-pressed", String(button.dataset.aiProvider === provider.id));
  });
  editor.querySelectorAll(".ai-chat-answer-icon").forEach((iconHost) => {
    iconHost.replaceChildren(createAiProviderIcon(provider.id));
  });
  editor.querySelectorAll(".ai-chat-provider-label").forEach((providerLabel) => {
    providerLabel.textContent = provider.label;
  });

  const model = normalizeText(modelInput?.value, aiChatLimits.modelLength).trim();
  editor.querySelectorAll(".ai-chat-model-preview").forEach((modelLabel) => {
    modelLabel.textContent = model || t("aiChat.modelNotSet");
    modelLabel.classList.toggle("is-empty", !model);
  });
}

function syncEditorPagination(editor, requestedPage) {
  const layout = normalizeLayout(editor.dataset.aiLayout);
  const turns = [...editor.querySelectorAll(".ai-chat-turn")];
  const conversation = editor.querySelector(".ai-chat-conversation");
  const pagination = editor.querySelector(".ai-chat-pagination");
  const layoutButtons = [...editor.querySelectorAll(".ai-chat-layout-option")];
  const rawPage = requestedPage ?? Number.parseInt(editor.dataset.aiPage ?? "0", 10);
  const page = Math.min(Math.max(Number.isInteger(rawPage) ? rawPage : 0, 0), Math.max(0, turns.length - 1));

  editor.dataset.aiLayout = layout;
  editor.dataset.aiPage = String(page);
  layoutButtons.forEach((button) => {
    const selected = button.dataset.aiLayout === layout;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });

  if (conversation) {
    conversation.style.transform = layout === "paginated" ? `translateX(-${page * 100}%)` : "";
  }

  turns.forEach((turn, index) => {
    const active = layout !== "paginated" || index === page;
    turn.classList.toggle("is-active", active);
    if (layout === "paginated") turn.setAttribute("aria-hidden", String(!active));
    else turn.removeAttribute("aria-hidden");
  });

  if (!pagination) return;
  pagination.hidden = layout !== "paginated" || turns.length <= 1;
  pagination.setAttribute("aria-label", t("aiChat.paginationAria"));

  let pageButtons = [...pagination.querySelectorAll(".ai-chat-page-button")];
  if (pageButtons.length !== turns.length) {
    const fragment = document.createDocumentFragment();
    turns.forEach((_, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-chat-page-button";
      button.dataset.aiChatPage = String(index);
      button.textContent = String(index + 1);
      fragment.append(button);
    });
    pagination.replaceChildren(fragment);
    pageButtons = [...pagination.querySelectorAll(".ai-chat-page-button")];
  }

  pageButtons.forEach((button, index) => {
    const selected = index === page;
    button.classList.toggle("is-current", selected);
    button.setAttribute("aria-label", t("aiChat.pageAria", { count: index + 1 }));
    if (selected) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
}

function syncTurnControls(editor) {
  const turns = [...editor.querySelectorAll(".ai-chat-turn")];
  const addTurnButton = editor.querySelector(".ai-chat-add-turn");
  if (addTurnButton) {
    const atLimit = turns.length >= aiChatLimits.turns;
    addTurnButton.disabled = atLimit;
    addTurnButton.setAttribute("aria-disabled", String(atLimit));
  }

  turns.forEach((turn, index) => {
    turn.dataset.aiTurnIndex = String(index);
    const turnLabel = turn.querySelector(".ai-chat-turn-label");
    if (turnLabel) turnLabel.textContent = t("aiChat.turnLabel", { count: index + 1 });
    const questionInput = turn.querySelector(".ai-chat-question-input");
    const answerInput = turn.querySelector(".ai-chat-answer-input");
    const timeInput = turn.querySelector(".ai-chat-time-input");
    questionInput?.setAttribute("aria-label", t("aiChat.questionAriaNumbered", { count: index + 1 }));
    answerInput?.setAttribute("aria-label", t("aiChat.answerAriaNumbered", { count: index + 1 }));
    timeInput?.setAttribute("aria-label", t("aiChat.timeAriaNumbered", { count: index + 1 }));
    const removeButton = turn.querySelector(".ai-chat-remove-turn");
    if (removeButton) {
      removeButton.hidden = turns.length <= 1;
      removeButton.title = t("aiChat.removeTurnNumbered", { count: index + 1 });
      removeButton.setAttribute("aria-label", t("aiChat.removeTurnNumbered", { count: index + 1 }));
    }
  });

  syncEditorPagination(editor);
}

function createTurnEditor(editor, row, turnData, { onDirty } = {}) {
  const turn = document.createElement("section");
  turn.className = "ai-chat-turn";

  const turnHeader = document.createElement("div");
  turnHeader.className = "ai-chat-turn-header";
  const turnLabel = document.createElement("span");
  turnLabel.className = "ai-chat-turn-label";
  const removeButton = document.createElement("button");
  removeButton.type = "button";
  removeButton.className = "ai-chat-remove-turn";
  removeButton.dataset.action = "remove-ai-chat-turn";
  removeButton.textContent = "×";
  removeButton.addEventListener("click", () => {
    if (editor.querySelectorAll(".ai-chat-turn").length <= 1) return;
    turn.remove();
    syncTurnControls(editor);
    onDirty?.(row);
  });
  turnHeader.append(turnLabel, removeButton);

  const questionMessage = document.createElement("article");
  questionMessage.className = "ai-chat-message ai-chat-message--question";
  const questionMeta = document.createElement("header");
  questionMeta.className = "ai-chat-message-meta";
  const questionRole = document.createElement("span");
  questionRole.className = "ai-chat-role-mark";
  questionRole.textContent = "Q";
  const questionLabel = document.createElement("strong");
  questionLabel.textContent = t("aiChat.questionLabel");
  questionMeta.append(questionRole, questionLabel);

  const questionInput = document.createElement("textarea");
  questionInput.className = "ai-chat-question-input";
  questionInput.value = turnData.question;
  questionInput.maxLength = aiChatLimits.questionLength;
  questionInput.placeholder = t("aiChat.questionPlaceholder");
  questionInput.spellcheck = true;
  questionInput.rows = 1;
  questionMessage.append(questionMeta, questionInput);

  const answerMessage = document.createElement("article");
  answerMessage.className = "ai-chat-message ai-chat-message--answer";
  const answerMeta = document.createElement("header");
  answerMeta.className = "ai-chat-message-meta ai-chat-answer-meta";
  const answerIdentity = document.createElement("span");
  answerIdentity.className = "ai-chat-answer-identity";
  const answerIcon = document.createElement("span");
  answerIcon.className = "ai-chat-answer-icon";
  answerIcon.append(createAiProviderIcon(editor.dataset.aiProvider));
  const providerLabel = document.createElement("strong");
  providerLabel.className = "ai-chat-provider-label";
  const modelPreview = document.createElement("span");
  modelPreview.className = "ai-chat-model-preview";
  answerIdentity.append(answerIcon, providerLabel, modelPreview);

  const timeControl = document.createElement("label");
  timeControl.className = "ai-chat-turn-time-control";
  const timeCaption = document.createElement("span");
  timeCaption.textContent = t("aiChat.timeLabel");
  const timeInput = document.createElement("input");
  timeInput.type = "datetime-local";
  timeInput.className = "ai-chat-time-input";
  timeInput.value = turnData.answeredAt;
  timeInput.step = "60";
  timeInput.title = formatLocalDateTime(turnData.answeredAt);
  timeControl.append(timeCaption, timeInput);
  answerMeta.append(answerIdentity, timeControl);

  const answerInput = document.createElement("textarea");
  answerInput.className = "ai-chat-answer-input";
  answerInput.value = turnData.answer;
  answerInput.maxLength = aiChatLimits.answerLength;
  answerInput.placeholder = t("aiChat.answerPlaceholder");
  answerInput.spellcheck = true;
  answerInput.rows = 4;
  answerMessage.append(answerMeta, answerInput);

  const handleInput = (event) => {
    if (event.target instanceof HTMLTextAreaElement) autoGrow(event.target);
    if (event.target === timeInput) timeInput.title = formatLocalDateTime(timeInput.value);
    syncEditorPreview(editor);
    onDirty?.(row);
  };
  [questionInput, answerInput, timeInput].forEach((control) => {
    control.addEventListener("input", handleInput);
    control.addEventListener("change", handleInput);
  });

  turn.append(turnHeader, questionMessage, answerMessage);
  requestAnimationFrame(() => {
    autoGrow(questionInput);
    autoGrow(answerInput);
  });
  return turn;
}

export function createAiChatEditor(row, value, { onDirty, htmlCache = "" } = {}) {
  const data = normalizeAiChatData(value);
  const editor = document.createElement("section");
  editor.className = "ai-chat-block-editor";
  editor.dataset.aiProvider = data.provider;
  editor.dataset.aiLayout = data.layout;
  editor.dataset.aiHideAnswerBorder = String(data.hideAnswerBorder);
  editor.dataset.aiPage = "0";
  editor.setAttribute("aria-label", t("aiChat.editorAria"));

  const editingSurface = document.createElement("div");
  editingSurface.className = "ai-chat-editing-surface";

  const titleRow = document.createElement("div");
  titleRow.className = "ai-chat-title-row";
  const titleInput = document.createElement("input");
  titleInput.type = "text";
  titleInput.className = "ai-chat-title-input";
  titleInput.value = data.title;
  titleInput.maxLength = aiChatLimits.titleLength;
  titleInput.placeholder = t("aiChat.titlePlaceholder");
  titleInput.setAttribute("aria-label", t("aiChat.titleAria"));
  titleRow.append(titleInput);

  const settings = document.createElement("div");
  settings.className = "ai-chat-settings";

  const providerField = document.createElement("div");
  providerField.className = "ai-chat-provider-field";
  const providerCaption = document.createElement("span");
  providerCaption.className = "ai-chat-setting-caption";
  providerCaption.textContent = t("aiChat.providerLabel");
  const providerPicker = document.createElement("div");
  providerPicker.className = "ai-chat-provider-picker";
  providerPicker.setAttribute("role", "group");
  providerPicker.setAttribute("aria-label", t("aiChat.providerAria"));

  aiProviderPresets.forEach((provider) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-chat-provider-option";
    button.dataset.aiProvider = provider.id;
    button.title = t("aiChat.chooseProvider", { provider: provider.label });
    button.setAttribute("aria-label", t("aiChat.chooseProvider", { provider: provider.label }));
    button.setAttribute("aria-pressed", String(provider.id === data.provider));
    button.append(createAiProviderIcon(provider.id), document.createTextNode(provider.label));
    button.addEventListener("click", () => {
      editor.dataset.aiProvider = provider.id;
      syncEditorPreview(editor);
      onDirty?.(row);
    });
    providerPicker.append(button);
  });
  providerField.append(providerCaption, providerPicker);

  const modelInput = document.createElement("input");
  modelInput.type = "text";
  modelInput.className = "ai-chat-model-input";
  modelInput.value = data.model;
  modelInput.maxLength = aiChatLimits.modelLength;
  modelInput.placeholder = t("aiChat.modelPlaceholder");
  modelInput.setAttribute("aria-label", t("aiChat.modelAria"));
  modelInput.autocomplete = "off";

  const layoutField = document.createElement("div");
  layoutField.className = "ai-chat-layout-field";
  const layoutCaption = document.createElement("span");
  layoutCaption.className = "ai-chat-setting-caption";
  layoutCaption.textContent = t("aiChat.layoutLabel");
  const layoutOptions = document.createElement("div");
  layoutOptions.className = "ai-chat-layout-options";
  layoutOptions.setAttribute("role", "group");
  layoutOptions.setAttribute("aria-label", t("aiChat.layoutAria"));
  [
    ["stacked", t("aiChat.layoutStacked")],
    ["paginated", t("aiChat.layoutPaginated")]
  ].forEach(([layout, label]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-chat-layout-option";
    button.dataset.aiLayout = layout;
    button.textContent = label;
    button.setAttribute("aria-pressed", String(layout === data.layout));
    button.addEventListener("click", () => {
      const nextLayout = normalizeLayout(layout);
      if (editor.dataset.aiLayout === nextLayout) return;
      editor.dataset.aiLayout = nextLayout;
      syncEditorPagination(editor);
      onDirty?.(row);
    });
    layoutOptions.append(button);
  });
  layoutField.append(layoutCaption, layoutOptions);

  const answerBorderField = document.createElement("label");
  answerBorderField.className = "ai-chat-answer-border-field";
  const answerBorderCheckbox = document.createElement("input");
  answerBorderCheckbox.type = "checkbox";
  answerBorderCheckbox.className = "ai-chat-answer-border-toggle";
  answerBorderCheckbox.checked = data.hideAnswerBorder;
  answerBorderCheckbox.setAttribute("aria-label", t("aiChat.hideAnswerBorder"));
  const answerBorderLabel = document.createElement("span");
  answerBorderLabel.textContent = t("aiChat.hideAnswerBorder");
  answerBorderField.append(answerBorderCheckbox, answerBorderLabel);
  answerBorderCheckbox.addEventListener("change", () => {
    editor.dataset.aiHideAnswerBorder = String(answerBorderCheckbox.checked);
    onDirty?.(row);
  });

  settings.append(
    providerField,
    createLabeledField(t("aiChat.modelLabel"), modelInput),
    layoutField,
    answerBorderField
  );

  const conversationViewport = document.createElement("div");
  conversationViewport.className = "ai-chat-conversation-viewport";
  const conversation = document.createElement("div");
  conversation.className = "ai-chat-conversation";
  data.turns.forEach((turnData) => {
    conversation.append(createTurnEditor(editor, row, turnData, { onDirty }));
  });
  conversationViewport.append(conversation);

  const pagination = document.createElement("nav");
  pagination.className = "ai-chat-pagination";
  pagination.setAttribute("aria-label", t("aiChat.paginationAria"));
  pagination.addEventListener("click", (event) => {
    const button = event.target.closest("button.ai-chat-page-button");
    if (!button || !pagination.contains(button)) return;
    const page = Number.parseInt(button.dataset.aiChatPage ?? "", 10);
    if (!Number.isInteger(page)) return;
    syncEditorPagination(editor, page);
  });

  const actions = document.createElement("div");
  actions.className = "ai-chat-actions";
  const addTurnButton = document.createElement("button");
  addTurnButton.type = "button";
  addTurnButton.className = "ai-chat-add-turn";
  addTurnButton.textContent = t("aiChat.addTurn");
  addTurnButton.title = t("aiChat.addTurnTitle");
  addTurnButton.addEventListener("click", () => {
    if (conversation.querySelectorAll(".ai-chat-turn").length >= aiChatLimits.turns) return;
    const turn = createTurnEditor(editor, row, normalizeTurn({ answeredAt: createLocalDateTimeValue() }), { onDirty });
    conversation.append(turn);
    editor.dataset.aiPage = String(conversation.querySelectorAll(".ai-chat-turn").length - 1);
    syncTurnControls(editor);
    syncEditorPreview(editor);
    onDirty?.(row);
    turn.querySelector(".ai-chat-question-input")?.focus();
  });
  actions.append(addTurnButton);

  const preview = document.createElement("div");
  preview.className = "block-rendered-preview ai-chat-rendered-preview";
  preview.innerHTML = htmlCache || "";
  hydrateRenderedAiChatPagination(preview);

  editingSurface.append(titleRow, settings, conversationViewport, pagination, actions);
  editor.append(editingSurface, preview);

  const handleInput = () => {
    syncEditorPreview(editor);
    onDirty?.(row);
  };
  [titleInput, modelInput].forEach((control) => {
    control.addEventListener("input", handleInput);
    control.addEventListener("change", handleInput);
  });

  syncEditorPreview(editor);
  syncTurnControls(editor);
  return editor;
}

export function extractAiChatData(row) {
  const editor = row?.querySelector(".ai-chat-block-editor");
  if (!editor) return createDefaultAiChatData();
  return normalizeAiChatData({
    title: editor.querySelector(".ai-chat-title-input")?.value ?? "",
    provider: editor.dataset.aiProvider,
    model: editor.querySelector(".ai-chat-model-input")?.value ?? "",
    layout: editor.dataset.aiLayout,
    hideAnswerBorder: editor.querySelector(".ai-chat-answer-border-toggle")?.checked === true,
    turns: [...editor.querySelectorAll(".ai-chat-turn")].map((turn) => ({
      answeredAt: turn.querySelector(".ai-chat-time-input")?.value ?? "",
      question: turn.querySelector(".ai-chat-question-input")?.value ?? "",
      answer: turn.querySelector(".ai-chat-answer-input")?.value ?? ""
    }))
  });
}

export function setRenderedAiChatPage(chat, requestedPage) {
  if (!(chat instanceof Element) || !chat.classList.contains("rendered-ai-chat--paginated")) return false;
  const track = chat.querySelector(".rendered-ai-chat-track");
  const turns = [...chat.querySelectorAll(".rendered-ai-chat-track > .rendered-ai-chat-turn")];
  if (!track || turns.length === 0) return false;

  const parsedPage = Number.parseInt(String(requestedPage), 10);
  if (!Number.isInteger(parsedPage)) return false;
  const page = Math.min(Math.max(parsedPage, 0), turns.length - 1);
  track.style.transform = `translateX(-${page * 100}%)`;

  turns.forEach((turn, index) => {
    const active = index === page;
    turn.classList.toggle("is-active", active);
    turn.setAttribute("aria-hidden", String(!active));
  });

  chat.querySelectorAll(".rendered-ai-chat-page").forEach((button, index) => {
    const active = index === page;
    button.classList.toggle("is-current", active);
    button.setAttribute("aria-label", t("aiChat.pageAria", { count: index + 1 }));
    if (active) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  });
  return true;
}

export function hydrateRenderedAiChatPagination(root = document) {
  const chats = [];
  if (root instanceof Element && root.matches(".rendered-ai-chat--paginated")) chats.push(root);
  root.querySelectorAll?.(".rendered-ai-chat--paginated").forEach((chat) => chats.push(chat));

  chats.forEach((chat) => {
    const pagination = chat.querySelector(".rendered-ai-chat-pagination");
    pagination?.setAttribute("aria-label", t("aiChat.paginationAria"));
    const current = [...chat.querySelectorAll(".rendered-ai-chat-page")]
      .findIndex((button) => button.getAttribute("aria-current") === "page");
    setRenderedAiChatPage(chat, current >= 0 ? current : 0);
  });
}
