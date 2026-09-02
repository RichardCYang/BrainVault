const safeReadMethods = new Set(["GET", "HEAD"]);

export const apiReadRequestTimeoutMs = 15_000;
export const apiReadRequestRetryCount = 1;

export class ApiReadTimeoutError extends Error {
  constructor(message = "API read request timed out") {
    super(message);
    this.name = "ApiReadTimeoutError";
    this.code = "REQUEST_TIMEOUT";
  }
}

export function isSafeApiReadMethod(method) {
  return safeReadMethods.has(String(method || "GET").toUpperCase());
}

function normalizeRetryCount(value) {
  const count = Number(value);
  return Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function normalizeTimeoutMs(value) {
  const timeoutMs = Number(value);
  return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.floor(timeoutMs) : 0;
}

function isRetryableReadTransportError(error) {
  return error instanceof ApiReadTimeoutError
    || error instanceof TypeError
    || error?.name === "AbortError"
    || error?.name === "TimeoutError";
}

async function readResponseText(response) {
  if (response.status === 204) return "";
  return response.text();
}

async function runTimedFetchAttempt(
  fetchImpl,
  input,
  init,
  {
    timeoutMs,
    beforeDispatch = null,
    beforeRead = null,
    afterRead = null
  }
) {
  const parentSignal = init.signal ?? null;
  if (timeoutMs <= 0 || typeof AbortController !== "function") {
    // This hook must remain synchronous and adjacent to fetchImpl. Awaiting it
    // would create a microtask window in which a destructive intent can become stale.
    beforeDispatch?.();
    const response = await fetchImpl(input, init);
    await beforeRead?.(response);
    const text = await readResponseText(response);
    await afterRead?.(response, text);
    return { response, text };
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer = null;
  const handleParentAbort = () => controller.abort(parentSignal?.reason);

  if (parentSignal?.aborted) {
    handleParentAbort();
  } else if (parentSignal?.addEventListener) {
    parentSignal.addEventListener("abort", handleParentAbort, { once: true });
  }

  timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    // Run after timer/signal setup but synchronously immediately before dispatch.
    beforeDispatch?.();
    const response = await fetchImpl(input, { ...init, signal: controller.signal });
    await beforeRead?.(response);
    const text = await readResponseText(response);
    await afterRead?.(response, text);
    return { response, text };
  } catch (error) {
    if (timedOut && !parentSignal?.aborted) throw new ApiReadTimeoutError();
    throw error;
  } finally {
    if (timer !== null) clearTimeout(timer);
    parentSignal?.removeEventListener?.("abort", handleParentAbort);
  }
}

/**
 * Fetches an API response and consumes its text body under the same deadline.
 * Only safe reads (GET/HEAD) receive a deadline and automatic retry. Mutations
 * deliberately keep their existing one-shot semantics so a lost response can
 * never turn into an accidental duplicate write. `beforeDispatch` is a synchronous
 * last-moment guard; it intentionally cannot yield between validation and fetch.
 */
export async function fetchApiResponseText(
  input,
  init = {},
  {
    fetchImpl = globalThis.fetch,
    readTimeoutMs = apiReadRequestTimeoutMs,
    readRetryCount = apiReadRequestRetryCount,
    beforeAttempt = null,
    beforeDispatch = null,
    beforeRead = null,
    afterRead = null
  } = {}
) {
  if (typeof fetchImpl !== "function") throw new TypeError("fetch is unavailable");

  const safeRead = isSafeApiReadMethod(init.method);
  const timeoutMs = safeRead ? normalizeTimeoutMs(readTimeoutMs) : 0;
  const retryCount = safeRead ? normalizeRetryCount(readRetryCount) : 0;
  let attempt = 0;

  while (true) {
    await beforeAttempt?.(attempt);
    try {
      return await runTimedFetchAttempt(fetchImpl, input, init, {
        timeoutMs,
        beforeDispatch,
        beforeRead,
        afterRead
      });
    } catch (error) {
      if (
        init.signal?.aborted
        || attempt >= retryCount
        || !isRetryableReadTransportError(error)
      ) {
        throw error;
      }
      attempt += 1;
    }
  }
}
