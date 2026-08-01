import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { createApp } from "./app.js";
import { env } from "./config/env.js";
import { bootstrapDatabase } from "./lib/db-bootstrap.js";
import { closeDb } from "./lib/db.js";
import { recoverInterruptedDataRestores } from "./lib/data-transfer.js";
import { attachPageCollaborationServer } from "./lib/collaboration-server.js";
import { loadPoshAcmeTls } from "./lib/posh-acme-https.js";
import { createExpressTrustProxySetting, describeExpressTrustProxySetting } from "./lib/reverse-proxy.js";

async function start() {
  const poshAcmeTls = env.HTTPS_MODE === "posh-acme"
    ? await loadPoshAcmeTls(env.POSH_ACME_CERT_PATH!, env.PUBLIC_ORIGIN, env.POSH_ACME_KEY_PATH)
    : null;

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
  const displayUrlHost = displayHost.includes(":") ? `[${displayHost}]` : displayHost;
  const listenerProtocol = poshAcmeTls ? "https" : "http";
  const listenerUrl = `${listenerProtocol}://${displayUrlHost}:${env.PORT}`;
  const browserUrl = poshAcmeTls ? env.PUBLIC_ORIGIN : listenerUrl;
  const trustProxySetting = env.HTTPS_MODE === "proxy"
    ? createExpressTrustProxySetting(env.TRUST_PROXY_HOPS, env.TRUST_PROXY_ADDRESSES)
    : false;
  const server = poshAcmeTls
    ? createHttpsServer(poshAcmeTls.options, app)
    : createHttpServer(app);
  const collaborationHub = attachPageCollaborationServer(server);
  server.listen(env.PORT, env.HOST, () => {
    console.log(`BrainVault API listening on ${listenerUrl}`);
    if (env.HTTPS_MODE === "proxy") {
      console.log(
        `HTTPS reverse-proxy mode enabled: public=${env.PUBLIC_ORIGIN}, trustProxy=${describeExpressTrustProxySetting(trustProxySetting)}, redirect=${env.HTTPS_REDIRECT}`
      );
    } else if (poshAcmeTls) {
      console.log(
        `Posh-ACME HTTPS mode enabled: public=${env.PUBLIC_ORIGIN}, certificate=${poshAcmeTls.files.certificateFile}, subject=${poshAcmeTls.certificateSubject}, expires=${poshAcmeTls.certificateValidTo.toISOString()}`
      );
    }

    if (env.AUTO_BOOTSTRAP_DATABASE && process.env.BRAINVAULT_DEV_BROWSER_READY_SIGNAL === "1") {
      console.log(`BRAINVAULT_DEV_BROWSER_READY=${browserUrl}`);
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
        if (error) console.error("Failed to close BrainVault network server", error);
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
