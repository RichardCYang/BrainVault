import { createHash } from "node:crypto";
import { env } from "../config/env.js";
import { createDedicatedDbConnection } from "./db.js";
import { parseDatabaseUrl } from "./database-url.js";

const applicationInstanceLeaseHeartbeatMs = 15_000;

export type ApplicationInstanceLease = {
  lockName: string;
  release(): Promise<void>;
};

type ApplicationInstanceLeaseOptions = {
  onLeaseLost(error: unknown): void;
};

function applicationInstanceLockName() {
  const database = parseDatabaseUrl(env.DATABASE_URL, { requireDatabase: true }).database!;
  const databaseId = createHash("sha256").update(database, "utf8").digest("hex").slice(0, 32);
  return `brainvault.active-instance.${databaseId}`;
}

export async function acquireApplicationInstanceLease(
  options: ApplicationInstanceLeaseOptions
): Promise<ApplicationInstanceLease> {
  const connection = await createDedicatedDbConnection();
  const lockName = applicationInstanceLockName();
  let acquired = false;

  try {
    const rows = await connection.query("SELECT GET_LOCK(?, 0) AS acquired", [lockName]);
    acquired = Number(rows[0]?.acquired) === 1;
    if (!acquired) {
      throw new Error(
        "Another BrainVault application instance is already active for this MariaDB database. " +
        "BrainVault currently requires a single active application process because collaboration fan-out, " +
        "rate limits, and resource-admission gates are process-local."
      );
    }

    let released = false;
    let leaseLost = false;
    let heartbeatInFlight = false;
    const heartbeat = setInterval(() => {
      if (released || leaseLost || heartbeatInFlight) return;
      heartbeatInFlight = true;
      void connection.query("SELECT 1 AS application_instance_lease_heartbeat")
        .catch((error) => {
          if (released || leaseLost) return;
          leaseLost = true;
          clearInterval(heartbeat);
          options.onLeaseLost(error);
        })
        .finally(() => {
          heartbeatInFlight = false;
        });
    }, applicationInstanceLeaseHeartbeatMs);
    heartbeat.unref();

    return {
      lockName,
      async release() {
        if (released) return;
        released = true;
        clearInterval(heartbeat);
        try {
          await connection.query("SELECT RELEASE_LOCK(?) AS released", [lockName]);
        } finally {
          await connection.end();
        }
      }
    };
  } catch (error) {
    if (acquired) {
      await connection.query("SELECT RELEASE_LOCK(?) AS released", [lockName]).catch(() => undefined);
    }
    await connection.end().catch(() => undefined);
    throw error;
  }
}
