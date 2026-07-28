import { describe, expect, it } from "vitest";
import { inspectStorageKeys } from "../public/storage-snapshot.js";

class AlternatingDelimiterCollisionStorage {
  constructor() {
    this.pass = -1;
    this.lengthReadInPass = 0;
    this.currentKeys = [];
  }

  get length() {
    if (this.lengthReadInPass === 0) {
      this.pass += 1;
      this.currentKeys = this.pass % 2 === 0
        ? ["draft\u0000survivor"]
        : ["draft", "survivor"];
    }
    const length = this.currentKeys.length;
    this.lengthReadInPass = (this.lengthReadInPass + 1) % 3;
    return length;
  }

  key(index) {
    return this.currentKeys[index] ?? null;
  }
}

describe("storage snapshot stability", () => {
  it("does not treat delimiter-colliding key sets as the same stable snapshot", () => {
    const inspection = inspectStorageKeys(
      new AlternatingDelimiterCollisionStorage(),
      { maxPasses: 6, stablePasses: 3 }
    );

    expect(inspection.reliable).toBe(false);
    expect(inspection.keys.sort()).toEqual(["draft", "draft\u0000survivor", "survivor"].sort());
  });
});
