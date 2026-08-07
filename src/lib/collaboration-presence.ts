export const maxCollaborationAvatarDataUrlBytes = 64 * 1024;

/**
 * Presence is broadcast frequently. Keep identity payloads bounded so a valid
 * profile image cannot turn a small cursor event into a large fan-out message.
 */
export function getCollaborationAvatarData(value: string | null | undefined) {
  if (typeof value !== "string" || !value) return null;
  return Buffer.byteLength(value, "utf8") <= maxCollaborationAvatarDataUrlBytes
    ? value
    : null;
}
