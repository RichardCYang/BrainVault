import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { bootstrapDatabase } from "./lib/db-bootstrap.js";
import { closeDb } from "./lib/db.js";

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

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    console.log(`BrainVault API listening on http://localhost:${env.PORT}`);
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
