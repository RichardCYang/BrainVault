import net from "node:net";

export type ParsedDatabaseUrl = {
  protocol: "mariadb:" | "mysql:";
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  tls: boolean;
};

function parseTlsFlag(url: URL) {
  const unsupported = [...new Set([...url.searchParams.keys()].filter((key) => key !== "ssl"))];
  if (unsupported.length) {
    throw new Error(`Database URL contains unsupported query parameter(s): ${unsupported.join(", ")}`);
  }

  const values = url.searchParams.getAll("ssl");
  if (values.length > 1) throw new Error("Database URL must not repeat the ssl query parameter");
  if (!values.length) return false;

  const value = values[0].trim().toLowerCase();
  if (value !== "true" && value !== "false") {
    throw new Error("Database URL ssl query parameter must be true or false");
  }
  return value === "true";
}

function normalizedDatabaseHost(host: string) {
  const withoutBrackets = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  return withoutBrackets.replace(/\.$/, "").toLowerCase();
}

export function isLoopbackDatabaseHost(host: string) {
  const normalized = normalizedDatabaseHost(host);
  if (normalized === "localhost") return true;
  const family = net.isIP(normalized);
  if (family === 4) return normalized.split(".")[0] === "127";
  return family === 6 && normalized === "::1";
}

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
    database,
    tls: parseTlsFlag(url)
  };
}

export function assertSecureDatabaseTransport(
  rawUrl: string,
  { production, name = "DATABASE_URL" }: { production: boolean; name?: string }
) {
  const parsed = parseDatabaseUrl(rawUrl, { requireDatabase: false });
  if (production && !isLoopbackDatabaseHost(parsed.host) && !parsed.tls) {
    throw new Error(`${name} must enable TLS with ?ssl=true for a remote database host in production`);
  }
  return parsed;
}

export function databaseOptionsWithoutSchema(parsed: ParsedDatabaseUrl) {
  return {
    host: parsed.host,
    port: parsed.port,
    user: parsed.user,
    password: parsed.password,
    timezone: "Z" as const,
    charset: "UTF8MB4" as const,
    collation: "UTF8MB4_UNICODE_CI" as const,
    ...(parsed.tls ? { ssl: true as const } : {})
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
