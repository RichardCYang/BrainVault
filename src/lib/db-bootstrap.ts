import mariadb, { type Pool } from "mariadb";
import { databaseUserHosts, env } from "../config/env.js";
import {
  databaseOptionsWithSchema,
  databaseOptionsWithoutSchema,
  parseDatabaseUrl,
  quoteIdentifier,
  quoteString
} from "./database-url.js";
import { ensureSchema } from "./schema.js";

async function closePool(pool: Pool | undefined) {
  if (pool) {
    await pool.end().catch(() => undefined);
  }
}

async function ensureDatabase() {
  const target = parseDatabaseUrl(env.DATABASE_URL, { requireDatabase: true });
  const bootstrap = parseDatabaseUrl(env.MARIADB_ADMIN_URL ?? env.DATABASE_URL, { requireDatabase: false });
  const usingAdminUrl = Boolean(env.MARIADB_ADMIN_URL);

  let bootstrapPool: Pool | undefined;
  let targetPool: Pool | undefined;

  try {
    bootstrapPool = mariadb.createPool({
      ...databaseOptionsWithoutSchema(bootstrap),
      connectionLimit: 1
    });

    await bootstrapPool.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(target.database!)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );

    if (usingAdminUrl) {
      for (const accountHost of databaseUserHosts) {
        const account = `${quoteString(target.user)}@${quoteString(accountHost)}`;
        await bootstrapPool.query(
          `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quoteString(target.password)}`
        );
        await bootstrapPool.query(
          `ALTER USER ${account} IDENTIFIED BY ${quoteString(target.password)}`
        );
        await bootstrapPool.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ` +
          `ON ${quoteIdentifier(target.database!)}.* TO ${account}`
        );
      }
      await bootstrapPool.query(
        `DROP USER IF EXISTS ${quoteString(target.user)}@'%'`
      );
    }

    targetPool = mariadb.createPool({
      ...databaseOptionsWithSchema(target),
      connectionLimit: 1
    });
    await targetPool.query("SELECT 1 AS ok");

    return {
      database: target.database!,
      createdUserOrGrants: usingAdminUrl
    };
  } finally {
    await closePool(targetPool);
    await closePool(bootstrapPool);
  }
}

export async function bootstrapDatabase() {
  const database = await ensureDatabase();
  const schema = await ensureSchema();

  return {
    ...database,
    schema
  };
}
