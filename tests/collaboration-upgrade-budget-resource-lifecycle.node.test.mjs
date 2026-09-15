import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = (await readFile(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8"))
  .replace(/\r\n/g, "\n");
const methodStart = source.indexOf("  private consumeUnauthenticatedUpgradeBudget(sourceIp: string) {");
const methodEnd = source.indexOf("\n  private reserveUpgrade(", methodStart);
assert.ok(methodStart >= 0 && methodEnd > methodStart, "upgrade budget method must exist");
const methodSource = source
  .slice(methodStart, methodEnd)
  .replace("  private consumeUnauthenticatedUpgradeBudget(sourceIp: string)", "  consumeUnauthenticatedUpgradeBudget(sourceIp)");

function makeHarness(MapImpl = Map) {
  const collaborationResourceLimits = {
    unauthenticatedUpgradesPerIpPerMinute: 30,
    trackedUnauthenticatedUpgradeIps: 8
  };
  const Harness = new Function(
    "collaborationResourceLimits",
    `return class Harness {
      constructor() { this.unauthenticatedUpgradeWindows = new Map(); }
      ${methodSource}
    };`
  )(collaborationResourceLimits);
  const harness = new Harness();
  harness.unauthenticatedUpgradeWindows = new MapImpl();
  return harness;
}

class CountingMap extends Map {
  iteratorSteps = 0;
  entries() {
    const iterator = super.entries();
    const owner = this;
    return {
      next() {
        owner.iteratorSteps += 1;
        return iterator.next();
      },
      [Symbol.iterator]() { return this; }
    };
  }
  [Symbol.iterator]() {
    return this.entries();
  }
}

test("full fresh unauthenticated-upgrade tracking rejects new IPs without rescanning the whole table", () => {
  const harness = makeHarness(CountingMap);
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    for (let index = 0; index < 8; index += 1) {
      assert.equal(harness.consumeUnauthenticatedUpgradeBudget(`10.0.0.${index}`), true);
    }
    harness.unauthenticatedUpgradeWindows.iteratorSteps = 0;
    for (let index = 0; index < 1_000; index += 1) {
      assert.equal(harness.consumeUnauthenticatedUpgradeBudget(`203.0.${Math.floor(index / 256)}.${index % 256}`), false);
    }
    assert.ok(
      harness.unauthenticatedUpgradeWindows.iteratorSteps <= 1_000,
      `expected at most one oldest-entry probe per rejected IP, got ${harness.unauthenticatedUpgradeWindows.iteratorSteps}`
    );
    assert.equal(harness.unauthenticatedUpgradeWindows.size, 8);
  } finally {
    Date.now = originalNow;
  }
});

test("expired entries are evicted oldest-first and a renewed existing IP moves to the newest position", () => {
  const harness = makeHarness();
  const originalNow = Date.now;
  let now = 1_000_000;
  Date.now = () => now;
  try {
    for (let index = 0; index < 8; index += 1) {
      assert.equal(harness.consumeUnauthenticatedUpgradeBudget(`10.0.0.${index}`), true);
      now += 1;
    }

    now += 60_001;
    assert.equal(harness.consumeUnauthenticatedUpgradeBudget("10.0.0.0"), true);
    assert.equal([...harness.unauthenticatedUpgradeWindows.keys()].at(-1), "10.0.0.0");

    assert.equal(harness.consumeUnauthenticatedUpgradeBudget("203.0.113.9"), true);
    assert.equal(harness.unauthenticatedUpgradeWindows.has("203.0.113.9"), true);
    assert.equal(harness.unauthenticatedUpgradeWindows.size <= 8, true);
  } finally {
    Date.now = originalNow;
  }
});

test("active per-IP rate limiting semantics remain unchanged", () => {
  const harness = makeHarness();
  const originalNow = Date.now;
  Date.now = () => 1_000_000;
  try {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      assert.equal(harness.consumeUnauthenticatedUpgradeBudget("198.51.100.10"), true);
    }
    assert.equal(harness.consumeUnauthenticatedUpgradeBudget("198.51.100.10"), false);
    assert.equal(harness.unauthenticatedUpgradeWindows.get("198.51.100.10")?.attempts, 30);
  } finally {
    Date.now = originalNow;
  }
});
