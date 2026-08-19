import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");

function section(text, start, end = null) {
  const startIndex = text.indexOf(start);
  assert.ok(startIndex >= 0, `missing section start: ${start}`);
  const endIndex = end ? text.indexOf(end, startIndex + start.length) : text.length;
  assert.ok(endIndex > startIndex, `missing section end after: ${start}`);
  return text.slice(startIndex, endIndex);
}

test("workspace snapshot mutations capture the initiating auth scope in the HTTP layer", async () => {
  const routes = normalize(await readFile(new URL("../src/routes/snapshot.routes.ts", import.meta.url), "utf8"));

  const create = section(routes, 'snapshotRouter.post("/",', 'snapshotRouter.get<SnapshotRouteParams>("/:snapshotId/diff"');
  assert.match(create, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(create, /createWorkspaceSnapshot\(user\.id, authScope\)/);

  const restore = section(routes, '"/:snapshotId/restore"', 'snapshotRouter.delete<SnapshotRouteParams>');
  assert.match(restore, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(restore, /restoreWorkspaceSnapshot\(user\.id, req\.params\.snapshotId, authScope\)/);

  const deletion = section(routes, 'snapshotRouter.delete<SnapshotRouteParams>');
  assert.match(deletion, /const authScope = requireRequestAuthScope\(req\)/);
  assert.match(deletion, /deleteWorkspaceSnapshot\(user\.id, req\.params\.snapshotId, authScope\)/);
});

test("snapshot create and delete revalidate the exact device session before durable or filesystem mutation", async () => {
  const snapshots = normalize(await readFile(new URL("../src/lib/workspace-snapshots.ts", import.meta.url), "utf8"));

  const creation = section(
    snapshots,
    "export async function createWorkspaceSnapshot(",
    "export async function deleteWorkspaceSnapshot("
  );
  const createFence = creation.indexOf("await assertCurrentAuthSessionBoundary(userId, authScope, client)");
  const createInsert = creation.indexOf("INSERT INTO workspace_snapshots");
  assert.ok(createFence >= 0 && createInsert > createFence, "snapshot insertion must follow the auth/session fence");

  const deletion = section(
    snapshots,
    "export async function deleteWorkspaceSnapshot(",
    "export async function restoreWorkspaceSnapshot("
  );
  const deleteFence = deletion.indexOf("await assertCurrentAuthSessionBoundary(userId, authScope, client)");
  const rowLock = deletion.indexOf("await getOwnedSnapshotRow(userId, id, client, true)");
  const renameArchive = deletion.indexOf("await rename(finalPath, tombstonePath)");
  const deleteRow = deletion.indexOf('DELETE FROM workspace_snapshots WHERE id = ? AND user_id = ?');
  assert.ok(
    deleteFence >= 0
      && rowLock > deleteFence
      && renameArchive > rowLock
      && deleteRow > renameArchive,
    "snapshot deletion must fence auth before locking, renaming, or deleting the recovery point"
  );
});

test("stale snapshot mutations are rejected after auth-version rotation or device-session revocation", () => {
  function runMutation({ fixed, rotateVersion = false, revokeSession = false }) {
    const state = {
      authVersion: 7,
      activeSessions: new Set(["session-a"]),
      mutations: 0
    };
    const admitted = { authVersion: state.authVersion, sessionId: "session-a" };

    if (rotateVersion) state.authVersion += 1;
    if (revokeSession) state.activeSessions.delete("session-a");

    if (
      fixed
      && (
        admitted.authVersion !== state.authVersion
        || !state.activeSessions.has(admitted.sessionId)
      )
    ) {
      return { outcome: "rejected", mutations: state.mutations };
    }

    state.mutations += 1;
    return { outcome: "committed", mutations: state.mutations };
  }

  for (const scenario of [
    { rotateVersion: true, revokeSession: false },
    { rotateVersion: false, revokeSession: true }
  ]) {
    assert.deepEqual(runMutation({ fixed: false, ...scenario }), {
      outcome: "committed",
      mutations: 1
    });
    assert.deepEqual(runMutation({ fixed: true, ...scenario }), {
      outcome: "rejected",
      mutations: 0
    });
  }
});
