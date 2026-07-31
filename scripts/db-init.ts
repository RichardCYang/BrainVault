import "dotenv/config";
import mariadb, { type Pool } from "mariadb";
import {
  databaseOptionsWithSchema,
  databaseOptionsWithoutSchema,
  parseDatabaseUrl,
  quoteIdentifier,
  quoteString
} from "../src/lib/database-url.js";

async function closePool(pool: Pool | undefined) {
  if (pool) {
    await pool.end().catch(() => undefined);
  }
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL must be configured");
  const databaseUserHosts = (process.env.DB_USER_HOSTS ?? "localhost,127.0.0.1,::1")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean);
  if (!databaseUserHosts.length || databaseUserHosts.some((host) => host.includes("%") || host.includes("_"))) {
    throw new Error("DB_USER_HOSTS must contain exact MariaDB account hosts without wildcards");
  }
  const target = parseDatabaseUrl(databaseUrl, { requireDatabase: true });
  const admin = parseDatabaseUrl(process.env.MARIADB_ADMIN_URL ?? databaseUrl, { requireDatabase: false });
  const usingAdminUrl = Boolean(process.env.MARIADB_ADMIN_URL);

  let adminPool: Pool | undefined;
  let targetPool: Pool | undefined;

  try {
    adminPool = mariadb.createPool({
      ...databaseOptionsWithoutSchema(admin),
      connectionLimit: 1
    });
    await adminPool.query(
      `CREATE DATABASE IF NOT EXISTS ${quoteIdentifier(target.database!)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    console.log(`Database ready: ${target.database}`);

    if (usingAdminUrl) {
      for (const accountHost of databaseUserHosts) {
        const account = `${quoteString(target.user)}@${quoteString(accountHost)}`;
        await adminPool.query(
          `CREATE USER IF NOT EXISTS ${account} IDENTIFIED BY ${quoteString(target.password)}`
        );
        await adminPool.query(
          `ALTER USER ${account} IDENTIFIED BY ${quoteString(target.password)}`
        );
        await adminPool.query(
          `GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES ` +
          `ON ${quoteIdentifier(target.database!)}.* TO ${account}`
        );
      }
      await adminPool.query(`DROP USER IF EXISTS ${quoteString(target.user)}@'%'`);
      console.log(`User ready on exact hosts: ${databaseUserHosts.join(", ")}`);
    } else {
      console.log("MARIADB_ADMIN_URL is not set. Skipped user creation/grants and used DATABASE_URL credentials.");
    }

    targetPool = mariadb.createPool({
      ...databaseOptionsWithSchema(target),
      connectionLimit: 1
    });
    await targetPool.query("SELECT 1 AS ok");
    console.log("Connection check passed.");
  } catch (error) {
    console.error("MariaDB initialization failed.");
    console.error("Make sure a MariaDB server is running and DATABASE_URL points to it.");
    console.error("If the database/user does not exist yet, set MARIADB_ADMIN_URL to an admin account and rerun npm run db:init.");
    throw error;
  } finally {
    await closePool(targetPool);
    await closePool(adminPool);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
