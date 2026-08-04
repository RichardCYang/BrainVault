/**
 * Escapes a literal string for use inside a MariaDB LIKE pattern.
 *
 * A non-backslash escape character avoids sql_mode-dependent backslash parsing.
 */
export function escapeSqlLikeLiteral(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

export function toSqlLikeContainsPattern(value: string): string {
  return `%${escapeSqlLikeLiteral(value)}%`;
}
