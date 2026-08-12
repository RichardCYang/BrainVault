import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { Socket } from "node:net";
import { createId } from "./id.js";
import { corsOrigins, env } from "../config/env.js";
import { createExactHttpOriginSet, parseExactHttpOrigin } from "./request-origin.js";
import { db, transaction } from "./db.js";
import { getPageAccess } from "./page-access.js";
import { verifyCollaborationToken } from "./collaboration-token.js";
import {
  assertCollaborationDocumentEpoch,
  getCollaborationState
} from "./collaboration-lineage.js";
import { ApiError } from "./http.js";
import { enforceCountryLoginPolicy } from "./country-login-policy.js";
import { enforceVpnAccessPolicy, type ClientWebRtcSignal } from "./vpn-access-policy.js";
import {
  acceptWebSocketUpgrade,
  parseWebSocketProtocols,
  rejectWebSocketUpgrade,
  type WebSocketConnection,
  type WebSocketMessage
} from "./websocket.js";
import type { BlockRow, UserRow } from "../types/domain.js";
import * as Y from "yjs";
import {
  applyValidatedYjsUpdate,
  createValidatedYjsDocument,
  InvalidYjsUpdateError
} from "./yjs-validation.js";
import {
  assessCollaborationWriteCheckpoint,
  maxCollaborationDocumentBytes,
  maxCollaborationUpdateBytes,
  type CollaborationWriteRejectionReason
} from "./collaboration-protocol.js";
import {
  readCollaborationMaterialization
} from "./collaboration-materialization.js";
import { CollaborationDocumentError } from "./collaboration-document.js";
import { getClientIpAddressFromTrustedProxyRequest, isHttpsRequestFromTrustedProxy } from "./reverse-proxy.js";
import { isPermanentlyBlockedTotpIp } from "./totp-ip-block.js";
import {
  assessInitialCollaborationBootstrap,
  invalidInitialCollaborationBootstrapSummary,
  type CollaborationBootstrapAssessment,
  type CollaborationBootstrapMismatchSummary
} from "./collaboration-bootstrap.js";
import {
  assessCollaborationConnectionAdmission,
  assessCollaborationUpgradeAdmission,
  assessCollaborationWriteAdmission
} from "./collaboration-resource-limits.js";
import { getCollaborationAvatarData } from "./collaboration-presence.js";
import {
  assessCollaborationHistoryReplay,
  assessCollaborationUpdatePersistence,
  maxCollaborationRetainedHistoryBytes,
  shouldCompactCollaborationHistory
} from "./collaboration-update-policy.js";

type CollaborationNetworkServer = HttpServer | HttpsServer;

export const collaborationWebSocketProtocol = "brainvault-yjs-v2";
export const collaborationTicketProtocolPrefix = "brainvault-ticket.";

const maxTextMessageBytes = 16 * 1024;
const maxFramesPerMinute = 600;
const maxBytesPerMinute = 64 * 1024 * 1024;
const heartbeatIntervalMs = 25_000;
const heartbeatTimeoutMs = 75_000;
const accessRecheckIntervalMs = 30_000;

type YjsUpdateRow = {
  id: number;
  update_data: Buffer;
  is_snapshot: 0 | 1;
};

type CollaborationHistoryStatsRow = {
  history_entries: number | string | bigint | null;
  history_bytes: number | string | bigint | null;
};

type CollaborationProfile = Pick<UserRow, "id" | "username" | "name" | "avatar_data">;

type AwarenessState = {
  blockId: string | null;
  field: string | null;
  control: string | null;
  selection: { anchor: number; head: number } | null;
};

type ClientContext = {
  id: string;
  socket: WebSocketConnection;
  user: CollaborationProfile;
  authVersion: number;
  ipAddress: string;
  webRtcSignal: ClientWebRtcSignal;
  documentEpoch: string;
  synced: boolean;
  awareness: AwarenessState;
  rateWindowStartedAt: number;
  frameCount: number;
  byteCount: number;
};

type Room = {
  pageId: string;
  documentEpoch: string;
  clients: Map<string, ClientContext>;
  history: YjsUpdateRow[];
  historyBytes: number;
  stateUpdate: Buffer;
  maxUpdateId: number;
  loaded: boolean;
  loadFailed: boolean;
  invalidated: boolean;
  loadPromise: Promise<void>;
  bootstrapLeaderId: string | null;
  waitingForBootstrap: Set<string>;
  writeQueue: Promise<void>;
  pendingWrites: number;
  pendingWriteBytes: number;
  bootstrapWritePending: boolean;
  document: Y.Doc;
};

const activeHubs = new Set<PageCollaborationHub>();

const explicitOrigins = createExactHttpOriginSet(corsOrigins);

// Never derive the expected browser host from X-Forwarded-Host or other client-controlled forwarding headers.
function isAllowedOrigin(request: IncomingMessage) {
  const originHeader = request.headers.origin;
  if (typeof originHeader !== "string" || !originHeader) return false;
  const parsedOrigin = parseExactHttpOrigin(originHeader);
  return parsedOrigin !== null && explicitOrigins.has(parsedOrigin);
}

function parsePageId(request: IncomingMessage) {
  try {
    const url = new URL(request.url ?? "/", "http://brainvault.invalid");
    const match = /^\/api\/collaboration\/([^/]+)$/.exec(url.pathname);
    if (!match) return null;
    const pageId = decodeURIComponent(match[1]);
    return pageId && pageId.length <= 64 ? pageId : null;
  } catch {
    return null;
  }
}

function updateEnvelope(updateId: number, update: Buffer) {
  const envelope = Buffer.allocUnsafe(9 + update.length);
  envelope[0] = 1;
  envelope.writeBigUInt64BE(BigInt(updateId), 1);
  update.copy(envelope, 9);
  return envelope;
}

function toSafeUpdateId(value: unknown) {
  const id = Number(value ?? 0);
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new ApiError(500, "INVALID_COLLABORATION_STATE", "Collaboration update id exceeded the supported range");
  }
  return id;
}

function toSafeHistoryMetric(value: unknown, label: string) {
  const metric = Number(value ?? 0);
  if (!Number.isSafeInteger(metric) || metric < 0) {
    throw new InvalidYjsUpdateError(`Stored collaboration ${label} is invalid`);
  }
  return metric;
}

