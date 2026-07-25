let fallbackSequence = 0;

export function createMutationId({
  cryptoApi = globalThis.crypto,
  now = Date.now,
  random = Math.random
} = {}) {
  const randomUuid = cryptoApi?.randomUUID?.();
  if (randomUuid) return `mut_${randomUuid}`;

  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const entropy = [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
    return `mut_${entropy}`;
  }

  fallbackSequence = (fallbackSequence + 1) % Number.MAX_SAFE_INTEGER;
  const timestamp = Math.trunc(now()).toString(36);
  const sequence = fallbackSequence.toString(36);
  const entropy = Math.trunc(random() * Number.MAX_SAFE_INTEGER).toString(36);
  return `mut_${timestamp}_${sequence}_${entropy}`.slice(0, 64);
}
export async function submitWithFreshMutationIdOnReuse(task, submit, onMutationIdChanged = null) {
  try {
    return await submit();
  } catch (error) {
    if (error?.code !== "MUTATION_ID_REUSED") throw error;
    task.mutationId = createMutationId();
    onMutationIdChanged?.(task);
    return submit();
  }
}
