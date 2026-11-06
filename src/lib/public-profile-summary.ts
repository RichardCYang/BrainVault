export const maxPublicProfileImageBytes = 16 * 1024;

export function boundedPublicProfileImage(value: string | null | undefined) {
  return typeof value === "string" && Buffer.byteLength(value, "utf8") <= maxPublicProfileImageBytes
    ? value
    : null;
}

// Bound binary profile fields in SQL as well as in the DTO: limiting only the
// JSON output still transfers one full MEDIUMTEXT avatar for every joined row.
// Aliases are supplied by source code, never by request input.
export function publicProfileSummaryProjection(alias: "" | "u" = "") {
  const column = (name: string) => alias ? `${alias}.${name}` : name;
  return ["id", "username", "name", "avatar_data", "preferred_language", "default_collection_icon", "theme", "created_at", "updated_at"]
    .map((name) => name === "avatar_data" || name === "default_collection_icon"
      ? `CASE WHEN OCTET_LENGTH(${column(name)}) <= ${maxPublicProfileImageBytes} THEN ${column(name)} ELSE NULL END AS ${name}`
      : column(name))
    .join(", ");
}
