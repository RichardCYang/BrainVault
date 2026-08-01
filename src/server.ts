import { createServer } from "node:http";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { bootstrapDatabase } from "./lib/db-bootstrap.js";
import { closeDb } from "./lib/db.js";
import { recoverInterruptedDataRestores } from "./lib/data-transfer.js";
import { attachPageCollaborationServer } from "./lib/collaboration-server.js";
import { createExpressTrustProxySetting, describeExpressTrustProxySetting } from "./lib/reverse-proxy.js";

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
  const displayHost = env.HOST === "0.0.0.0" || env.HOST === "::" ? "localhost" : env.HOST;
  const appUrl = `http://${displayHost}:${env.PORT}`;
  const trustProxySetting = createExpressTrustProxySetting(env.TRUST_PROXY_HOPS, env.TRUST_PROXY_ADDRESSES);
  const server = createServer(app);
  const collaborationHub = attachPageCollaborationServer(server);
  server.listen(env.PORT, env.HOST, () => {
    console.log(`BrainVault API listening internally on ${appUrl}`);
    if (env.HTTPS_MODE === "proxy") {
      console.log(
        `HTTPS reverse-proxy mode enabled: public=${env.PUBLIC_ORIGIN}, trustProxy=${describeExpressTrustProxySetting(trustProxySetting)}, redirect=${env.HTTPS_REDIRECT}`
      );
    }

    if (env.AUTO_BOOTSTRAP_DATABASE && process.env.BRAINVAULT_DEV_BROWSER_READY_SIGNAL === "1") {
      console.log(`BRAINVAULT_DEV_BROWSER_READY=${appUrl}`);
    }
  });

  let isShuttingDown = false;
  async function shutdown(signal: string) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`${signal} received. Closing BrainVault API...`);

    await collaborationHub.close().catch((error) => {
      console.error("Failed to close collaboration server", error);
    });
    await new Promise<void>((resolve) => {
      server.close((error) => {
        if (error) console.error("Failed to close HTTP server", error);
        resolve();
      });
    });
    await closeDb().catch((error) => console.error("Failed to close MariaDB pool", error));
    process.exit(0);
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

start().catch(async (error) => {
  console.error("Failed to start BrainVault API.");
  console.error(error);
  await closeDb().catch(() => undefined);
  process.exitCode = 1;
});
