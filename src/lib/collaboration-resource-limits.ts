export const collaborationResourceLimits = {
  connectionsPerServer: 512,
  connectionsPerPage: 64,
  connectionsPerUser: 8,
  connectionsPerIp: 32,
  unauthenticatedUpgradesPerIpPerMinute: 30,
  trackedUnauthenticatedUpgradeIps: 4_096,
  pendingUpgradesPerServer: 64,
  pendingUpgradesPerUser: 4,
  pendingWritesPerRoom: 64,
  pendingWriteBytesPerRoom: 32 * 1024 * 1024
} as const;

export type CollaborationConnectionAdmission =
  | { accepted: true }
  | {
      accepted: false;
      reason: "server-connections" | "page-connections" | "user-connections" | "ip-connections";
    };

export function assessCollaborationConnectionAdmission({
  activeConnections,
  pageConnections,
  userConnections,
  ipConnections = 0
}: {
  activeConnections: number;
  pageConnections: number;
  userConnections: number;
  ipConnections?: number;
}): CollaborationConnectionAdmission {
  if (activeConnections >= collaborationResourceLimits.connectionsPerServer) {
    return { accepted: false, reason: "server-connections" };
  }
  if (pageConnections >= collaborationResourceLimits.connectionsPerPage) {
    return { accepted: false, reason: "page-connections" };
  }
  if (userConnections >= collaborationResourceLimits.connectionsPerUser) {
    return { accepted: false, reason: "user-connections" };
  }
  if (ipConnections >= collaborationResourceLimits.connectionsPerIp) {
    return { accepted: false, reason: "ip-connections" };
  }
  return { accepted: true };
}

export type CollaborationUpgradeAdmission =
  | { accepted: true }
  | { accepted: false; reason: "server-upgrades" | "user-upgrades" };

export function assessCollaborationUpgradeAdmission({
  pendingUpgrades,
  pendingUserUpgrades
}: {
  pendingUpgrades: number;
  pendingUserUpgrades: number;
}): CollaborationUpgradeAdmission {
  if (pendingUpgrades >= collaborationResourceLimits.pendingUpgradesPerServer) {
    return { accepted: false, reason: "server-upgrades" };
  }
  if (pendingUserUpgrades >= collaborationResourceLimits.pendingUpgradesPerUser) {
    return { accepted: false, reason: "user-upgrades" };
  }
  return { accepted: true };
}

export type CollaborationWriteAdmission =
  | { accepted: true }
  | { accepted: false; reason: "write-count" | "write-bytes" };

export function assessCollaborationWriteAdmission({
  pendingWrites,
  pendingWriteBytes,
  nextWriteBytes
}: {
  pendingWrites: number;
  pendingWriteBytes: number;
  nextWriteBytes: number;
}): CollaborationWriteAdmission {
  if (pendingWrites >= collaborationResourceLimits.pendingWritesPerRoom) {
    return { accepted: false, reason: "write-count" };
  }
  if (
    nextWriteBytes < 0
    || nextWriteBytes > collaborationResourceLimits.pendingWriteBytesPerRoom - pendingWriteBytes
  ) {
    return { accepted: false, reason: "write-bytes" };
  }
  return { accepted: true };
}