function normalizeAwareness(value: unknown): AwarenessState {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const selectionSource = source.selection && typeof source.selection === "object" && !Array.isArray(source.selection)
    ? source.selection as Record<string, unknown>
    : null;
  const anchor = selectionSource ? Number(selectionSource.anchor) : NaN;
  const head = selectionSource ? Number(selectionSource.head) : NaN;
  return {
    blockId: typeof source.blockId === "string" && source.blockId.length <= 64 ? source.blockId : null,
    field: typeof source.field === "string" && source.field.length <= 32 ? source.field : null,
    control: typeof source.control === "string" && source.control.length <= 32 ? source.control : null,
    selection: Number.isSafeInteger(anchor) && anchor >= 0 && Number.isSafeInteger(head) && head >= 0
      ? { anchor, head }
      : null
  };
}

function publicPresence(client: ClientContext, includeIdentity = true) {
  const presence = {
    connectionId: client.id,
    state: client.awareness,
    synced: client.synced
  };
  if (!includeIdentity) return presence;
  return {
    ...presence,
    user: {
      id: client.user.id,
      username: client.user.username,
      name: client.user.name,
      avatarData: getCollaborationAvatarData(client.user.avatar_data)
    }
  };
}

export class PageCollaborationHub {
  private readonly server: CollaborationNetworkServer;
  private readonly rooms = new Map<string, Room>();
  private readonly heartbeatTimer: NodeJS.Timeout;
  private readonly accessTimer: NodeJS.Timeout;
  private closed = false;
  private accessRecheckRunning = false;
  private activeConnectionCount = 0;
  private readonly pageConnectionCounts = new Map<string, number>();
  private readonly userConnectionCounts = new Map<string, number>();
  private pendingUpgradeCount = 0;
  private readonly pendingUpgradeUserCounts = new Map<string, number>();
  private readonly upgradedSockets = new WeakSet<Socket>();
  private readonly upgradeHandler: (request: IncomingMessage, socket: Socket, head: Buffer) => void;

  constructor(server: CollaborationNetworkServer) {
    this.server = server;
    this.upgradeHandler = (request, socket, head) => {
      void this.handleUpgrade(request, socket, head).catch((error) => {
        console.error("Collaboration WebSocket upgrade failed", error);
        if (this.upgradedSockets.has(socket)) socket.destroy();
        else rejectWebSocketUpgrade(socket, error instanceof ApiError ? error.statusCode : 500, "Collaboration connection failed");
      });
    };
    server.on("upgrade", this.upgradeHandler);
    this.heartbeatTimer = setInterval(() => this.runHeartbeat(), heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    this.accessTimer = setInterval(() => void this.recheckAccess(), accessRecheckIntervalMs);
    this.accessTimer.unref();
    activeHubs.add(this);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    activeHubs.delete(this);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.accessTimer);
    this.server.off("upgrade", this.upgradeHandler);

    const rooms = [...this.rooms.values()];
    for (const room of rooms) {
      for (const client of room.clients.values()) client.socket.close(1001, "Server is shutting down");
    }
    await Promise.allSettled(rooms.map((room) => room.writeQueue));
    for (const room of rooms) {
      room.invalidated = true;
      room.document.destroy();
    }
    this.rooms.clear();
  }

  disconnectUser(pageId: string, userId: string, reason = "Page access was removed") {
    const room = this.rooms.get(pageId);
    if (!room) return;
    for (const client of room.clients.values()) {
      if (client.user.id === userId) client.socket.close(4003, reason);
    }
  }

  disconnectUserEverywhere(userId: string, reason = "Authentication session was revoked") {
    for (const room of this.rooms.values()) {
      for (const client of room.clients.values()) {
        if (client.user.id === userId) client.socket.close(4003, reason);
      }
    }
  }

  disconnectIpEverywhere(ipAddress: string, reason = "Access from this IP is blocked") {
    for (const room of this.rooms.values()) {
      for (const client of room.clients.values()) {
        if (client.ipAddress === ipAddress) client.socket.close(4003, reason);
      }
    }
  }

  disconnectPage(pageId: string, reason = "Collaboration is no longer available") {
    const room = this.rooms.get(pageId);
    if (!room) return;
    room.invalidated = true;
    this.rooms.delete(pageId);
    room.bootstrapLeaderId = null;
    room.waitingForBootstrap.clear();
    for (const client of room.clients.values()) client.socket.close(4010, reason);
    void room.writeQueue.finally(() => room.document.destroy());
  }

  private invalidateRoom(room: Room, code: number, reason: string) {
    if (room.invalidated || this.rooms.get(room.pageId) !== room) return;
    room.invalidated = true;
    this.rooms.delete(room.pageId);
    room.bootstrapLeaderId = null;
    room.waitingForBootstrap.clear();
    for (const client of room.clients.values()) {
      if (client.socket.isOpen) client.socket.close(code, reason);
    }
    // Wait for every already-queued writer to stop before destroying the shared
    // document. Reconnecting clients will build a fresh room from durable rows.
    void room.writeQueue.finally(() => room.document.destroy());
  }

  private invalidateRoomForReload(room: Room, reason: string) {
    this.invalidateRoom(room, 1011, reason);
  }

  private invalidateRoomForLineageChange(room: Room) {
    this.invalidateRoom(room, 4011, "The collaboration document was replaced");
  }

  notifyCanonicalAttachment(pageId: string, block: unknown) {
    const room = this.rooms.get(pageId);
    if (!room || room.invalidated || this.rooms.get(pageId) !== room) return;
    for (const client of room.clients.values()) {
      if (client.socket.isOpen) client.socket.sendJson({ type: "canonical-attachment", block });
    }
  }

  private reserveUpgrade(userId: string, pageId: string) {
    const connectionAdmission = assessCollaborationConnectionAdmission({
      activeConnections: this.activeConnectionCount,
      pageConnections: this.pageConnectionCounts.get(pageId) ?? 0,
      userConnections: this.userConnectionCounts.get(userId) ?? 0
    });
    const upgradeAdmission = assessCollaborationUpgradeAdmission({
      pendingUpgrades: this.pendingUpgradeCount,
      pendingUserUpgrades: this.pendingUpgradeUserCounts.get(userId) ?? 0
    });
    if (!connectionAdmission.accepted || !upgradeAdmission.accepted) return false;

    this.pendingUpgradeCount += 1;
    this.pendingUpgradeUserCounts.set(
      userId,
      (this.pendingUpgradeUserCounts.get(userId) ?? 0) + 1
    );
    return true;
  }

