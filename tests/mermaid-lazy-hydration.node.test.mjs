import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

class FakeHTMLElement {}
globalThis.HTMLElement = FakeHTMLElement;

const observed = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
  }
  observe(target) { observed.push(target); }
  unobserve() {}
  disconnect() {}
}
globalThis.IntersectionObserver = FakeIntersectionObserver;

const { hydrateMermaidPreviews } = await import("../public/mermaid-block.js");

function makeTarget(source = "flowchart TD; A-->B") {
  const target = new FakeHTMLElement();
  target.dataset = { mermaidSource: source };
  target.isConnected = true;
  target.classList = { remove() {}, add() {} };
  target.replaceChildren = () => { target.renderTouched = true; };
  target.append = () => {};
  target.querySelector = () => null;
  target.getAttribute = () => "Mermaid diagram";
  return target;
}

test("interactive Mermaid hydration defers offscreen diagrams to IntersectionObserver", async () => {
  observed.length = 0;
  const previews = Array.from({ length: 500 }, () => makeTarget());
  const root = { querySelectorAll: () => previews };

  const result = await hydrateMermaidPreviews(root);

  assert.deepEqual(result, []);
  assert.equal(observed.length, previews.length);
  assert.equal(previews.some((target) => target.renderTouched), false);
});

test("force hydration invalidates cached render keys without eagerly rendering offscreen diagrams", async () => {
  observed.length = 0;
  const target = makeTarget();
  target.dataset.mermaidRenderedKey = "old-theme";

  await hydrateMermaidPreviews({ querySelectorAll: () => [target] }, { force: true });

  assert.equal("mermaidRenderedKey" in target.dataset, false);
  assert.equal(target.renderTouched, undefined);
  assert.equal(observed.length, 1);
});


test("PDF export keeps Mermaid hydration eager", () => {
  const appSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  assert.match(
    appSource,
    /await hydrateMermaidPreviews\(elements\.pageView, \{ eager: true \}\);/,
  );
});
