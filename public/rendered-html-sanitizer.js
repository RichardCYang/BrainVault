const forbiddenRenderedTags = new Set(["script", "style", "svg", "math", "textarea", "xmp"]);

// Keep this set aligned with sanitize-html's server policy in src/lib/markdown.ts.
// The browser layer is defense-in-depth: it reconstructs a fresh DOM tree and
// never inserts server-provided nodes directly into the live document.
const allowedRenderedTags = new Set([
  "address", "article", "aside", "footer", "header", "h1", "h2", "h3", "h4", "h5", "h6",
  "hgroup", "main", "nav", "section", "blockquote", "dd", "div", "dl", "dt", "figcaption", "figure",
  "hr", "li", "menu", "ol", "p", "pre", "ul", "a", "abbr", "b", "bdi", "bdo", "br", "cite", "code",
  "data", "dfn", "em", "i", "kbd", "mark", "q", "rb", "rp", "rt", "rtc", "ruby", "s", "samp",
  "small", "span", "strong", "sub", "sup", "time", "u", "var", "wbr", "caption", "col", "colgroup",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "img", "input", "iframe", "details", "summary"
]);

const commonAllowedAttributes = Object.freeze({
  a: ["class", "href", "name", "target", "rel"],
  div: ["class", "data-latex", "data-math-display"],
  section: ["class"],
  article: ["class"],
  header: ["class"],
  small: ["class"],
  p: ["class"],
  img: ["src", "alt", "title", "width", "height", "loading", "referrerpolicy"],
  pre: ["class"],
  code: ["class"],
  span: ["class", "style", "data-latex", "data-math-display", "data-icon-value", "aria-hidden"],
  input: ["type", "checked", "disabled"],
  table: ["class"],
  thead: ["class"],
  tbody: ["class"],
  tr: ["class"],
  th: ["class", "scope"],
  td: ["class", "colspan"],
  time: ["class", "datetime"],
  iframe: ["class", "src", "title", "loading", "allowfullscreen", "referrerpolicy"],
  details: ["class", "open"],
  summary: ["class"],
  ul: ["class"],
  ol: ["class"],
  li: ["class"]
});

const renderedImageDataPattern = /^data:image\/(?:png|jpeg|webp|vnd\.microsoft\.icon|x-icon);base64,[a-z0-9+/]+={0,2}$/i;
const youtubeEmbedPattern = /^https:\/\/www\.youtube(?:-nocookie)?\.com\/embed\//i;
const booleanAttributes = new Set(["checked", "disabled", "open", "allowfullscreen"]);

function normalizeRenderedImageSource(value) {
  const source = typeof value === "string" ? value.trim() : "";
  if (!source) return "";
  if (source.startsWith("/") && !source.startsWith("//") && !source.includes("\\")) return source;
  return renderedImageDataPattern.test(source) ? source : "";
}

function normalizeRenderedHref(value) {
  const href = typeof value === "string" ? value.trim() : "";
  if (!href || href.startsWith("//")) return "";
  try {
    // A fixed synthetic base lets the URL parser classify relative references
    // without trusting the current document URL. It also catches whitespace or
    // character tricks around dangerous schemes that a regex can miss.
    const parsed = new URL(href, "https://brainvault.invalid/");
    if (!new Set(["http:", "https:", "mailto:"]).has(parsed.protocol)) return "";
    return href;
  } catch {
    return "";
  }
}

function normalizeSpanStyle(value) {
  const rules = [];
  for (const declaration of String(value ?? "").split(";")) {
    const separator = declaration.indexOf(":");
    if (separator < 0) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const cssValue = declaration.slice(separator + 1).trim();
    const allowed = (
      (property === "color" && /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(cssValue))
      || (property === "grid-column" && /^\d+(?: \/ span \d+)?$/.test(cssValue))
      || (property === "width" && /^(?:100|[1-9]?\d)%$/.test(cssValue))
    );
    if (allowed) rules.push(`${property}: ${cssValue}`);
  }
  return rules.join("; ");
}

function allowedAttributesFor(tagName, allowAiControls) {
  if (allowAiControls && tagName === "nav") return ["class", "aria-label"];
  if (allowAiControls && tagName === "section") return ["class", "aria-hidden"];
  if (allowAiControls && tagName === "button") {
    return ["class", "type", "data-ai-chat-page", "aria-label", "aria-current"];
  }
  return commonAllowedAttributes[tagName] ?? [];
}

function copySafeAttributes(source, target, tagName, allowAiControls) {
  for (const name of allowedAttributesFor(tagName, allowAiControls)) {
    if (!source.hasAttribute(name)) continue;
    let value = source.getAttribute(name) ?? "";

    if (tagName === "a" && name === "href") {
      value = normalizeRenderedHref(value);
      if (!value) continue;
    } else if (tagName === "img" && name === "src") {
      value = normalizeRenderedImageSource(value);
      if (!value) continue;
    } else if (tagName === "iframe" && name === "src") {
      value = value.trim();
      if (!youtubeEmbedPattern.test(value)) continue;
    } else if (tagName === "span" && name === "style") {
      value = normalizeSpanStyle(value);
      if (!value) continue;
    } else if (tagName === "button" && name === "type") {
      if (value.toLowerCase() !== "button") continue;
      value = "button";
    }

    if (booleanAttributes.has(name)) target.setAttribute(name, "");
    else target.setAttribute(name, value);
  }

  if (tagName === "a") {
    target.setAttribute("rel", "noopener noreferrer");
    target.setAttribute("target", "_blank");
  } else if (tagName === "img") {
    target.setAttribute("loading", "lazy");
    target.setAttribute("referrerpolicy", "no-referrer");
  }
}

function appendSanitizedNode(parent, node, allowAiControls) {
  if (node.nodeType === Node.TEXT_NODE) {
    parent.append(document.createTextNode(node.nodeValue ?? ""));
    return;
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return;

  const tagName = node.localName.toLowerCase();
  if (forbiddenRenderedTags.has(tagName)) return;

  const aiTag = allowAiControls && (tagName === "button" || tagName === "nav");
  if (!allowedRenderedTags.has(tagName) && !aiTag) {
    for (const child of [...node.childNodes]) appendSanitizedNode(parent, child, allowAiControls);
    return;
  }

  if (tagName === "input" && (node.getAttribute("type") ?? "").toLowerCase() !== "checkbox") return;
  if (tagName === "iframe" && !youtubeEmbedPattern.test((node.getAttribute("src") ?? "").trim())) return;
  if (tagName === "button" && (node.getAttribute("type") ?? "").toLowerCase() !== "button") return;

  const clean = document.createElement(tagName);
  copySafeAttributes(node, clean, tagName, allowAiControls);
  for (const child of [...node.childNodes]) appendSanitizedNode(clean, child, allowAiControls);
  parent.append(clean);
}

export function renderServerBlockHtml(target, html, { allowAiControls = false } = {}) {
  if (!(target instanceof Element)) return;
  target.replaceChildren();
  if (typeof html !== "string" || !html) return;

  const template = document.createElement("template");
  template.innerHTML = html;
  const fragment = document.createDocumentFragment();
  for (const child of [...template.content.childNodes]) appendSanitizedNode(fragment, child, allowAiControls);
  target.replaceChildren(fragment);
}