  private releaseUpgrade(userId: string) {
    this.pendingUpgradeCount = Math.max(0, this.pendingUpgradeCount - 1);
    const next = Math.max(0, (this.pendingUpgradeUserCounts.get(userId) ?? 0) - 1);
    if (next) this.pendingUpgradeUserCounts.set(userId, next);
    else this.pendingUpgradeUserCounts.delete(userId);
  }

  private trackClient(pageId: string, userId: string) {
    this.activeConnectionCount += 1;
    this.pageConnectionCounts.set(pageId, (this.pageConnectionCounts.get(pageId) ?? 0) + 1);
    this.userConnectionCounts.set(userId, (this.userConnectionCounts.get(userId) ?? 0) + 1);
  }

  private untrackClient(pageId: string, userId: string) {
    this.activeConnectionCount = Math.max(0, this.activeConnectionCount - 1);
    const nextPageCount = Math.max(0, (this.pageConnectionCounts.get(pageId) ?? 0) - 1);
    if (nextPageCount) this.pageConnectionCounts.set(pageId, nextPageCount);
    else this.pageConnectionCounts.delete(pageId);
    const nextUserCount = Math.max(0, (this.userConnectionCounts.get(userId) ?? 0) - 1);
    if (nextUserCount) this.userConnectionCounts.set(userId, nextUserCount);
    else this.userConnectionCounts.delete(userId);
  }

  private rejectConnectionLimit(socket: Socket) {
    rejectWebSocketUpgrade(socket, 429, "Collaboration connection limit exceeded");
  }

