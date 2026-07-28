import { describe, expect, it } from "vitest";
import { assessCollaborationWriteCheckpoint } from "../src/lib/collaboration-protocol.js";

describe("collaboration durable-room freshness checkpoint", () => {
  it("accepts an ordinary write only when the room includes the durable tip", () => {
    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 9,
      roomUpdateId: 9,
      snapshot: false,
      snapshotBaseUpdateId: null
    })).toEqual({ accepted: true });

    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 10,
      roomUpdateId: 9,
      snapshot: false,
      snapshotBaseUpdateId: null
    })).toEqual({
      accepted: false,
      currentUpdateId: 10,
      reason: "room-stale"
    });
  });

  it("rejects a stale room before considering a client snapshot checkpoint", () => {
    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 12,
      roomUpdateId: 11,
      snapshot: true,
      snapshotBaseUpdateId: 11
    })).toEqual({
      accepted: false,
      currentUpdateId: 12,
      reason: "room-stale"
    });
  });

  it("rejects a stale snapshot base without invalidating a fresh room", () => {
    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 12,
      roomUpdateId: 12,
      snapshot: true,
      snapshotBaseUpdateId: 11
    })).toEqual({
      accepted: false,
      currentUpdateId: 12,
      reason: "snapshot-base-mismatch"
    });

    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 12,
      roomUpdateId: 12,
      snapshot: true,
      snapshotBaseUpdateId: 12
    })).toEqual({ accepted: true });

    expect(assessCollaborationWriteCheckpoint({
      durableUpdateId: 12,
      roomUpdateId: 12,
      snapshot: true,
      snapshotBaseUpdateId: null
    })).toEqual({
      accepted: false,
      currentUpdateId: 12,
      reason: "snapshot-base-mismatch"
    });
  });
});
