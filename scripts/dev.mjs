import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import "dotenv/config";
import {
  createServerOutputInspector,
  isPrivateBrowserRequested,
  openDevelopmentBrowser
} from "./dev-browser.mjs";

const privateBrowserRequested = isPrivateBrowserRequested();
const inspectServerOutput = createServerOutputInspector((url) => {
  void launchDevelopmentBrowser(url);
});

const tsxCliPath = fileURLToPath(import.meta.resolve("tsx/cli"));
const serverProcess = spawn(process.execPath, [tsxCliPath, "watch", "src/server.ts"], {
  cwd: process.cwd(),
  env: {
    ...process.env,
    NODE_ENV: "development",
    BRAINVAULT_DEV_BROWSER_READY_SIGNAL: "1"
  },
  stdio: ["inherit", "pipe", "pipe"]
});

async function launchDevelopmentBrowser(url) {
  try {
    const mode = await openDevelopmentBrowser(url, { privateMode: privateBrowserRequested });
    console.log(`[dev] Opened the default browser in ${mode} mode: ${url}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const mode = privateBrowserRequested ? "private" : "normal";
    console.error(`[dev] Could not open the default browser in ${mode} mode: ${reason}`);
    if (privateBrowserRequested) {
      console.error(
        "[dev] Private-mode launch supports Chrome, Edge, Firefox, and Brave. Set BRAINVAULT_DEV_BROWSER_PRIVATE=false to use a durable normal browser profile."
      );
    }
  }
}

serverProcess.stdout.on("data", (chunk) => {
  process.stdout.write(chunk);
  inspectServerOutput(chunk);
});

serverProcess.stderr.pipe(process.stderr);

serverProcess.on("error", (error) => {
  console.error("[dev] Failed to start the TypeScript watch process.");
  console.error(error);
  process.exitCode = 1;
});

serverProcess.on("exit", (code, signal) => {
  if (signal) {
    process.exitCode = 0;
    return;
  }

  process.exitCode = code ?? 1;
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    if (!serverProcess.killed) {
      serverProcess.kill(signal);
    }
  });
}