  private async handleUpgrade(request: IncomingMessage, socket: Socket, head: Buffer) {
    if (this.closed) {
      rejectWebSocketUpgrade(socket, 503, "Collaboration server is shutting down");
      return;
    }

    if (
      env.HTTPS_MODE === "proxy" &&
      !isHttpsRequestFromTrustedProxy(request, env.TRUST_PROXY_ADDRESSES)
    ) {
      rejectWebSocketUpgrade(socket, 426, "HTTPS reverse proxy is required");
      return;
    }

    const pageId = parsePageId(request);
    if (!pageId) {
      rejectWebSocketUpgrade(socket, 404, "WebSocket endpoint not found");
      return;
    }
    if (!isAllowedOrigin(request)) {
      rejectWebSocketUpgrade(socket, 403, "WebSocket origin is not allowed");
      return;
    }

    const protocols = parseWebSocketProtocols(request.headers["sec-websocket-protocol"]);
    const ticketProtocol = protocols.find((value) => value.startsWith(collaborationTicketProtocolPrefix));
    if (!protocols.includes(collaborationWebSocketProtocol) || !ticketProtocol) {
      rejectWebSocketUpgrade(socket, 401, "A collaboration ticket is required");
      return;
    }

    const ticket = ticketProtocol.slice(collaborationTicketProtocolPrefix.length);
    const payload = verifyCollaborationToken(ticket);
    if (payload.pageId !== pageId) {
      rejectWebSocketUpgrade(socket, 401, "The collaboration ticket does not match this page");
      return;
    }
    if (!this.reserveUpgrade(payload.sub, pageId)) {
      this.rejectConnectionLimit(socket);
      return;
    }

    let upgradeReserved = true;
    try {
      const access = await getPageAccess(pageId, payload.sub);
      if (access.page.is_collection || access.page.is_archived || access.shareCount < 1) {
        rejectWebSocketUpgrade(socket, 403, "Collaboration is not enabled for this page");
        return;
      }
      const collaborationState = await getCollaborationState(pageId);
      assertCollaborationDocumentEpoch(collaborationState, payload.documentEpoch);
      const sourceIp = getClientIpAddressFromTrustedProxyRequest(
        request,
        env.HTTPS_MODE === "proxy" ? env.TRUST_PROXY_ADDRESSES : []
      );
      if (await isPermanentlyBlockedTotpIp(sourceIp)) {
        rejectWebSocketUpgrade(socket, 403, "Access from this IP is blocked");
        return;
      }
      const webRtcSignal: ClientWebRtcSignal = {
        state: payload.webRtcState ?? "ABSENT",
        observedIps: payload.webRtcObservedIps ?? []
      };
      const user = await db.queryOne<CollaborationProfile & {
        auth_version?: number;
        country_login_mode?: UserRow["country_login_mode"];
        vpn_block_enabled?: UserRow["vpn_block_enabled"];
      }>(
        "SELECT id, username, name, avatar_data, auth_version, country_login_mode, vpn_block_enabled FROM users WHERE id = ?",
        [payload.sub]
      );
      if (!user) {
        rejectWebSocketUpgrade(socket, 401, "User no longer exists");
        return;
      }
      const currentAuthVersion = Number(user.auth_version ?? 1);
      if (!Number.isSafeInteger(currentAuthVersion) || currentAuthVersion < 1 || currentAuthVersion !== payload.authVersion) {
        rejectWebSocketUpgrade(socket, 401, "Authentication session was revoked");
        return;
      }
      await enforceCountryLoginPolicy(user.id, user.country_login_mode, sourceIp);
      await enforceVpnAccessPolicy(user.id, user.vpn_block_enabled, sourceIp, null, webRtcSignal);

      if (this.closed) {
        rejectWebSocketUpgrade(socket, 503, "Collaboration server is shutting down");
        return;
      }

      const connectionAdmission = assessCollaborationConnectionAdmission({
        activeConnections: this.activeConnectionCount,
        pageConnections: this.pageConnectionCounts.get(pageId) ?? 0,
        userConnections: this.userConnectionCounts.get(payload.sub) ?? 0
      });
      if (!connectionAdmission.accepted) {
        this.rejectConnectionLimit(socket);
        return;
      }

      const connection = acceptWebSocketUpgrade(request, socket, {
        selectedProtocol: collaborationWebSocketProtocol,
        maxMessageBytes: maxCollaborationUpdateBytes + 64 * 1024
      });
      if (!connection) return;
      this.upgradedSockets.add(socket);

      const room = this.getOrCreateRoom(pageId, payload.documentEpoch);
      const client: ClientContext = {
        id: createId("con"),
        socket: connection,
        user,
        authVersion: payload.authVersion,
        ipAddress: sourceIp,
        webRtcSignal,
        documentEpoch: payload.documentEpoch,
        synced: false,
        awareness: { blockId: null, field: null, control: null, selection: null },
        rateWindowStartedAt: Date.now(),
        frameCount: 0,
        byteCount: 0
      };
      room.clients.set(client.id, client);
      this.trackClient(room.pageId, client.user.id);
      connection.onMessage((message) => this.handleMessage(room, client, message));
      connection.onClose(() => this.handleClientClose(room, client));
      connection.start(head);
      this.releaseUpgrade(payload.sub);
      upgradeReserved = false;

      await room.loadPromise;
      if (
        room.loadFailed
        || room.invalidated
        || this.rooms.get(pageId) !== room
        || !connection.isOpen
        || !room.clients.has(client.id)
      ) return;

      try {
        if (await isPermanentlyBlockedTotpIp(sourceIp)) {
          connection.close(4003, "Access from this IP is blocked");
          return;
        }
        const currentUser = await db.queryOne<{
          auth_version?: number;
          country_login_mode?: UserRow["country_login_mode"];
          vpn_block_enabled?: UserRow["vpn_block_enabled"];
        }>(
          "SELECT auth_version, country_login_mode, vpn_block_enabled FROM users WHERE id = ?",
          [payload.sub]
        );
        if (!currentUser || Number(currentUser.auth_version ?? 1) !== payload.authVersion) {
          connection.close(4003, "Authentication session was revoked");
          return;
        }
        await enforceCountryLoginPolicy(payload.sub, currentUser.country_login_mode, sourceIp);
        await enforceVpnAccessPolicy(payload.sub, currentUser.vpn_block_enabled, sourceIp, null, webRtcSignal);
        const currentAccess = await getPageAccess(pageId, payload.sub);
        if (currentAccess.page.is_collection || currentAccess.page.is_archived || currentAccess.shareCount < 1) {
          connection.close(4010, "Collaboration is no longer available");
          return;
        }
        const currentState = await getCollaborationState(pageId);
        assertCollaborationDocumentEpoch(currentState, payload.documentEpoch);
      } catch (error) {
        if (error instanceof ApiError && error.code === "COLLABORATION_LINEAGE_CHANGED") {
          connection.close(4011, "The collaboration document was replaced");
          return;
        }
        if (error instanceof ApiError && error.code === "COUNTRY_LOGIN_BLOCKED") {
          connection.close(4003, "Access from this IP country is blocked");
          return;
        }
        if (error instanceof ApiError && error.code === "VPN_ACCESS_BLOCKED") {
          connection.close(4003, "Access from this VPN, proxy, or Tor network is blocked");
          return;
        }
        if (error instanceof ApiError && error.statusCode === 404) {
          connection.close(4003, "Page access was removed");
          return;
        }
        throw error;
      }
      if (
        room.invalidated
        || this.rooms.get(pageId) !== room
        || !connection.isOpen
        || !room.clients.has(client.id)
      ) return;

      if (room.maxUpdateId > 0) {
        // A reconnect needs the canonical state and durable cursor, not every
        // historical frame. This keeps synchronization work bounded even when
        // an obsolete client delayed cooperative compaction.
        connection.sendBinary(updateEnvelope(room.maxUpdateId, room.stateUpdate));
      }
      connection.sendJson({
        type: "presence",
        clients: [...room.clients.values()]
          .filter((item) => item.id !== client.id)
          .map((item) => publicPresence(item, true))
      });

      if (room.history.length || room.maxUpdateId > 0) {
        client.synced = true;
        connection.sendJson({
          type: "sync-complete",
          connectionId: client.id,
          bootstrap: false,
          lastUpdateId: room.maxUpdateId
        });
      } else if (!room.bootstrapLeaderId) {
        room.bootstrapLeaderId = client.id;
        client.synced = true;
        connection.sendJson({
          type: "sync-complete",
          connectionId: client.id,
          bootstrap: true,
          lastUpdateId: 0
        });
      } else {
        room.waitingForBootstrap.add(client.id);
        connection.sendJson({ type: "bootstrap-wait", connectionId: client.id });
      }
      this.broadcastPresenceUpdate(room, client, { includeIdentity: true });
    } finally {
      if (upgradeReserved) this.releaseUpgrade(payload.sub);
    }
  }

