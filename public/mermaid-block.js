// @ts-check
import { BLOCK_MARKDOWN_MAX_LENGTH } from "./editor-content-limits.js";

// Pin Mermaid so a future upstream release cannot silently change rendering or
// security behavior for an existing BrainVault deployment.
export const MERMAID_VERSION = "11.17.2";
export const MERMAID_SCRIPT_URL = `/vendor/mermaid/${MERMAID_VERSION}/mermaid.min.js`;

const previewRevisions = new WeakMap();
const previewTimers = new WeakMap();
let renderSequence = 0;
let mermaidModulePromise = null;
let renderQueue = Promise.resolve();

function getTheme() {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

function rememberPreviewState(target, source, options = {}) {
  target.dataset.mermaidSource = String(source ?? "");
  target.dataset.mermaidEmptyLabel = options.emptyText ?? "";
  target.dataset.mermaidRenderingLabel = options.renderingText ?? "";
  target.dataset.mermaidErrorLabel = options.errorText ?? "";
  target.dataset.mermaidPreviewLabel = options.previewLabel ?? target.getAttribute("aria-label") ?? "Mermaid diagram";
}

function readPreviewOptions(target) {
  return {
    emptyText: target.dataset.mermaidEmptyLabel ?? "",
    renderingText: target.dataset.mermaidRenderingLabel ?? "",
    errorText: target.dataset.mermaidErrorLabel ?? "",
    previewLabel: target.dataset.mermaidPreviewLabel ?? target.getAttribute("aria-label") ?? "Mermaid diagram"
  };
}

function setPreviewMessage(target, state, message) {
  target.classList.remove("is-empty", "is-rendering", "is-invalid", "is-rendered");
  target.classList.add(state);
  target.replaceChildren();
  const messageElement = document.createElement("span");
  messageElement.className = "mermaid-block-message";
  messageElement.textContent = message;
  target.append(messageElement);
}

async function loadMermaid() {
  if (!mermaidModulePromise) {
    mermaidModulePromise = new Promise((resolve, reject) => {
      const loaded = globalThis.mermaid;
      if (loaded) {
        resolve(loaded);
        return;
      }

      const script = document.createElement("script");
      script.src = MERMAID_SCRIPT_URL;
      script.async = true;
      script.dataset.brainvaultMermaid = MERMAID_VERSION;
      script.addEventListener("load", () => {
        const mermaid = globalThis.mermaid;
        if (!mermaid) {
          reject(new Error("The local Mermaid bundle did not expose the Mermaid API"));
          return;
        }
        resolve(mermaid);
      }, { once: true });
      script.addEventListener("error", () => {
        reject(new Error("The local Mermaid bundle could not be loaded"));
      }, { once: true });
      document.head.append(script);
    }).catch((error) => {
      mermaidModulePromise = null;
      throw error;
    });
  }
  return mermaidModulePromise;
}

function extractSandboxFrame(renderedSvg, previewLabel) {
  const template = document.createElement("template");
  template.innerHTML = renderedSvg;
  const sourceFrames = template.content.querySelectorAll("iframe");
  if (sourceFrames.length !== 1) throw new Error("Mermaid sandbox output did not contain exactly one iframe");

  const sourceFrame = sourceFrames[0];
  const source = sourceFrame.getAttribute("src") ?? "";
  if (!/^data:text\/html(?:;charset=utf-8)?;base64,/i.test(source)) {
    throw new Error("Mermaid sandbox output used an unexpected iframe source");
  }

  // Rebuild the iframe instead of inserting Mermaid's HTML verbatim. Mermaid's
  // sandbox output currently grants popup/navigation capabilities to generated
  // frames; BrainVault diagrams do not need those privileges.
  const frame = document.createElement("iframe");
  frame.className = "mermaid-sandbox-frame";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("title", previewLabel);
  frame.setAttribute("loading", "eager");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.addEventListener("load", () => {
    frame.dataset.mermaidLoaded = "true";
  }, { once: true });
  frame.src = source;

  const originalHeight = sourceFrame.style.height;
  if (/^\d+(?:\.\d+)?px$/.test(originalHeight)) {
    const height = Math.min(2400, Math.max(160, Number.parseFloat(originalHeight)));
    frame.style.height = `${height}px`;
  }
  return frame;
}

export function renderMermaidPreview(target, source, options = {}) {
  if (!(target instanceof HTMLElement)) return Promise.resolve(false);
  rememberPreviewState(target, source, options);

  const normalizedSource = String(source ?? "").trim();
  const revision = (previewRevisions.get(target) ?? 0) + 1;
  previewRevisions.set(target, revision);

  if (!normalizedSource) {
    delete target.dataset.mermaidRenderedKey;
    setPreviewMessage(target, "is-empty", options.emptyText ?? "");
    return Promise.resolve(true);
  }
  if (normalizedSource.length > BLOCK_MARKDOWN_MAX_LENGTH) {
    delete target.dataset.mermaidRenderedKey;
    setPreviewMessage(target, "is-invalid", options.errorText ?? "");
    return Promise.resolve(false);
  }

  const renderKey = `${getTheme()}\u0000${normalizedSource}`;
  if (target.dataset.mermaidRenderedKey === renderKey && target.querySelector(".mermaid-sandbox-frame")) {
    return Promise.resolve(true);
  }

  setPreviewMessage(target, "is-rendering", options.renderingText ?? "");

  const task = renderQueue.then(async () => {
    if (previewRevisions.get(target) !== revision || !target.isConnected) return false;
    const mermaid = await loadMermaid();
    if (previewRevisions.get(target) !== revision || !target.isConnected) return false;

    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "sandbox",
      suppressErrorRendering: true,
      maxTextSize: BLOCK_MARKDOWN_MAX_LENGTH,
      theme: getTheme()
    });

    const id = `brainvault-mermaid-${Date.now().toString(36)}-${(renderSequence += 1).toString(36)}`;
    const result = await mermaid.render(id, normalizedSource);
    if (previewRevisions.get(target) !== revision || !target.isConnected) return false;

    const frame = extractSandboxFrame(result.svg, options.previewLabel ?? target.getAttribute("aria-label") ?? "Mermaid diagram");
    target.classList.remove("is-empty", "is-rendering", "is-invalid");
    target.classList.add("is-rendered");
    target.replaceChildren(frame);
    target.dataset.mermaidRenderedKey = renderKey;
    return true;
  }).catch((error) => {
    if (previewRevisions.get(target) === revision && target.isConnected) {
      delete target.dataset.mermaidRenderedKey;
      setPreviewMessage(target, "is-invalid", options.errorText ?? "");
    }
    console.warn("Mermaid diagram rendering failed", error);
    return false;
  });

  // Keep renderer configuration deterministic: Mermaid's configuration is
  // process-global, so diagram renders are serialized across live previews.
  renderQueue = task.then(() => undefined, () => undefined);
  return task;
}

export function scheduleMermaidPreview(target, source, options = {}, delay = 260) {
  if (!(target instanceof HTMLElement)) return;
  rememberPreviewState(target, source, options);
  const activeTimer = previewTimers.get(target);
  if (activeTimer) window.clearTimeout(activeTimer);

  if (!String(source ?? "").trim()) {
    void renderMermaidPreview(target, source, options);
    return;
  }

  const timer = window.setTimeout(() => {
    previewTimers.delete(target);
    void renderMermaidPreview(target, source, options);
  }, delay);
  previewTimers.set(target, timer);
}

export function hydrateMermaidPreviews(root = document, { force = false } = {}) {
  const previews = [...root.querySelectorAll(".mermaid-block-preview")];
  return Promise.allSettled(previews.map((preview) => {
    const target = /** @type {HTMLElement} */ (preview);
    if (force) delete target.dataset.mermaidRenderedKey;
    return renderMermaidPreview(target, target.dataset.mermaidSource ?? "", readPreviewOptions(target));
  }));
}
