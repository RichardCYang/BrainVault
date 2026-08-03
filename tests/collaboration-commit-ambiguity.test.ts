import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/db.js", () => ({
  db: { query: vi.fn(), queryOne: vi.fn(), execute: vi.fn() },
  transaction: vi.fn()
}));

import { PageCollaborationHub } from "../src/lib/collaboration-server.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("collaboration commit ambiguity recovery", () => {
  it("invalidates the whole room so every client reloads durable Yjs rows", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const server = createServer();
    const hub = new PageCollaborationHub(server);
    const firstSocket = {
      isOpen: true,
      close: vi.fn(),
      sendJson: vi.fn(),
      sendBinary: vi.fn()
    };
    const secondSocket = {
      isOpen: true,
      close: vi.fn(),
      sendJson: vi.fn(),
      sendBinary: vi.fn()
    };
    const firstClient = {
      id: "con_first",
      socket: firstSocket,
      user: { id: "usr_first", username: "first", name: "First", avatar_data: null },
      synced: true,
      awareness: { blockId: null, field: null, selection: null },
      rateWindowStartedAt: Date.now(),
      frameCount: 0,
      byteCount: 0
    };
    const secondClient = {
      ...firstClient,
      id: "con_second",
      socket: secondSocket,
      user: { id: "usr_second", username: "second", name: "Second", avatar_data: null }
    };
    const destroy = vi.fn();
    const room = {
      pageId: "pag_commit_unknown",
      clients: new Map([[firstClient.id, firstClient], [secondClient.id, secondClient]]),
      history: [],
      maxUpdateId: 7,
      loaded: true,
      loadFailed: false,
      invalidated: false,
      loadPromise: Promise.resolve(),
      bootstrapLeaderId: null,
      waitingForBootstrap: new Set<string>(),
      writeQueue: Promise.resolve(),
      pendingWrites: 0,
      pendingWriteBytes: 0,
      bootstrapWritePending: false,
      document: { destroy }
    };

    const internalHub = hub as unknown as {
      rooms: Map<string, unknown>;
      enqueueRoomWrite: (
        targetRoom: unknown,
        client: unknown,
        writeBytes: number,
        action: () => Promise<void>
      ) => Promise<void> | null;
    };
    internalHub.rooms.set(room.pageId, room);
    const ambiguousError = Object.assign(new Error("commit response lost"), { commitOutcomeUnknown: true });

    internalHub.enqueueRoomWrite(room, firstClient, 1, async () => {
      throw ambiguousError;
    });
    await room.writeQueue;
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(room.invalidated).toBe(true);
    expect(internalHub.rooms.has(room.pageId)).toBe(false);
    expect(firstSocket.close).toHaveBeenCalledWith(
      1011,
      "Collaboration state is reloading after an uncertain database commit"
    );
    expect(secondSocket.close).toHaveBeenCalledWith(
      1011,
      "Collaboration state is reloading after an uncertain database commit"
    );
    expect(destroy).toHaveBeenCalledTimes(1);

    await hub.close();
  });
});
