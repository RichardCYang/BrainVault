import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `missing section end: ${end}`);
  return source.slice(startIndex, endIndex);
}

function assertMutationBoundary(source, {
  scopeMarker = "const authScope = requireRequestAuthScope(req);",
  lockMarker,
  boundaryMarker = "await assertCurrentAuthSessionBoundary(currentUser.id, authScope, client);",
  mutationMarker
}) {
  const scopeIndex = source.indexOf(scopeMarker);
  const lockIndex = source.indexOf(lockMarker);
  const boundaryIndex = source.indexOf(boundaryMarker);
  const mutationIndex = source.indexOf(mutationMarker);

  assert.ok(scopeIndex >= 0, "request must capture the admitted auth/workspace scope");
  assert.ok(lockIndex >= 0, "mutation must run behind the restore serialization lock/transaction");
  assert.ok(boundaryIndex > lockIndex, "auth/workspace generation must be revalidated after the lock is acquired");
  assert.ok(mutationIndex > boundaryIndex, "no restored-state mutation may run before the commit-boundary check");
}

test("restored account/navigation mutations reject requests admitted before workspace restore", async () => {
  const source = normalize(await readFile(new URL("../src/routes/auth.routes.ts", import.meta.url), "utf8"));

  const navigationPreferences = section(
    source,
    'authRouter.patch(\n  "/navigation-preferences"',
    'authRouter.patch(\n  "/navigation-order"'
  );
  assertMutationBoundary(navigationPreferences, {
    lockMarker: "SELECT id FROM users WHERE id = ? FOR UPDATE",
    mutationMarker: "INSERT IGNORE INTO user_navigation_collapsed_pages"
  });

  const navigationOrder = section(
    source,
    'authRouter.patch(\n  "/navigation-order"',
    'authRouter.get("/sessions"'
  );
  assertMutationBoundary(navigationOrder, {
    lockMarker: "SELECT id FROM users WHERE id = ? FOR UPDATE",
    mutationMarker: "INSERT INTO user_navigation_page_order"
  });

  const profile = section(
    source,
    'authRouter.patch("/profile"',
    'authRouter.post(\n  "/password"'
  );
  assertMutationBoundary(profile, {
    lockMarker: "transaction(async (client) => {",
    mutationMarker: 'client.execute(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`'
  });
});

test("workspace-generation race model preserves same-generation writes and rejects stale ones", () => {
  const canCommit = (admittedGeneration, committedGeneration) =>
    admittedGeneration === committedGeneration;

  assert.equal(canCommit(12, 13), false, "pre-restore request must not write after generation 13 commits");
  assert.equal(canCommit(13, 13), true, "ordinary same-generation mutations must continue to work");
});
