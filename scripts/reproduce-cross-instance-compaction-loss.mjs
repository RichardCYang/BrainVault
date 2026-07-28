import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = (relativePath) => normalize(readFileSync(join(root, relativePath), "utf8"));

function readGitFile(revision, relativePath) {
  try {
    return normalize(execFileSync(
      "git",
      ["show", `${revision}:${relativePath}`],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ));
  } catch {
    return null;
  }
}

function findVulnerableRevision() {
  const revisions = execFileSync("git", ["rev-list", "HEAD"], {
    cwd: root,
    encoding: "utf8"
  }).trim().split(/\s+/).filter(Boolean);
  for (const revision of revisions) {
    const server = readGitFile(revision, "src/lib/collaboration-server.ts");
    if (
      server
      && /if \(snapshot\) \{[\s\S]*SELECT MAX\(id\) AS max_update_id/.test(server)
      && !server.includes("assessCollaborationWriteCheckpoint")
    ) {
      return { revision, server };
    }
  }
  throw new Error("Unable to find the vulnerable cross-instance writer in Git history");
}

const vulnerableBaseline = findVulnerableRevision();
const fixedServer = read("src/lib/collaboration-server.ts");
const fixedProtocol = read("src/lib/collaboration-protocol.ts");

// The archived implementation checked the durable tip only for snapshots. A
// normal write could therefore advance a stale room's numeric max without ever
// incorporating the update that another process had just committed.
assert.match(
  vulnerableBaseline.server,
  /if \(snapshot\) \{\s*const currentRow[\s\S]*SELECT MAX\(id\) AS max_update_id/
);
assert.doesNotMatch(vulnerableBaseline.server, /roomUpdateId:\s*room\.maxUpdateId/);

// The fixed implementation checks every write while the page row is locked and
// reloads the entire room when durable history has advanced elsewhere.
const fixedWriteFence = fixedServer.slice(
  fixedServer.indexOf("const currentRow = await dbClient.queryOne"),
  fixedServer.indexOf("const insert = await dbClient.execute", fixedServer.indexOf("const currentRow = await dbClient.queryOne"))
);
assert.match(fixedWriteFence, /SELECT MAX\(id\) AS max_update_id/);
assert.match(fixedWriteFence, /assessCollaborationWriteCheckpoint/);
assert.match(fixedWriteFence, /roomUpdateId:\s*room\.maxUpdateId/);
assert.match(fixedServer, /result\.reason === "room-stale"[\s\S]*invalidateRoomForReload/);
assert.match(fixedProtocol, /roomUpdateId !== durableUpdateId/);
assert.match(fixedProtocol, /reason: "snapshot-base-mismatch"/);

function createDatabase() {
  return { nextId: 1, rows: [] };
}

function durableMax(database) {
  return database.rows.length ? database.rows.at(-1).id : 0;
}

function durableState(database) {
  let state = new Set();
  for (const row of database.rows) {
    if (row.snapshot) state = new Set(row.values);
    else for (const value of row.values) state.add(value);
  }
  return state;
}

function loadRoom(database, name) {
  return {
    name,
    values: durableState(database),
    maxUpdateId: durableMax(database),
    invalidated: false
  };
}

function applyToRoom(room, incomingValues) {
  return new Set([...room.values, ...incomingValues]);
}

function append(database, room, incomingValues, { snapshot = false, baseUpdateId = null } = {}) {
  const candidate = applyToRoom(room, incomingValues);
  const updateId = database.nextId;
  database.nextId += 1;
  const row = {
    id: updateId,
    snapshot,
    values: snapshot ? new Set(candidate) : new Set(incomingValues)
  };
  if (snapshot) database.rows = [row];
  else database.rows.push(row);
  room.values = candidate;
  room.maxUpdateId = updateId;
  return { accepted: true, updateId, baseUpdateId };
}

function vulnerableWrite(database, room, incomingValues, options = {}) {
  const { snapshot = false, baseUpdateId = null } = options;
  const currentUpdateId = durableMax(database);
  if (snapshot && baseUpdateId !== currentUpdateId) {
    return { accepted: false, reason: "snapshot-base-mismatch", currentUpdateId };
  }
  return append(database, room, incomingValues, options);
}

function fixedWrite(database, room, incomingValues, options = {}) {
  const { snapshot = false, baseUpdateId = null } = options;
  const currentUpdateId = durableMax(database);
  if (room.maxUpdateId !== currentUpdateId) {
    room.invalidated = true;
    return { accepted: false, reason: "room-stale", currentUpdateId };
  }
  if (snapshot && baseUpdateId !== currentUpdateId) {
    return { accepted: false, reason: "snapshot-base-mismatch", currentUpdateId };
  }
  return append(database, room, incomingValues, options);
}

// Vulnerable schedule: two application processes load the same tip. Process A
// commits A. Process B, which never received A, commits B and now has max ID 2
// despite its room containing only B. Its snapshot passes the ID check and
// compacts A out of the only durable history.
const vulnerableDatabase = createDatabase();
const vulnerableRoomA = loadRoom(vulnerableDatabase, "process-a");
const vulnerableRoomB = loadRoom(vulnerableDatabase, "process-b");
const vulnerableA = vulnerableWrite(vulnerableDatabase, vulnerableRoomA, ["edit-A"]);
const vulnerableB = vulnerableWrite(vulnerableDatabase, vulnerableRoomB, ["edit-B"]);
const durableBeforeVulnerableCompaction = durableState(vulnerableDatabase);
const vulnerableRoomBMaxBeforeSnapshot = vulnerableRoomB.maxUpdateId;
const vulnerableRoomBContainsEditABeforeSnapshot = vulnerableRoomB.values.has("edit-A");
const vulnerableSnapshot = vulnerableWrite(
  vulnerableDatabase,
  vulnerableRoomB,
  [],
  { snapshot: true, baseUpdateId: vulnerableRoomB.maxUpdateId }
);
const durableAfterVulnerableCompaction = durableState(vulnerableDatabase);

assert.equal(vulnerableA.accepted, true);
assert.equal(vulnerableB.accepted, true);
assert.deepEqual([...durableBeforeVulnerableCompaction].sort(), ["edit-A", "edit-B"]);
assert.equal(vulnerableRoomBContainsEditABeforeSnapshot, false);
assert.equal(vulnerableRoomBMaxBeforeSnapshot, 2);
assert.equal(vulnerableSnapshot.accepted, true);
assert.deepEqual([...durableAfterVulnerableCompaction], ["edit-B"]);

// Fixed schedule: B's first normal write is rejected before insertion because
// the durable max no longer equals its room max. Reconnecting rebuilds B from
// durable history, after which retry and compaction preserve both edits.
const fixedDatabase = createDatabase();
const fixedRoomA = loadRoom(fixedDatabase, "process-a");
let fixedRoomB = loadRoom(fixedDatabase, "process-b");
const fixedA = fixedWrite(fixedDatabase, fixedRoomA, ["edit-A"]);
const staleB = fixedWrite(fixedDatabase, fixedRoomB, ["edit-B"]);
const durableAfterRejectedStaleWrite = durableState(fixedDatabase);
assert.equal(fixedA.accepted, true);
assert.deepEqual(staleB, { accepted: false, reason: "room-stale", currentUpdateId: 1 });
assert.equal(fixedRoomB.invalidated, true);
assert.deepEqual([...durableAfterRejectedStaleWrite], ["edit-A"]);

fixedRoomB = loadRoom(fixedDatabase, "process-b-reloaded");
const retriedB = fixedWrite(fixedDatabase, fixedRoomB, ["edit-B"]);
const fixedSnapshot = fixedWrite(
  fixedDatabase,
  fixedRoomB,
  [],
  { snapshot: true, baseUpdateId: fixedRoomB.maxUpdateId }
);
const durableAfterFixedCompaction = durableState(fixedDatabase);

assert.equal(retriedB.accepted, true);
assert.equal(fixedSnapshot.accepted, true);
assert.deepEqual([...durableAfterFixedCompaction].sort(), ["edit-A", "edit-B"]);

console.log(JSON.stringify({
  baselineCommit: vulnerableBaseline.revision,
  vulnerable: {
    processAUpdateId: vulnerableA.updateId,
    staleProcessBUpdateAccepted: vulnerableB.accepted,
    processBRoomMaxAfterWrite: vulnerableRoomBMaxBeforeSnapshot,
    processBRoomContainsEditA: vulnerableRoomBContainsEditABeforeSnapshot,
    durableBeforeCompaction: [...durableBeforeVulnerableCompaction].sort(),
    staleSnapshotAccepted: vulnerableSnapshot.accepted,
    durableAfterCompaction: [...durableAfterVulnerableCompaction].sort(),
    permanentLossWindowReproduced:
      durableBeforeVulnerableCompaction.has("edit-A")
      && !durableAfterVulnerableCompaction.has("edit-A")
  },
  fixed: {
    staleNormalWriteRejected: !staleB.accepted && staleB.reason === "room-stale",
    staleRoomInvalidated: true,
    durableAfterRejectedWrite: [...durableAfterRejectedStaleWrite].sort(),
    retryAfterReloadAccepted: retriedB.accepted,
    snapshotAfterReloadAccepted: fixedSnapshot.accepted,
    durableAfterCompaction: [...durableAfterFixedCompaction].sort(),
    permanentLossWindowClosed:
      durableAfterFixedCompaction.has("edit-A")
      && durableAfterFixedCompaction.has("edit-B")
  }
}, null, 2));
