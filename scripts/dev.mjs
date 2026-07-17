import { spawn } from "node:child_process";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { createServerOutputInspector, openPrivateDefaultBrowser } from "./dev-browser.mjs";

const inspectServerOutput = createServerOutputInspector((url) => {
  void launchPrivateBrowser(url);
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

async function launchPrivateBrowser(url) {
  try {
    await openPrivateDefaultBrowser(url);
    console.log(`[dev] Opened the default browser in private mode: ${url}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.error(`[dev] Could not open the default browser in private mode: ${reason}`);
    console.error(
      "[dev] Automatic private-mode launch supports Chrome, Edge, Firefox, and Brave. A normal browser window was not opened."
    );
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
