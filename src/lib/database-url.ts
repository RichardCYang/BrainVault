export type ParsedDatabaseUrl = {
  protocol: "mariadb:" | "mysql:";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
};

export function parseDatabaseUrl(rawUrl: string, { requireDatabase }: { requireDatabase: boolean }): ParsedDatabaseUrl {
  const url = new URL(rawUrl);
  if (url.protocol !== "mariadb:" && url.protocol !== "mysql:") {
    throw new Error("Database URLs must start with mariadb:// or mysql://");
  }

  const database = url.pathname.replace(/^\//, "") || undefined;
  if (requireDatabase && !database) {
    throw new Error("DATABASE_URL must include a database name, for example /brainvault");
  }

  if (!url.username) {
    throw new Error("DATABASE_URL must include a database user");
  }

  return {
    protocol: url.protocol,
    host: url.hostname || "127.0.0.1",
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database
  };
}

export function databaseOptionsWithoutSchema(parsed: ParsedDatabaseUrl) {
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    timezone: "Z" as const,
    charset: "UTF8MB4" as const,
    collation: "UTF8MB4_UNICODE_CI" as const
  };
}

export function databaseOptionsWithSchema(parsed: ParsedDatabaseUrl) {
  return {
    ...databaseOptionsWithoutSchema(parsed),
    database: parsed.database
  };
}

export function quoteIdentifier(identifier: string) {
  if (!identifier) {
    throw new Error("Identifier cannot be empty");
  }
  return `\`${identifier.replace(/`/g, "``")}\``;
}

export function quoteString(value: string) {
  return `'${value.replace(/\\/g, "\\\\").replace(/'/g, "''")}'`;
}
