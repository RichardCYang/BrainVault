import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { bootstrapDatabase } from "./lib/db-bootstrap.js";
import { closeDb } from "./lib/db.js";
import { recoverInterruptedDataRestores } from "./lib/data-transfer.js";

async function start() {
  if (env.AUTO_BOOTSTRAP_DATABASE) {
    const result = await bootstrapDatabase();
    const applied = result.schema.applied.length ? result.schema.applied.join(", ") : "none";
    console.log(
      `MariaDB ready: database=${result.database}, baselineReconciled=${result.schema.baselineReconciled}, migrationsApplied=${applied}`
    );
  } else {
    console.log("AUTO_BOOTSTRAP_DATABASE=false. Skipping database/schema bootstrap.");
  }

  await recoverInterruptedDataRestores();

  const app = createApp();
  const appUrl = `http://localhost:${env.PORT}`;
  const server = app.listen(env.PORT, () => {
    console.log(`BrainVault API listening on ${appUrl}`);

    if (env.AUTO_BOOTSTRAP_DATABASE && process.env.BRAINVAULT_DEV_BROWSER_READY_SIGNAL === "1") {
      console.log(`BRAINVAULT_DEV_BROWSER_READY=${appUrl}`);
    }
  });

  function shutdown(signal: string) {
    console.log(`${signal} received. Closing BrainVault API...`);
    server.close(() => {
      closeDb()
        .catch((error) => console.error("Failed to close MariaDB pool", error))
        .finally(() => process.exit(0));
    });
  }

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

start().catch(async (error) => {
  console.error("Failed to start BrainVault API.");
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
