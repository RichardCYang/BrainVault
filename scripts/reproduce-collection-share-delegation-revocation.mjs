import assert from "node:assert/strict";

function cascadeFrom(grants, rootGrantorId) {
  const byGrantor = new Map();
  for (const [userId, grant] of grants) {
    const children = byGrantor.get(grant.sharedBy) ?? [];
    children.push(userId);
    byGrantor.set(grant.sharedBy, children);
  }
  const removed = [];
  const queue = [rootGrantorId];
  const seen = new Set([rootGrantorId]);
  for (let index = 0; index < queue.length; index += 1) {
    for (const userId of byGrantor.get(queue[index]) ?? []) {
      if (seen.has(userId)) continue;
      seen.add(userId);
      removed.push(userId);
      queue.push(userId);
    }
  }
  return removed;
}

const seed = () => new Map([
  ["adminA", { permission: "ADMIN", sharedBy: "owner" }],
  ["adminB", { permission: "ADMIN", sharedBy: "adminA" }],
  ["writerC", { permission: "WRITE", sharedBy: "adminB" }],
  ["adminD", { permission: "ADMIN", sharedBy: "owner" }]
]);

const vulnerable = seed();
vulnerable.delete("adminA");
assert.equal(vulnerable.get("adminB")?.permission, "ADMIN");
assert.equal(vulnerable.get("writerC")?.permission, "WRITE");

const fixed = seed();
for (const userId of cascadeFrom(fixed, "adminA")) fixed.delete(userId);
fixed.delete("adminA");
assert.equal(fixed.has("adminB"), false);
assert.equal(fixed.has("writerC"), false);
assert.equal(fixed.get("adminD")?.sharedBy, "owner");

const reauthorized = seed();
reauthorized.set("adminB", { permission: "ADMIN", sharedBy: "owner" });
assert.deepEqual(cascadeFrom(reauthorized, "adminA"), []);
assert.equal(reauthorized.get("writerC")?.sharedBy, "adminB");

console.log(JSON.stringify({
  vulnerableAfterRootRemoval: [...vulnerable.entries()],
  fixedCascade: cascadeFrom(seed(), "adminA"),
  ownerReauthorizedCascade: cascadeFrom(reauthorized, "adminA")
}, null, 2));
