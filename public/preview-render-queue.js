// A page can add thousands of previews in a single DOM update. Show the source
// immediately and share a small animation-frame budget among the renderers.
const pending = new Map();
const maxPendingPreviews = 256;
let frame = null;
let drained = null;
let resolveDrained;

function renderFrame() {
  const started = performance.now();
  let count = 0;
  for (const [element, render] of pending) {
    pending.delete(element);
    if (element.isConnected) {
      try { render(); }
      catch { /* Keep the source preview available if its renderer fails. */ }
    }
    if (++count >= 20 || performance.now() - started >= 8) break;
  }
  if (pending.size) frame = requestAnimationFrame(renderFrame);
  else {
    frame = null;
    resolveDrained();
    drained = null;
  }
}

export function schedulePreviewRender(element, render) {
  if (!pending.has(element) && pending.size >= maxPendingPreviews) return;
  pending.set(element, render);
  if (frame === null) {
    drained = new Promise((resolve) => { resolveDrained = resolve; });
    frame = requestAnimationFrame(renderFrame);
  }
}

export function waitForPreviewRendering() {
  return drained ?? Promise.resolve();
}
