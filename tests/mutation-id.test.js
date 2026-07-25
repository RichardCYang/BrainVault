import { describe, expect, it } from "vitest";
import { createMutationId, submitWithFreshMutationIdOnReuse } from "../public/mutation-id.js";

describe("mutation id generation", () => {
  it("uses Web Crypto bytes when randomUUID is unavailable", () => {
    const cryptoApi = {
      getRandomValues(bytes) {
        bytes.fill(0xab);
        return bytes;
      }
    };

    expect(createMutationId({ cryptoApi })).toBe(`mut_${"ab".repeat(16)}`);
  });

  it("does not collide for same-millisecond fallback calls without Web Crypto", () => {
    const options = { cryptoApi: null, now: () => 123456789, random: () => 0.5 };
    const first = createMutationId(options);
    const second = createMutationId(options);

    expect(first).not.toBe(second);
    expect(first).toMatch(/^mut_[a-z0-9_]+$/);
    expect(second).toMatch(/^mut_[a-z0-9_]+$/);
  });

  it("rotates a reused mutation id and retries once", async () => {
    const task = { mutationId: "mut_collision" };
    const seen = [];
    const changed = [];
    const result = await submitWithFreshMutationIdOnReuse(
      task,
      async () => {
        seen.push(task.mutationId);
        if (seen.length === 1) throw Object.assign(new Error("collision"), { code: "MUTATION_ID_REUSED" });
        return "saved";
      },
      (updatedTask) => changed.push(updatedTask.mutationId)
    );

    expect(result).toBe("saved");
    expect(seen).toHaveLength(2);
    expect(seen[1]).not.toBe(seen[0]);
    expect(changed).toEqual([seen[1]]);
  });
});