  private getOrCreateRoom(pageId: string, documentEpoch: string) {
    const existing = this.rooms.get(pageId);
    if (existing && !existing.invalidated && existing.documentEpoch === documentEpoch) return existing;
    if (existing && !existing.invalidated) {
      this.invalidateRoomForLineageChange(existing);
    } else if (existing) {
      this.rooms.delete(pageId);
      void existing.writeQueue.finally(() => existing.document.destroy());
    }

    const room = {} as Room;
    Object.assign(room, {
      pageId,
      documentEpoch,
      clients: new Map<string, ClientContext>(),
      history: [],
      historyBytes: 0,
      stateUpdate: Buffer.alloc(0),
      maxUpdateId: 0,
      loaded: false,
      loadFailed: false,
      invalidated: false,
      bootstrapLeaderId: null,
      waitingForBootstrap: new Set<string>(),
      writeQueue: Promise.resolve(),
      pendingWrites: 0,
      pendingWriteBytes: 0,
      bootstrapWritePending: false,
      document: createValidatedYjsDocument([], maxCollaborationDocumentBytes)
    });
    let pendingLoadedDocument: Y.Doc | null = null;
    room.loadPromise = transaction(async (dbClient) => {
      // Every durable collaboration writer locks the page row first. Taking the
      // same lock keeps the aggregate preflight, BLOB read, and optional legacy
      // compaction consistent without selecting an unbounded history first.
      const page = await dbClient.queryOne<{ id: string }>(
        "SELECT id FROM pages WHERE id = ? FOR UPDATE",
        [pageId]
      );
      if (!page) throw new ApiError(404, "PAGE_NOT_FOUND", "Page not found");

      const statsRow = await dbClient.queryOne<CollaborationHistoryStatsRow>(
        `SELECT COUNT(*) AS history_entries,
                COALESCE(SUM(OCTET_LENGTH(update_data)), 0) AS history_bytes
         FROM page_yjs_updates
         WHERE page_id = ?`,
        [pageId]
      );
      const historyEntries = toSafeHistoryMetric(statsRow?.history_entries, "entry count");
      const historyBytes = toSafeHistoryMetric(statsRow?.history_bytes, "byte count");
      const replayAssessment = assessCollaborationHistoryReplay({ historyEntries, historyBytes });
      if (!replayAssessment.accepted) {
        throw new InvalidYjsUpdateError(
          `Stored collaboration history exceeds the safe replay ${replayAssessment.reason}`
        );
      }

      const rows = await dbClient.query<YjsUpdateRow>(
        `SELECT id, update_data, is_snapshot
         FROM page_yjs_updates
         WHERE page_id = ?
         ORDER BY id ASC`,
        [pageId]
      );
      const history = rows.map((row) => ({
        id: toSafeUpdateId(row.id),
        update_data: Buffer.from(row.update_data),
        is_snapshot: row.is_snapshot === 1 ? 1 as const : 0 as const
      }));
      const actualHistoryBytes = history.reduce((total, row) => total + row.update_data.length, 0);
      if (history.length !== historyEntries || actualHistoryBytes !== historyBytes) {
        throw new InvalidYjsUpdateError("Stored collaboration history changed during bounded replay");
      }

      const loadedDocument = createValidatedYjsDocument(
        history.map((row) => row.update_data),
        maxCollaborationDocumentBytes
      );
      pendingLoadedDocument = loadedDocument;
      const stateUpdate = Buffer.from(Y.encodeStateAsUpdate(loadedDocument));

      if (!replayAssessment.compact || !history.length) {
        return {
          document: loadedDocument,
          history,
          historyBytes: actualHistoryBytes,
          stateUpdate,
          maxUpdateId: history.length ? history[history.length - 1].id : 0
        };
      }

      // Histories from older builds that only moderately exceed the retained
      // caps are repaired once under the page lock. The replacement is encoded
      // from the validated canonical document, never from a client payload.
      if (stateUpdate.length > maxCollaborationRetainedHistoryBytes) {
        throw new InvalidYjsUpdateError("The compacted collaboration state exceeds the retained history limit");
      }
      const updateId = history.at(-1)?.id;
      if (updateId === undefined) {
        throw new InvalidYjsUpdateError("Stored collaboration history has no compaction checkpoint");
      }
      // Replace the latest row in place so state-equivalent legacy repair does
      // not advance the durable cursor or invalidate rooms on another server.
      const replacement = await dbClient.execute<{ affectedRows: number }>(
        `UPDATE page_yjs_updates
         SET update_data = ?, is_snapshot = 1
         WHERE page_id = ? AND id = ?`,
        [stateUpdate, pageId, updateId]
      );
      if (replacement.affectedRows !== 1) {
        throw new InvalidYjsUpdateError("Stored collaboration history could not be compacted safely");
      }
      await dbClient.execute(
        "DELETE FROM page_yjs_updates WHERE page_id = ? AND id < ?",
        [pageId, updateId]
      );
      return {
        document: loadedDocument,
        history: [{ id: updateId, update_data: stateUpdate, is_snapshot: 1 as const }],
        historyBytes: stateUpdate.length,
        stateUpdate,
        maxUpdateId: updateId
      };
    }).then((loaded) => {
      if (room.invalidated || this.rooms.get(pageId) !== room) {
        loaded.document.destroy();
        pendingLoadedDocument = null;
        return;
      }
      room.history = loaded.history;
      room.historyBytes = loaded.historyBytes;
      room.stateUpdate = loaded.stateUpdate;
      room.document.destroy();
      room.document = loaded.document;
      pendingLoadedDocument = null;
      room.maxUpdateId = loaded.maxUpdateId;
      room.loaded = true;
    }).catch((error) => {
      pendingLoadedDocument?.destroy();
      pendingLoadedDocument = null;
      room.loadFailed = true;
      room.invalidated = true;
      if (this.rooms.get(pageId) === room) this.rooms.delete(pageId);
      room.document.destroy();
      for (const client of room.clients.values()) client.socket.close(1011, "Unable to load collaboration history");
      console.error("Failed to load collaboration history", { pageId, error });
    });
    this.rooms.set(pageId, room);
    return room;
  }

  private checkRate(client: ClientContext, bytes: number) {
    const now = Date.now();
    if (now - client.rateWindowStartedAt >= 60_000) {
      client.rateWindowStartedAt = now;
      client.frameCount = 0;
      client.byteCount = 0;
    }
    client.frameCount += 1;
    client.byteCount += bytes;
    if (client.frameCount > maxFramesPerMinute || client.byteCount > maxBytesPerMinute) {
      client.socket.close(1008, "Collaboration rate limit exceeded");
      return false;
    }
    return true;
  }

