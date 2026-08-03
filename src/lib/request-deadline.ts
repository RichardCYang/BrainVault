export type AbsoluteDeadlineRequest = {
  destroy(error?: Error): unknown;
  once(event: "close", listener: () => void): unknown;
};

export function enforceAbsoluteRequestDeadline(
  request: AbsoluteDeadlineRequest,
  timeoutMs: number,
  createTimeoutError: () => Error
) {
  const timer = setTimeout(() => request.destroy(createTimeoutError()), timeoutMs);
  timer.unref();
  request.once("close", () => clearTimeout(timer));
}
