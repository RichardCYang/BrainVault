import mariadb, { type Pool, type PoolConnection, type RowsWithMeta, type UpsertResult } from "mariadb";
import { env } from "../config/env.js";
import { databaseOptionsWithSchema, parseDatabaseUrl } from "./database-url.js";
import { assertMariaDbCrashDurabilityVariables, type MariaDbVariableRow } from "./database-durability.js";

export type DbValue = string | number | boolean | null | Date | Buffer;

export type DbClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly DbValue[]
  ): Promise<T[]>;
  queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params?: readonly DbValue[]
  ): Promise<T | undefined>;
  executeText(sql: string): Promise<void>;
  execute<T = UpsertResult>(sql: string, params?: readonly DbValue[]): Promise<T>;
};

const databaseConfig = parseDatabaseUrl(env.DATABASE_URL, { requireDatabase: true });
const strictTransactionalSqlMode =
  "SET SESSION sql_mode = IF(" +
  "FIND_IN_SET('STRICT_TRANS_TABLES', @@SESSION.sql_mode) > 0 " +
  "OR FIND_IN_SET('STRICT_ALL_TABLES', @@SESSION.sql_mode) > 0, " +
  "@@SESSION.sql_mode, " +
  "CONCAT_WS(',', NULLIF(@@SESSION.sql_mode, ''), 'STRICT_TRANS_TABLES'))";

// Keep only one permanently-idle connection instead of the connector default of
// keeping the whole pool at minimumIdle=connectionLimit. BrainVault already runs
// a lightweight auth-session prune every minute, so that single connection is
// exercised in the background while burst-only connections are retired quickly.
// This prevents long-idle deployments from accumulating server-expired sockets
// that must be rediscovered on the first user request after an idle period.
const databasePoolMinimumIdle = 1;
const databasePoolIdleTimeoutSeconds = 30;
const databaseSocketKeepAliveDelayMs = 30_000;

export const pool: Pool = mariadb.createPool({
  ...databaseOptionsWithSchema(databaseConfig),
  connectionLimit: env.DATABASE_CONNECTION_LIMIT,
  minimumIdle: Math.min(databasePoolMinimumIdle, env.DATABASE_CONNECTION_LIMIT),
  idleTimeout: databasePoolIdleTimeoutSeconds,
  // TCP keepalive does not replace MariaDB wait_timeout management, but it helps
  // the kernel discover half-open network paths before they become a user-visible
  // first-query stall. The pool still validates an idle connection on checkout.
  keepAliveDelay: databaseSocketKeepAliveDelayMs,
  insertIdAsNumber: true,
  bigIntAsNumber: true,
  // Version counters are BIGINT UNSIGNED. Never approximate a value outside
  // JavaScript's exact integer range: an approximate optimistic-lock token can
  // turn a stale write/delete into an accepted destructive mutation.
  checkNumberRange: true,
  namedPlaceholders: false,
  // Never let an operator's permissive server default turn an invalid write
  // into a warning plus silent truncation/coercion.
  initSql: strictTransactionalSqlMode
});

export function createDedicatedDbConnection() {
  return mariadb.createConnection({
    ...databaseOptionsWithSchema(databaseConfig),
    insertIdAsNumber: true,
    bigIntAsNumber: true,
    checkNumberRange: true,
    namedPlaceholders: false,
    initSql: strictTransactionalSqlMode
  });
}

function createClient(target: Pool | PoolConnection): DbClient {
  async function runQuery<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    params: readonly DbValue[] = []
  ): Promise<T[]> {
    const rows = await target.query<RowsWithMeta<T>, readonly DbValue[]>(sql, params);
    return Array.from(rows as T[]);
  }

  const client: DbClient = {
    query: runQuery,
    async queryOne<T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params: readonly DbValue[] = []
    ): Promise<T | undefined> {
      const rows = await runQuery<T>(sql, params);
      return rows.at(0);
    },
    async executeText(sql: string): Promise<void> {
      // SQL migration scripts can contain SQL-level PREPARE/EXECUTE commands.
      // Send those trusted statements over COM_QUERY instead of nesting them
      // inside the connector's binary prepared-statement protocol.
      await target.query(sql);
    },
    async execute<T = UpsertResult>(sql: string, params: readonly DbValue[] = []): Promise<T> {
      return target.execute<T, readonly DbValue[]>(sql, params);
    }
  };

  return client;
}

export const db = createClient(pool);

export async function assertDatabaseCrashDurability(client: DbClient = db) {
  const rows = await client.query<MariaDbVariableRow>(`
    SHOW GLOBAL VARIABLES
    WHERE Variable_name IN (
      'innodb_flush_log_at_trx_commit',
      'log_bin',
      'sync_binlog',
      'binlog_storage_engine'
    )
  `);
  assertMariaDbCrashDurabilityVariables(rows);
}

export class TransactionCommitOutcomeUnknownError extends Error {
  readonly commitOutcomeUnknown = true;

  constructor(cause: unknown) {
    super("Database commit outcome could not be confirmed", { cause });
    this.name = "TransactionCommitOutcomeUnknownError";
  }
}

export async function transaction<Result>(fn: (client: DbClient) => Promise<Result>) {
  const conn = await pool.getConnection();
  let commitStarted = false;

  try {
    // Backup, restore, and destructive-operation snapshots span multiple SELECTs.
    // Do not depend on a server-wide isolation default that operators can change.
    await conn.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
    await conn.beginTransaction();
    const result = await fn(createClient(conn));
    commitStarted = true;
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback().catch(() => undefined);
    if (commitStarted) throw new TransactionCommitOutcomeUnknownError(error);
    throw error;
  } finally {
    try {
      await conn.release();
    } catch (releaseError) {
      console.error("Failed to release a database connection", releaseError);
    }
  }
}

export async function closeDb() {
  await pool.end();
}
