// @ts-check

const REMOTE_CARET_COLOR_COUNT = 64;

function getRemoteCaretColor(colorIndex) {
  const hue = (12 + colorIndex * 137.508) % 360;
  const saturation = 68 + (colorIndex % 3) * 4;
  const lightness = 36 + (colorIndex % 2) * 5;
  return `hsl(${hue.toFixed(1)} ${saturation}% ${lightness}%)`;
}

const MIRRORED_TEXT_PROPERTIES = Object.freeze([
  "direction",
  "box-sizing",
  "width",
  "height",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-style",
  "border-right-style",
  "border-bottom-style",
  "border-left-style",
  "padding-top",
  "padding-right",
  "padding-bottom",
  "padding-left",
  "font-family",
  "font-size",
  "font-style",
  "font-variant",
  "font-weight",
  "font-stretch",
  "font-size-adjust",
  "line-height",
  "letter-spacing",
  "word-spacing",
  "text-align",
  "text-transform",
  "text-indent",
  "text-decoration",
  "tab-size"
]);

function hashIdentity(value) {
  let hash = 2166136261;
  for (const character of String(value ?? "")) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function getRemoteCaretIdentity(client) {
  return String(client?.user?.id || client?.user?.username || client?.connectionId || "unknown");
}

export function getRemoteCaretClientKey(client) {
  return String(client?.connectionId || getRemoteCaretIdentity(client));
}

export function assignRemoteCaretColors(clients) {
  const identities = [...new Set((clients ?? []).map(getRemoteCaretIdentity))].sort();
  const identityColors = new Map();
  const usedIndexes = new Set();

  for (const identity of identities) {
    const startIndex = hashIdentity(identity) % REMOTE_CARET_COLOR_COUNT;
    let colorIndex = startIndex;
    for (let attempt = 0; attempt < REMOTE_CARET_COLOR_COUNT; attempt += 1) {
      const candidate = (startIndex + attempt) % REMOTE_CARET_COLOR_COUNT;
      if (!usedIndexes.has(candidate)) {
        colorIndex = candidate;
        usedIndexes.add(candidate);
        break;
      }
    }
    identityColors.set(identity, getRemoteCaretColor(colorIndex));
  }

  return new Map(
    (clients ?? []).map((client) => [
      getRemoteCaretClientKey(client),
      identityColors.get(getRemoteCaretIdentity(client)) ?? getRemoteCaretColor(0)
    ])
  );
}

export function getRowTextSelectionControls(row) {
  if (!row?.querySelectorAll) return [];
  return [...row.querySelectorAll("input, textarea")].filter((control) => {
    try {
      return typeof control.value === "string"
        && Number.isInteger(control.selectionStart)
        && Number.isInteger(control.selectionEnd);
    } catch {
      return false;
    }
  });
}

export function getTextSelectionControlKey(target, row) {
  const index = getRowTextSelectionControls(row).indexOf(target);
  return index >= 0 ? `text:${index}` : null;
}

export function getTextSelectionControlByKey(row, key) {
  const match = /^text:(\d{1,4})$/.exec(typeof key === "string" ? key : "");
  if (!match) return null;
  return getRowTextSelectionControls(row)[Number(match[1])] ?? null;
}

function parsePixels(value) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isViewportVisible(rect) {
  return rect.bottom >= 0
    && rect.right >= 0
    && rect.top <= window.innerHeight
    && rect.left <= window.innerWidth;
}

export function getTextControlCaretRect(control, requestedOffset) {
  if (!control || typeof control.value !== "string" || !document.body) return null;
  const controlRect = control.getBoundingClientRect();
  if (controlRect.width <= 0 || controlRect.height <= 0 || !isViewportVisible(controlRect)) return null;

  const computed = window.getComputedStyle(control);
  const offset = Math.max(0, Math.min(Number(requestedOffset) || 0, control.value.length));
  const mirror = document.createElement("div");
  const marker = document.createElement("span");

  mirror.className = "collaboration-caret-mirror";
  mirror.setAttribute("aria-hidden", "true");
  mirror.style.position = "fixed";
  mirror.style.zIndex = "-1";
  mirror.style.top = "0";
  mirror.style.left = "0";
  mirror.style.visibility = "hidden";
  mirror.style.pointerEvents = "none";
  mirror.style.overflow = "hidden";
  mirror.style.width = `${controlRect.width}px`;
  mirror.style.height = `${controlRect.height}px`;

  for (const property of MIRRORED_TEXT_PROPERTIES) {
    mirror.style.setProperty(property, computed.getPropertyValue(property));
  }

  const isInput = String(control.tagName).toUpperCase() === "INPUT";
  mirror.style.whiteSpace = isInput ? "pre" : "pre-wrap";
  mirror.style.overflowWrap = isInput ? "normal" : "break-word";
  mirror.style.wordBreak = computed.wordBreak;

  mirror.append(document.createTextNode(control.value.slice(0, offset)));
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);

  try {
    const mirrorRect = mirror.getBoundingClientRect();
    const markerRect = marker.getBoundingClientRect();
    const borderLeft = parsePixels(computed.borderLeftWidth);
    const borderRight = parsePixels(computed.borderRightWidth);
    const borderTop = parsePixels(computed.borderTopWidth);
    const borderBottom = parsePixels(computed.borderBottomWidth);
    const visibleLeft = controlRect.left + borderLeft;
    const visibleRight = controlRect.right - borderRight;
    const visibleTop = controlRect.top + borderTop;
    const visibleBottom = controlRect.bottom - borderBottom;
    const lineHeight = markerRect.height || parsePixels(computed.lineHeight) || parsePixels(computed.fontSize) * 1.2;
    const left = controlRect.left + markerRect.left - mirrorRect.left - Number(control.scrollLeft || 0);
    const top = controlRect.top + markerRect.top - mirrorRect.top - Number(control.scrollTop || 0);

    if (
      left < visibleLeft - 2
      || left > visibleRight + 2
      || top + lineHeight < visibleTop
      || top > visibleBottom
    ) return null;

    return {
      left: Math.max(visibleLeft, Math.min(left, visibleRight)),
      top: Math.max(visibleTop, Math.min(top, Math.max(visibleTop, visibleBottom - lineHeight))),
      height: Math.max(12, Math.min(lineHeight, Math.max(12, visibleBottom - visibleTop)))
    };
  } finally {
    mirror.remove();
  }
}
