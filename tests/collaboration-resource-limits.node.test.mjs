import assert from "node:assert/strict";
import test from "node:test";
import {
  assessCollaborationConnectionAdmission,
  assessCollaborationUpgradeAdmission,
  assessCollaborationWriteAdmission,
  collaborationResourceLimits
} from "../src/lib/collaboration-resource-limits.ts";

test("collaboration connection limits reject the first allocation beyond each boundary", () => {
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: collaborationResourceLimits.connectionsPerServer - 1,
      pageConnections: collaborationResourceLimits.connectionsPerPage - 1,
      userConnections: collaborationResourceLimits.connectionsPerUser - 1
    }),
    { accepted: true }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: collaborationResourceLimits.connectionsPerServer,
      pageConnections: 0,
      userConnections: 0
    }),
    { accepted: false, reason: "server-connections" }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: 0,
      pageConnections: collaborationResourceLimits.connectionsPerPage,
      userConnections: 0
    }),
    { accepted: false, reason: "page-connections" }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: 0,
      pageConnections: 0,
      userConnections: collaborationResourceLimits.connectionsPerUser
    }),
    { accepted: false, reason: "user-connections" }
  );
});

test("collaboration upgrade reservations bound database work before socket admission", () => {
  assert.deepEqual(
    assessCollaborationUpgradeAdmission({
      pendingUpgrades: collaborationResourceLimits.pendingUpgradesPerServer - 1,
      pendingUserUpgrades: collaborationResourceLimits.pendingUpgradesPerUser - 1
    }),
    { accepted: true }
  );
  assert.deepEqual(
    assessCollaborationUpgradeAdmission({
      pendingUpgrades: collaborationResourceLimits.pendingUpgradesPerServer,
      pendingUserUpgrades: 0
    }),
    { accepted: false, reason: "server-upgrades" }
  );
  assert.deepEqual(
    assessCollaborationUpgradeAdmission({
      pendingUpgrades: 0,
      pendingUserUpgrades: collaborationResourceLimits.pendingUpgradesPerUser
    }),
    { accepted: false, reason: "user-upgrades" }
  );
});

test("collaboration write admission bounds both queued operations and retained update bytes", () => {
  assert.deepEqual(
    assessCollaborationWriteAdmission({
      pendingWrites: collaborationResourceLimits.pendingWritesPerRoom - 1,
      pendingWriteBytes: collaborationResourceLimits.pendingWriteBytesPerRoom - 1,
      nextWriteBytes: 1
    }),
    { accepted: true }
  );
  assert.deepEqual(
    assessCollaborationWriteAdmission({
      pendingWrites: collaborationResourceLimits.pendingWritesPerRoom,
      pendingWriteBytes: 0,
      nextWriteBytes: 1
    }),
    { accepted: false, reason: "write-count" }
  );
  assert.deepEqual(
    assessCollaborationWriteAdmission({
      pendingWrites: 0,
      pendingWriteBytes: collaborationResourceLimits.pendingWriteBytesPerRoom,
      nextWriteBytes: 1
    }),
    { accepted: false, reason: "write-bytes" }
  );
});
