import mariadb, { type Pool, type PoolConnection, type RowsWithMeta, type UpsertResult } from "mariadb";
import { env } from "../config/env.js";
import { databaseOptionsWithSchema, parseDatabaseUrl } from "./database-url.js";

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
  execute<T = UpsertResult>(sql: string, params?: readonly DbValue[]): Promise<T>;
};

const databaseConfig = parseDatabaseUrl(env.DATABASE_URL, { requireDatabase: true });

export const pool: Pool = mariadb.createPool({
  ...databaseOptionsWithSchema(databaseConfig),
  connectionLimit: env.DATABASE_CONNECTION_LIMIT,
  insertIdAsNumber: true,
  bigIntAsNumber: true,
  namedPlaceholders: false
});

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
    async execute<T = UpsertResult>(sql: string, params: readonly DbValue[] = []): Promise<T> {
      return target.execute<T, readonly DbValue[]>(sql, params);
    }
  };

  return client;
}

export const db = createClient(pool);

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
