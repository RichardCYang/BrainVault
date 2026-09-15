class FakeHTMLElement {}
globalThis.HTMLElement = FakeHTMLElement;

const instances = [];
class FakeIntersectionObserver {
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    this.targets = new Set();
    this.disconnectCalls = 0;
    instances.push(this);
  }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.disconnectCalls += 1; this.targets.clear(); }
}
globalThis.IntersectionObserver = FakeIntersectionObserver;

const { hydrateMermaidPreviews } = await import("../public/mermaid-block.js");
const { hydrateDatabaseUrlPreviews } = await import("../public/database-block.js");

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

const cycles = 40;
const targetsPerCycle = 500;
let previous = [];
for (let cycle = 0; cycle < cycles; cycle += 1) {
  for (const target of previous) target.isConnected = false;
  const targets = Array.from({ length: targetsPerCycle }, (_, index) => makeMermaidTarget(`${cycle}-${index}`));
  await hydrateMermaidPreviews({ querySelectorAll: () => targets });
  previous = targets;
}
const mermaidObserver = instances[0];

const databaseRoot = { current: [], querySelectorAll() { return this.current; } };
const fetchPreview = async () => null;
for (let cycle = 0; cycle < cycles; cycle += 1) {
  databaseRoot.current = Array.from({ length: targetsPerCycle }, (_, index) => ({
    dataset: { url: `https://example.test/${cycle}/${index}` },
    isConnected: true
  }));
  hydrateDatabaseUrlPreviews(databaseRoot, fetchPreview);
}
const databaseObserver = instances[1];

const legacyRetainedTargets = cycles * targetsPerCycle;
const report = {
  cycles,
  targetsPerCycle,
  legacyModelRetainedTargets: legacyRetainedTargets,
  mermaid: {
    currentObservedTargets: mermaidObserver.targets.size,
    disconnectCalls: mermaidObserver.disconnectCalls,
    avoidedStaleTargetRegistrations: legacyRetainedTargets - mermaidObserver.targets.size
  },
  databaseUrlPreview: {
    currentObservedTargets: databaseObserver.targets.size,
    disconnectCalls: databaseObserver.disconnectCalls,
    avoidedStaleTargetRegistrations: legacyRetainedTargets - databaseObserver.targets.size
  }
};

if (report.mermaid.currentObservedTargets !== targetsPerCycle) throw new Error("Mermaid observer retention is unbounded");
if (report.databaseUrlPreview.currentObservedTargets !== targetsPerCycle) throw new Error("Database URL preview observer retention is unbounded");

databaseRoot.current = [];
hydrateDatabaseUrlPreviews(databaseRoot, fetchPreview);
report.databaseUrlPreview.afterEmptyRenderObservedTargets = databaseObserver.targets.size;
if (databaseObserver.targets.size !== 0) throw new Error("Database URL preview targets survived an empty render");

console.log(JSON.stringify(report, null, 2));
