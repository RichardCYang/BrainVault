import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

class FakeHTMLElement {}
globalThis.HTMLElement = FakeHTMLElement;

const observerInstances = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnectCalls = 0;
    observerInstances.push(this);
  }

  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() {
    this.disconnectCalls += 1;
    this.targets.clear();
  }
}
globalThis.IntersectionObserver = FakeIntersectionObserver;

const mermaidModuleUrl = new URL("../public/mermaid-block.js", import.meta.url);
const databaseModuleUrl = new URL("../public/database-block.js", import.meta.url);
const { hydrateMermaidPreviews } = await import(`${mermaidModuleUrl.href}?resource-lifecycle`);
const { hydrateDatabaseUrlPreviews } = await import(`${databaseModuleUrl.href}?resource-lifecycle`);

function makeMermaidTarget(id) {
  const target = new FakeHTMLElement();
  target.dataset = { mermaidSource: `flowchart TD; A${id}-->B${id}` };
  target.isConnected = true;
  target.classList = { remove() {}, add() {} };
  target.replaceChildren = () => {};
  target.append = () => {};
  target.querySelector = () => null;
  target.getAttribute = () => "Mermaid diagram";
  return target;
}

test("Mermaid lazy hydration releases previous render targets before observing the current page", async () => {
  const firstObserverIndex = observerInstances.length;
  const perPage = 100;
  let previous = [];

  for (let page = 0; page < 8; page += 1) {
    for (const target of previous) target.isConnected = false;
    const previews = Array.from({ length: perPage }, (_, index) => makeMermaidTarget(`${page}-${index}`));
    await hydrateMermaidPreviews({ querySelectorAll: () => previews });
    previous = previews;
  }

  const observer = observerInstances[firstObserverIndex];
  assert.ok(observer);
  assert.equal(observer.targets.size, perPage);
  assert.equal(observer.disconnectCalls, 7);

  await hydrateMermaidPreviews({ querySelectorAll: () => [] });
  assert.equal(observer.targets.size, 0);
  assert.equal(observer.disconnectCalls, 8);
});

test("database URL preview hydration bounds observed targets to the current render and releases them on an empty render", () => {
  const firstObserverIndex = observerInstances.length;
  const root = {
    current: [],
    querySelectorAll() { return this.current; }
  };
  const fetchPreview = async () => null;
  const perRender = 100;

  for (let render = 0; render < 8; render += 1) {
    root.current = Array.from({ length: perRender }, (_, index) => ({
      dataset: { url: `https://example.test/${render}/${index}` },
      isConnected: true
    }));
    hydrateDatabaseUrlPreviews(root, fetchPreview);
  }

  const observer = observerInstances[firstObserverIndex];
  assert.ok(observer);
  assert.equal(observer.targets.size, perRender);
  assert.equal(observer.disconnectCalls, 7);

  root.current = [];
  hydrateDatabaseUrlPreviews(root, fetchPreview);
  assert.equal(observer.targets.size, 0);
  assert.equal(observer.disconnectCalls, 8);
});

test("AI citation lazy hydration disconnects old registrations before an empty or replacement render", async () => {
  const source = await readFile(new URL("../public/ai-chat-block.js", import.meta.url), "utf8");
  const start = source.indexOf("export function hydrateRenderedAiChatLinks");
  const end = source.indexOf("\nfunction normalizeText", start);
  const body = source.slice(start, end);
  const disconnectOffset = body.indexOf("observerState?.observer?.disconnect()");
  const emptyReturnOffset = body.indexOf("if (!citations.length) return;");
  const observeOffset = body.indexOf("citations.forEach((citation) => observerState.observer.observe(citation))");

  assert.ok(disconnectOffset >= 0, "AI link hydration must disconnect the previous observer registrations");
  assert.ok(emptyReturnOffset > disconnectOffset, "empty rerenders must release old AI citation targets before returning");
  assert.ok(observeOffset > emptyReturnOffset, "only the current citation targets should be registered after cleanup");
});
