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
      userConnections: collaborationResourceLimits.connectionsPerUser - 1,
      ipConnections: collaborationResourceLimits.connectionsPerIp - 1
    }),
    { accepted: true }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: collaborationResourceLimits.connectionsPerServer,
      pageConnections: 0,
      userConnections: 0,
      ipConnections: 0
    }),
    { accepted: false, reason: "server-connections" }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: 0,
      pageConnections: collaborationResourceLimits.connectionsPerPage,
      userConnections: 0,
      ipConnections: 0
    }),
    { accepted: false, reason: "page-connections" }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: 0,
      pageConnections: 0,
      userConnections: collaborationResourceLimits.connectionsPerUser,
      ipConnections: 0
    }),
    { accepted: false, reason: "user-connections" }
  );
  assert.deepEqual(
    assessCollaborationConnectionAdmission({
      activeConnections: 0,
      pageConnections: 0,
      userConnections: 0,
      ipConnections: collaborationResourceLimits.connectionsPerIp
    }),
    { accepted: false, reason: "ip-connections" }
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

test("collaboration revalidation amortizes durable checks and protects presence recipients", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(new URL("../src/lib/collaboration-server.ts", import.meta.url), "utf8"))
    .replace(/\r\n/g, "\n");

  assert.match(source, /const accessRevalidationCacheMs = 2_000;/);
  assert.match(source, /if \(!force && now - client\.accessValidatedAt < accessRevalidationCacheMs\) return true;/);
  assert.match(source, /if \(client\.accessValidationPromise\) return client\.accessValidationPromise;/);
  assert.match(source, /isPermanentlyBlockedTotpIp\(client\.ipAddress, client\.user\.id\)/);
  assert.match(source, /enforceCountryLoginPolicy\(client\.user\.id, currentUser\.country_login_mode, client\.ipAddress\)/);
  assert.ok(source.includes("enforceVpnAccessPolicy("));
  assert.ok(source.includes("client.ipAddress"));
  assert.match(source, /targets\.map\(async \(target\) => \{[\s\S]*revalidateClientPageAccess\(room, target\)/);
});

test("large-state validations cannot occupy every global worker simultaneously", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = (await readFile(
    new URL("../src/lib/collaboration-update-worker-pool.ts", import.meta.url),
    "utf8"
  )).replace(/\r\n/g, "\n");

  assert.match(source, /export const expensiveValidationStateThresholdBytes = 4 \* 1024 \* 1024;/);
  assert.match(source, /expensive: request\.currentState\.byteLength >= expensiveValidationStateThresholdBytes/);
  assert.match(source, /!task\.expensive[\s\S]*\|\| this\.workerCount === 1[\s\S]*\|\| !activeExpensiveValidation/);
  assert.match(source, /else if \(task\.expensive\) activeExpensiveValidation = true;/);
});
