const activeExports = new Map<string, Set<{ sessionId: string; cancel: () => void }>>();

export function registerActiveBackupExport(userId: string, sessionId: string, cancel: () => void) {
  const exports = activeExports.get(userId) ?? new Set();
  activeExports.set(userId, exports);
  const entry = { sessionId, cancel };
  exports.add(entry);
  return () => {
    exports.delete(entry);
    if (exports.size === 0 && activeExports.get(userId) === exports) activeExports.delete(userId);
  };
}

export function cancelActiveBackupExports(userId: string, sessionId?: string) {
  for (const entry of activeExports.get(userId) ?? []) {
    if (sessionId === undefined || entry.sessionId === sessionId) entry.cancel();
  }
}
