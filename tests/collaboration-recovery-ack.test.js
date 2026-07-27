import { describe, expect, it } from "vitest";
import { shouldClearLocalRecoveryAfterAck } from "../public/collaboration.js";

describe("collaboration recovery acknowledgement safety", () => {
  it("keeps the durable recovery copy when any local update still needs replay", () => {
    expect(shouldClearLocalRecoveryAfterAck(0, true)).toBe(false);
  });

  it("keeps recovery while acknowledged writes are still pending", () => {
    expect(shouldClearLocalRecoveryAfterAck(1, false)).toBe(false);
  });

  it("clears recovery only after all local updates are acknowledged", () => {
    expect(shouldClearLocalRecoveryAfterAck(0, false)).toBe(true);
  });
});
