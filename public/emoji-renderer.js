// BrainVault renders Unicode emoji with Twemoji to avoid OS/font-dependent fallback
// artifacts for multi-codepoint and Emoji 17 sequences. Twemoji graphics are
// licensed under CC BY 4.0: https://github.com/jdecked/twemoji/blob/main/LICENSE-GRAPHICS

const twemojiVersion = "17.0.3";
const twemojiSvgBase = `https://cdn.jsdelivr.net/gh/jdecked/twemoji@${twemojiVersion}/assets/svg/`;
const failedTwemojiAssetKeys = new Set();
const zeroWidthJoiner = "\u200d";

export function getTwemojiAssetKey(value) {
  if (typeof value !== "string" || !value) return null;

  // Twemoji drops VS16 for standalone/keycap emoji (for example ❤️ -> 2764),
  // but keeps VS16 inside ZWJ sequences because those asset filenames include it.
  const normalizedValue = value.includes(zeroWidthJoiner) ? value : value.replace(/\ufe0f/g, "");
  const codePoints = [];
  for (const character of normalizedValue) {
    const codePoint = character.codePointAt(0);
    if (!Number.isInteger(codePoint)) continue;
    codePoints.push(codePoint.toString(16));
  }
  return codePoints.length ? codePoints.join("-") : null;
}

function createNativeEmojiVisual(value) {
  const span = document.createElement("span");
  span.className = "app-icon-emoji";
  span.textContent = value;
  span.setAttribute("aria-hidden", "true");
  return span;
}

export function createEmojiVisual(value) {
  const assetKey = getTwemojiAssetKey(value);
  if (!assetKey || failedTwemojiAssetKeys.has(assetKey)) return createNativeEmojiVisual(value);

  const image = document.createElement("img");
  image.className = "app-icon-emoji-image";
  image.src = `${twemojiSvgBase}${assetKey}.svg`;
  image.alt = "";
  image.decoding = "async";
  image.loading = "lazy";
  image.referrerPolicy = "no-referrer";
  image.draggable = false;
  image.setAttribute("aria-hidden", "true");
  image.addEventListener(
    "error",
    () => {
      failedTwemojiAssetKeys.add(assetKey);
      image.replaceWith(createNativeEmojiVisual(value));
    },
    { once: true }
  );
  return image;
}

export function renderEmojiVisual(container, value) {
  container.replaceChildren(createEmojiVisual(value));
}
