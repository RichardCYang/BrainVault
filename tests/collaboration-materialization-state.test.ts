import { describe, expect, it } from "vitest";
import {
  currentCollaborationMaterializationVersion,
  needsCollaborationMaterialization
} from "../src/lib/collaboration-protocol.js";

describe("collaboration materialization provenance", () => {
  it("allows an empty history without a materialization", () => {
    expect(needsCollaborationMaterialization({
      latestUpdateId: 0,
      materializedUpdateId: 0,
      materializationVersion: 0
    })).toBe(false);
  });

  it("blocks stale, ahead-of-history, and legacy unbound checkpoints", () => {
    expect(needsCollaborationMaterialization({
      latestUpdateId: 9,
      materializedUpdateId: 8,
      materializationVersion: currentCollaborationMaterializationVersion
    })).toBe(true);
    expect(needsCollaborationMaterialization({
      latestUpdateId: 9,
      materializedUpdateId: 10,
      materializationVersion: currentCollaborationMaterializationVersion
    })).toBe(true);
    expect(needsCollaborationMaterialization({
      latestUpdateId: 9,
      materializedUpdateId: 9,
      materializationVersion: 0
    })).toBe(true);
  });

  it("accepts only a server-authoritative checkpoint for non-empty history", () => {
    expect(needsCollaborationMaterialization({
      latestUpdateId: 9,
      materializedUpdateId: 9,
      materializationVersion: currentCollaborationMaterializationVersion
    })).toBe(false);
  });
});
