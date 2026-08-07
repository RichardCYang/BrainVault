import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyValidatedYjsUpdate,
  createValidatedYjsDocument,
  InvalidYjsUpdateError
} from "../src/lib/yjs-validation.js";

const limit = 1024 * 1024;

function titleOf(document: Y.Doc) {
  return document.getText("title").toString();
}

describe("server-side Yjs validation", () => {
  it("merges concurrent updates deterministically while leaving the live document isolated", () => {
    const base = new Y.Doc();
    base.getText("title").insert(0, "BrainVault");
    const baseUpdate = Y.encodeStateAsUpdate(base);
    const baseVector = Y.encodeStateVector(base);

    const left = new Y.Doc();
    const right = new Y.Doc();
    Y.applyUpdate(left, baseUpdate);
    Y.applyUpdate(right, baseUpdate);
    left.getText("title").insert(10, " left");
    right.getText("title").insert(0, "shared ");
    const leftUpdate = Y.encodeStateAsUpdate(left, baseVector);
    const rightUpdate = Y.encodeStateAsUpdate(right, baseVector);

    const live = createValidatedYjsDocument([baseUpdate], limit);
    const candidate = applyValidatedYjsUpdate(live, leftUpdate, limit);
    const cachedCandidate = applyValidatedYjsUpdate(live, leftUpdate, limit, baseUpdate);
    expect(titleOf(live)).toBe("BrainVault");
    expect(titleOf(candidate.document)).not.toBe(titleOf(live));
    expect(Buffer.from(cachedCandidate.stateUpdate)).toEqual(Buffer.from(candidate.stateUpdate));

    const leftThenRight = createValidatedYjsDocument([candidate.stateUpdate, rightUpdate], limit);
    const rightThenLeft = createValidatedYjsDocument([baseUpdate, rightUpdate, leftUpdate], limit);
    expect(titleOf(leftThenRight)).toBe(titleOf(rightThenLeft));
    expect(Buffer.from(Y.encodeStateVector(leftThenRight))).toEqual(
      Buffer.from(Y.encodeStateVector(rightThenLeft))
    );

    for (const document of [
      base,
      left,
      right,
      live,
      candidate.document,
      cachedCandidate.document,
      leftThenRight,
      rightThenLeft
    ]) {
      document.destroy();
    }
  });

  it("rejects a document whose canonical state exceeds the configured limit", () => {
    const source = new Y.Doc();
    source.getText("title").insert(0, "x".repeat(4096));
    const update = Y.encodeStateAsUpdate(source);
    expect(() => createValidatedYjsDocument([update], 128)).toThrowError(InvalidYjsUpdateError);
    source.destroy();
  });

  it("rejects malformed update bytes", () => {
    expect(() => createValidatedYjsDocument([Uint8Array.of(0xff, 0xff, 0xff)], limit)).toThrowError(
      InvalidYjsUpdateError
    );
  });
});
