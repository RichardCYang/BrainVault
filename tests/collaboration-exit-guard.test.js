import { describe, expect, it } from "vitest";
import { assertCollaborationExitSafe } from "../public/collaboration-exit-guard.js";

describe("collaboration exit guard", () => {
  it("blocks navigation while local updates are unconfirmed and the socket is not ready", () => {
    expect(() =>
      assertCollaborationExitSafe(
        { hasUnconfirmedLocalChanges: true, isReady: false },
        "Synchronization required"
      )
    ).toThrow("Synchronization required");
  });

  it("allows a synchronized session to flush its pending work", () => {
    expect(() =>
      assertCollaborationExitSafe({ hasUnconfirmedLocalChanges: true, isReady: true })
    ).not.toThrow();
  });

  it("allows leaving an offline session when it has no unconfirmed local update", () => {
    expect(() =>
      assertCollaborationExitSafe({ hasUnconfirmedLocalChanges: false, isReady: false })
    ).not.toThrow();
  });
});