  private async handleMessage(room: Room, client: ClientContext, message: WebSocketMessage) {
    if (this.closed || room.invalidated || this.rooms.get(room.pageId) !== room || !room.clients.has(client.id)) return;
    const bytes = message.type === "binary" ? message.data.length : Buffer.byteLength(message.text, "utf8");
    if (!this.checkRate(client, bytes)) return;

    if (message.type === "text") {
      if (bytes > maxTextMessageBytes) {
        client.socket.close(1009, "Collaboration control message is too large");
        return;
      }
      this.handleTextMessage(room, client, message.text);
      return;
    }

    if (!client.synced) {
      client.socket.sendJson({ type: "error", code: "COLLABORATION_NOT_SYNCED", message: "Wait for document synchronization" });
      return;
    }
    if (message.data.length < 2) {
      client.socket.close(1003, "Invalid collaboration update");
      return;
    }

    const kind = message.data[0];
    if (kind === 1) {
      const update = message.data.subarray(1);
      if (!update.length || update.length > maxCollaborationUpdateBytes) {
        client.socket.close(1009, "Yjs update is too large");
        return;
      }
      const write = this.enqueueRoomWrite(
        room,
        client,
        update.length,
        async () => this.persistUpdate(room, client, Buffer.from(update), false, null)
      );
      if (!write) return;
      if (room.bootstrapLeaderId === client.id && room.maxUpdateId === 0) {
        room.bootstrapWritePending = true;
      }
      await write;
      return;
    }
    if (kind === 2) {
      if (message.data.length < 10) {
        client.socket.close(1003, "Invalid collaboration snapshot");
        return;
      }
      const baseUpdateId = toSafeUpdateId(message.data.readBigUInt64BE(1));
      const update = message.data.subarray(9);
      if (!update.length || update.length > maxCollaborationUpdateBytes) {
        client.socket.close(1009, "Yjs snapshot is too large");
        return;
      }
      const write = this.enqueueRoomWrite(
        room,
        client,
        update.length,
        async () => this.persistUpdate(room, client, Buffer.from(update), true, baseUpdateId)
      );
      if (!write) return;
      if (room.bootstrapLeaderId === client.id && room.maxUpdateId === 0) {
        room.bootstrapWritePending = true;
      }
      await write;
      return;
    }
    client.socket.close(1003, "Unknown collaboration update type");
  }

