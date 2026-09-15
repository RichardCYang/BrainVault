import { readFileSync } from "node:fs";
import { defaultAppSource, measureEnter } from "../tests/helpers/wan-editing-harness.mjs";

const args = process.argv.slice(2);
function argument(flag, fallback) {
  const index = args.indexOf(flag);
  if (index < 0) return fallback;
  if (args[index + 1] === undefined) throw new Error(`Missing value for ${flag}`);
  return args[index + 1];
}
const latencyMs = Number(argument("--latency-ms", "200"));
if (!Number.isFinite(latencyMs) || latencyMs < 0 || latencyMs > 5000) {
  throw new Error("--latency-ms must be between 0 and 5000");
}
const sourcePath = argument("--source", null);
const source = sourcePath ? readFileSync(sourcePath, "utf8") : defaultAppSource;
const results = [];
for (const dirty of [false, true]) {
  for (const middle of [false, true]) {
    results.push(await measureEnter({ source, latencyMs, dirty, middle }));
  }
}
console.log(JSON.stringify({
  kind: "synthetic-app-function-network-latency-reproduction",
  source: sourcePath ?? "public/app.js",
  caveat: "Runs real app functions with mocked HTTP/browser/storage. Not real WAN, browser DOM/IME, server authorization or MariaDB E2E.",
  results
}, null, 2));
