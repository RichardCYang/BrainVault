import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const connection = {
    beginTransaction: vi.fn(),
    commit: vi.fn(),
    rollback: vi.fn(),
    release: vi.fn(),
    query: vi.fn(),
    execute: vi.fn()
  };
  const pool = {
    getConnection: vi.fn(async () => connection),
    query: vi.fn(),
    execute: vi.fn(),
    end: vi.fn()
  };
  return { connection, pool };
});

vi.mock("mariadb", () => ({
  default: {
    createPool: () => mocks.pool
  }
}));

import { TransactionCommitOutcomeUnknownError, transaction } from "../src/lib/db.js";

describe("database transaction outcome handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.connection.beginTransaction.mockResolvedValue(undefined);
    mocks.connection.commit.mockResolvedValue(undefined);
    mocks.connection.rollback.mockResolvedValue(undefined);
    mocks.connection.release.mockResolvedValue(undefined);
  });

  it("keeps callback failures distinguishable from commit ambiguity", async () => {
    const callbackError = new Error("write failed before commit");

    await expect(transaction(async () => {
      throw callbackError;
    })).rejects.toBe(callbackError);

    expect(mocks.connection.commit).not.toHaveBeenCalled();
    expect(mocks.connection.rollback).toHaveBeenCalledOnce();
    expect(mocks.connection.release).toHaveBeenCalledOnce();
  });

  it("marks commit response failures as outcome-unknown", async () => {
    const commitError = new Error("connection lost during COMMIT");
    mocks.connection.commit.mockRejectedValueOnce(commitError);

    const result = transaction(async () => "written");

    await expect(result).rejects.toMatchObject({
      name: "TransactionCommitOutcomeUnknownError",
      commitOutcomeUnknown: true,
      cause: commitError
    });
    await expect(result).rejects.toBeInstanceOf(TransactionCommitOutcomeUnknownError);
    expect(mocks.connection.rollback).toHaveBeenCalledOnce();
    expect(mocks.connection.release).toHaveBeenCalledOnce();
  });

  it("does not turn a successful commit into a false write failure when release fails", async () => {
    const releaseError = new Error("pool release failed");
    mocks.connection.release.mockRejectedValueOnce(releaseError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(transaction(async () => "committed")).resolves.toBe("committed");

    expect(mocks.connection.commit).toHaveBeenCalledOnce();
    expect(consoleError).toHaveBeenCalledWith("Failed to release a database connection", releaseError);
    consoleError.mockRestore();
  });
});