  private handleTextMessage(room: Room, client: ClientContext, text: string) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      client.socket.close(1007, "Invalid collaboration control message");
      return;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const body = value as Record<string, unknown>;
    if (body.type !== "awareness" || !client.synced) return;
    client.awareness = normalizeAwareness(body.state);
    this.broadcastPresenceUpdate(room, client);
  }

  private enqueueRoomWrite(
    room: Room,
    client: ClientContext,
    writeBytes: number,
    action: () => Promise<void>
  ) {
    const admission = assessCollaborationWriteAdmission({
      pendingWrites: room.pendingWrites,
      pendingWriteBytes: room.pendingWriteBytes,
      nextWriteBytes: writeBytes
    });
    if (!admission.accepted) {
      client.socket.close(1008, "Collaboration write backlog exceeded");
      return null;
    }

    room.pendingWrites += 1;
    room.pendingWriteBytes += writeBytes;
    const queuedWrite = room.writeQueue.then(async () => {
      try {
        await action();
      } catch (error) {
        if (error instanceof InvalidYjsUpdateError) {
          console.warn("Rejected an invalid Yjs update", { pageId: room.pageId, userId: client.user.id, error });
          if (client.socket.isOpen) client.socket.close(1003, error.message);
        } else if (
          error
          && typeof error === "object"
          && "commitOutcomeUnknown" in error
          && error.commitOutcomeUnknown === true
        ) {
          console.error("Yjs update commit outcome is unknown; reloading the collaboration room", {
            pageId: room.pageId,
            error
          });
          this.invalidateRoomForReload(
            room,
            "Collaboration state is reloading after an uncertain database commit"
          );
        } else {
          console.error("Failed to persist a Yjs update", { pageId: room.pageId, error });
          if (client.socket.isOpen) client.socket.close(1011, "Unable to save collaboration update");
        }
      } finally {
        room.pendingWrites = Math.max(0, room.pendingWrites - 1);
        room.pendingWriteBytes = Math.max(0, room.pendingWriteBytes - writeBytes);
        if (
          room.bootstrapWritePending
          && room.bootstrapLeaderId === client.id
          && room.maxUpdateId === 0
          && room.pendingWrites === 0
        ) {
          room.bootstrapWritePending = false;
          room.bootstrapLeaderId = null;
          this.promoteBootstrapLeader(room);
        }
        this.removeRoomWhenIdle(room);
      }
    });
    room.writeQueue = queuedWrite;
    return queuedWrite;
  }

  private async persistUpdate(
    room: Room,
    client: ClientContext,
    update: Buffer,
    snapshot: boolean,
    baseUpdateId: number | null
  ) {
    if (room.invalidated || this.rooms.get(room.pageId) !== room) return;

    const candidate = applyValidatedYjsUpdate(
      room.document,
      update,
      maxCollaborationDocumentBytes,
      room.stateUpdate
    );
    const persistenceDecision = assessCollaborationUpdatePersistence({
      snapshot,
      documentChanged: candidate.changed,
      historyEntries: room.history.length
    });

    // The first durable update must still pass the canonical SQL bootstrap
    // check, even when an empty page happens to encode to the empty Yjs state.
    if (!snapshot && room.maxUpdateId > 0 && persistenceDecision.action === "ignore") {
      candidate.document.destroy();
      if (room.clients.has(client.id) && client.socket.isOpen) {
        client.socket.sendJson({
          type: "update-ack",
          updateId: room.maxUpdateId,
          snapshot: false,
          noChange: true
        });
      }
      return;
    }

    const durableSnapshot = shouldCompactCollaborationHistory({
      clientSnapshot: snapshot,
      historyEntries: room.history.length,
      historyBytes: room.historyBytes,
      nextUpdateBytes: update.length
    });
    const persistedUpdate = durableSnapshot ? Buffer.from(candidate.stateUpdate) : update;
    let result:
      | { accepted: true; updateId: number }
      | {
          accepted: false;
          currentUpdateId: number;
          reason: CollaborationWriteRejectionReason;
        }
      | {
          accepted: false;
          currentUpdateId: 0;
          reason: "bootstrap-mismatch";
          summary: CollaborationBootstrapMismatchSummary;
        }
      | null;

    try {
      result = await transaction(async (dbClient) => {
        const access = await getPageAccess(room.pageId, client.user.id, dbClient, { lockPage: true });
        if (room.invalidated || this.rooms.get(room.pageId) !== room) return null;
        if (access.page.is_collection || access.page.is_archived || access.shareCount < 1) {
          throw new ApiError(403, "COLLABORATION_DISABLED", "Collaboration is not enabled for this page");
        }
        const collaborationState = await getCollaborationState(room.pageId, dbClient, { lock: true });
        assertCollaborationDocumentEpoch(collaborationState, client.documentEpoch);

        const currentRow = await dbClient.queryOne<{ max_update_id: number | null }>(
          "SELECT MAX(id) AS max_update_id FROM page_yjs_updates WHERE page_id = ?",
          [room.pageId]
        );
        const currentUpdateId = toSafeUpdateId(currentRow?.max_update_id ?? 0);
        const checkpoint = assessCollaborationWriteCheckpoint({
          durableUpdateId: currentUpdateId,
          roomUpdateId: room.maxUpdateId,
          snapshot,
          snapshotBaseUpdateId: baseUpdateId
        });
        if (!checkpoint.accepted) return checkpoint;

        if (snapshot && persistenceDecision.action === "reject") {
          return {
            accepted: false as const,
            currentUpdateId,
            reason: persistenceDecision.reason
          };
        }

        if (currentUpdateId === 0) {
          // The first durable Yjs state initializes collaboration from SQL. It
          // must be an exact semantic copy, never a partial client document that
          // later materialization could interpret as intentional block deletion.
          const storedBlocks = await dbClient.query<BlockRow>(
            "SELECT * FROM blocks WHERE page_id = ? ORDER BY id ASC FOR UPDATE",
            [room.pageId]
          );
          let bootstrapAssessment: CollaborationBootstrapAssessment;
          try {
            bootstrapAssessment = assessInitialCollaborationBootstrap({
              pageTitle: access.page.title,
              storedBlocks,
              candidate: readCollaborationMaterialization(candidate.document)
            });
          } catch (error) {
            if (error instanceof CollaborationDocumentError) {
              bootstrapAssessment = {
                accepted: false as const,
                summary: invalidInitialCollaborationBootstrapSummary({
                  storedBlockCount: storedBlocks.length
                })
              };
            } else {
              throw error;
            }
          }
          if (!bootstrapAssessment.accepted) {
            return {
              accepted: false as const,
              currentUpdateId: 0 as const,
              reason: "bootstrap-mismatch" as const,
              summary: bootstrapAssessment.summary
            };
          }
        }

        const insert = await dbClient.execute<{ insertId: number | bigint }>(
          `INSERT INTO page_yjs_updates (page_id, user_id, update_data, is_snapshot)
           VALUES (?, ?, ?, ?)`,
          [room.pageId, client.user.id, persistedUpdate, durableSnapshot ? 1 : 0]
        );
        const updateId = toSafeUpdateId(insert.insertId);
        if (durableSnapshot) {
          await dbClient.execute("DELETE FROM page_yjs_updates WHERE page_id = ? AND id < ?", [room.pageId, updateId]);
        }
        return { accepted: true as const, updateId };
      }).catch((error) => {
        if (error instanceof ApiError && error.code === "COLLABORATION_LINEAGE_CHANGED") {
          this.invalidateRoomForLineageChange(room);
          return null;
        }
        if (error instanceof ApiError && [403, 404].includes(error.statusCode)) {
          client.socket.close(error.statusCode === 404 ? 4003 : 4010, error.message);
          return null;
        }
        throw error;
      });
    } catch (error) {
      candidate.document.destroy();
      throw error;
    }

    if (!result || room.invalidated || this.rooms.get(room.pageId) !== room) {
      candidate.document.destroy();
      return;
    }
    if (!result.accepted) {
      candidate.document.destroy();
      if (result.reason === "room-stale") {
        console.warn("Invalidating a stale process-local collaboration room", {
          pageId: room.pageId,
          roomUpdateId: room.maxUpdateId,
          durableUpdateId: result.currentUpdateId
        });
        this.invalidateRoomForReload(
          room,
          "Collaboration state changed on another server; reloading durable history"
        );
      } else if (result.reason === "bootstrap-mismatch") {
        console.warn("Rejected a collaboration bootstrap that did not match canonical SQL state", {
          pageId: room.pageId,
          userId: client.user.id,
          ...result.summary
        });
        room.bootstrapWritePending = false;
        client.synced = false;
        if (room.bootstrapLeaderId === client.id) {
          room.bootstrapLeaderId = null;
          this.promoteBootstrapLeader(room);
        }
        if (room.clients.has(client.id) && client.socket.isOpen) {
          client.socket.close(4012, "Initial collaboration state did not match the saved page");
        }
      } else if (room.clients.has(client.id) && client.socket.isOpen) {
        client.socket.sendJson({
          type: "snapshot-rejected",
          lastUpdateId: result.currentUpdateId,
          reason: result.reason
        });
      }
      return;
    }

    const previousDocument = room.document;
    room.document = candidate.document;
    room.stateUpdate = Buffer.from(candidate.stateUpdate);
    previousDocument.destroy();

    const row: YjsUpdateRow = {
      id: result.updateId,
      update_data: persistedUpdate,
      is_snapshot: durableSnapshot ? 1 : 0
    };
    room.maxUpdateId = result.updateId;
    room.history = durableSnapshot ? [row] : [...room.history, row];
    room.historyBytes = durableSnapshot
      ? persistedUpdate.length
      : room.historyBytes + persistedUpdate.length;
    if (snapshot) {
      // A compaction snapshot is proven state-equivalent before persistence.
      // Peers need only the new durable cursor, not a second full document.
      for (const target of room.clients.values()) {
        if (target.id !== client.id) {
          target.socket.sendJson({ type: "compaction-complete", updateId: result.updateId });
        }
      }
    } else {
      // Server-enforced compaction changes only the durable representation.
      // Existing peers still receive the original incremental update while a
      // reconnect receives the equivalent full-state snapshot from history.
      const envelope = updateEnvelope(result.updateId, update);
      for (const target of room.clients.values()) target.socket.sendBinary(envelope);
      if (durableSnapshot) {
        // Reset cooperative client counters as well. Otherwise an honest client
        // could immediately submit a redundant snapshot after the server has
        // already compacted the same canonical state.
        for (const target of room.clients.values()) {
          target.socket.sendJson({ type: "compaction-complete", updateId: result.updateId });
        }
      }
    }
    if (room.clients.has(client.id) && client.socket.isOpen) {
      client.socket.sendJson({ type: "update-ack", updateId: result.updateId, snapshot });
    }

    if (room.bootstrapLeaderId === client.id) {
      room.bootstrapWritePending = false;
      room.bootstrapLeaderId = null;
      for (const waitingId of room.waitingForBootstrap) {
        const waiting = room.clients.get(waitingId);
        if (!waiting?.socket.isOpen) continue;
        waiting.synced = true;
        waiting.socket.sendJson({
          type: "sync-complete",
          connectionId: waiting.id,
          bootstrap: false,
          lastUpdateId: room.maxUpdateId
        });
        this.broadcastPresenceUpdate(room, waiting);
      }
      room.waitingForBootstrap.clear();
    }
  }

  private broadcastPresenceUpdate(
    room: Room,
    client: ClientContext,
    { removed = false, includeIdentity = false }: { removed?: boolean; includeIdentity?: boolean } = {}
  ) {
    const message = removed
      ? { type: "awareness-update", connectionId: client.id, state: null }
      : { type: "awareness-update", ...publicPresence(client, includeIdentity) };
    for (const target of room.clients.values()) {
      if (target.id !== client.id) target.socket.sendJson(message);
    }
  }

  private promoteBootstrapLeader(room: Room) {
    if (
      this.closed
      || room.invalidated
      || this.rooms.get(room.pageId) !== room
      || room.maxUpdateId > 0
      || room.bootstrapLeaderId
      || room.bootstrapWritePending
    ) return;

    while (room.waitingForBootstrap.size) {
      const nextId = room.waitingForBootstrap.values().next().value as string | undefined;
      if (!nextId) return;
      room.waitingForBootstrap.delete(nextId);
      const next = room.clients.get(nextId);
      if (!next?.socket.isOpen) continue;
      room.bootstrapLeaderId = next.id;
      next.synced = true;
      next.socket.sendJson({
        type: "sync-complete",
        connectionId: next.id,
        bootstrap: true,
        lastUpdateId: 0
      });
      this.broadcastPresenceUpdate(room, next);
      return;
    }
  }

  private removeRoomWhenIdle(room: Room) {
    if (
      !room.clients.size
      && room.pendingWrites === 0
      && !room.bootstrapWritePending
      && this.rooms.get(room.pageId) === room
    ) {
      this.rooms.delete(room.pageId);
      room.document.destroy();
    }
  }

  private handleClientClose(room: Room, client: ClientContext) {
    if (!room.clients.delete(client.id)) return;
    this.untrackClient(room.pageId, client.user.id);
    room.waitingForBootstrap.delete(client.id);
    this.broadcastPresenceUpdate(room, client, { removed: true });

    if (
      room.bootstrapLeaderId === client.id
      && room.maxUpdateId === 0
      && !room.bootstrapWritePending
    ) {
      room.bootstrapLeaderId = null;
      this.promoteBootstrapLeader(room);
    }

    this.removeRoomWhenIdle(room);
  }

  private runHeartbeat() {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const client of room.clients.values()) {
        if (now - client.socket.lastPongAt > heartbeatTimeoutMs) client.socket.terminate();
        else client.socket.ping();
      }
    }
  }

  private async recheckAccess() {
    if (this.closed || this.accessRecheckRunning) return;
    this.accessRecheckRunning = true;
    try {
      const checks: Promise<void>[] = [];
      for (const room of this.rooms.values()) {
        for (const client of room.clients.values()) {
          checks.push((async () => {
            try {
              if (await isPermanentlyBlockedTotpIp(client.ipAddress)) {
                client.socket.close(4003, "Access from this IP is blocked");
                return;
              }
              const currentUser = await db.queryOne<{
                auth_version?: number;
                country_login_mode?: UserRow["country_login_mode"];
                vpn_block_enabled?: UserRow["vpn_block_enabled"];
              }>(
                "SELECT auth_version, country_login_mode, vpn_block_enabled FROM users WHERE id = ?",
                [client.user.id]
              );
              if (!currentUser || Number(currentUser.auth_version ?? 1) !== client.authVersion) {
                client.socket.close(4003, "Authentication session was revoked");
                return;
              }
              await enforceCountryLoginPolicy(client.user.id, currentUser.country_login_mode, client.ipAddress);
              await enforceVpnAccessPolicy(
                client.user.id,
                currentUser.vpn_block_enabled,
                client.ipAddress,
                null,
                client.webRtcSignal
              );
              const access = await getPageAccess(room.pageId, client.user.id);
              if (access.page.is_collection || access.page.is_archived || access.shareCount < 1) {
                client.socket.close(4010, "Collaboration is no longer available");
                return;
              }
              const collaborationState = await getCollaborationState(room.pageId);
              if (!collaborationState || collaborationState.document_epoch !== client.documentEpoch) {
                this.invalidateRoomForLineageChange(room);
              }
            } catch (error) {
              if (error instanceof ApiError && error.code === "COUNTRY_LOGIN_BLOCKED") {
                client.socket.close(4003, "Access from this IP country is blocked");
                return;
              }
              if (error instanceof ApiError && error.code === "VPN_ACCESS_BLOCKED") {
                client.socket.close(4003, "Access from this VPN, proxy, or Tor network is blocked");
                return;
              }
              if (error instanceof ApiError && error.statusCode === 404) {
                client.socket.close(4003, "Page access was removed");
                return;
              }
              console.error("Failed to recheck collaboration access", { pageId: room.pageId, error });
            }
          })());
        }
      }
      await Promise.allSettled(checks);
    } finally {
      this.accessRecheckRunning = false;
    }
  }
}

export function attachPageCollaborationServer(server: CollaborationNetworkServer) {
  return new PageCollaborationHub(server);
}

export function disconnectSharedUser(pageId: string, userId: string, reason?: string) {
  for (const hub of activeHubs) hub.disconnectUser(pageId, userId, reason);
}

export function disconnectPageCollaborators(pageId: string, reason?: string) {
  for (const hub of activeHubs) hub.disconnectPage(pageId, reason);
}

export function disconnectUserCollaborators(userId: string, reason?: string) {
  for (const hub of activeHubs) hub.disconnectUserEverywhere(userId, reason);
}

export function disconnectIpCollaborators(ipAddress: string, reason?: string) {
  for (const hub of activeHubs) hub.disconnectIpEverywhere(ipAddress, reason);
}

export function broadcastCanonicalAttachment(pageId: string, block: unknown) {
  for (const hub of activeHubs) hub.notifyCanonicalAttachment(pageId, block);
}
