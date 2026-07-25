import { createHash } from "node:crypto";
import { ApiError } from "./http.js";

function canonicalizeMutationValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeMutationValue);
  if (!value || typeof value !== "object") return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, entryValue]) => [key, canonicalizeMutationValue(entryValue)])
  );
}

export function createMutationRequestHash(value: unknown) {
  const serialized = JSON.stringify(canonicalizeMutationValue(value)) ?? "null";
  return createHash("sha256").update(serialized, "utf8").digest("hex");
}

export function isMatchingMutationReplay(
  storedMutationId: string | null | undefined,
  storedRequestHash: string | null | undefined,
  mutationId: string | undefined,
  requestHash: string | undefined
) {
  if (!mutationId || storedMutationId !== mutationId) return false;
  if (!requestHash || !storedRequestHash || storedRequestHash !== requestHash) {
    throw new ApiError(
      409,
      "MUTATION_ID_REUSED",
      "This mutation id was already used for a different request. The new data was not applied."
    );
  }
  return true;
}
