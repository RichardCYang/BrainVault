import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function parseCacheControl(value) {
  const directives = new Map();
  for (const item of value.split(",")) {
    const [name, rawValue] = item.trim().toLowerCase().split("=", 2);
    directives.set(name, rawValue ?? true);
  }
  return directives;
}

function assess(cacheControl, ageAtRedeploySeconds) {
  const directives = parseCacheControl(cacheControl);
  const maxAge = Number(directives.get("max-age") ?? 0);
  const requiresRevalidation = directives.has("no-cache") || ageAtRedeploySeconds >= maxAge;
  return {
    cacheControl,
    ageAtRedeploySeconds,
    responseStillFresh: ageAtRedeploySeconds < maxAge,
    immutable: directives.has("immutable"),
    requiresRevalidation,
    staleModuleCanSurviveRedeploy:
      directives.has("immutable") && ageAtRedeploySeconds < maxAge && !requiresRevalidation
  };
}

const source = readFileSync(new URL("../src/app.ts", import.meta.url), "utf8");
const currentPolicy = /const browserModuleCacheControl = "([^"]+)"/.exec(source)?.[1];
assert.ok(currentPolicy, "Unable to read the current browser-module cache policy");

const ageAtRedeploySeconds = 24 * 60 * 60;
const result = {
  scenario: {
    route: "/vendor/yjs/yjs.mjs",
    urlChangesAcrossDeploy: false,
    redeployAfterSeconds: ageAtRedeploySeconds
  },
  vulnerable: assess("public, max-age=31536000, immutable", ageAtRedeploySeconds),
  fixed: assess(currentPolicy, ageAtRedeploySeconds)
};

assert.equal(result.vulnerable.staleModuleCanSurviveRedeploy, true);
assert.equal(result.fixed.staleModuleCanSurviveRedeploy, false);
assert.equal(result.fixed.requiresRevalidation, true);
assert.match(source, /res\.sendFile\(filePath, \{ cacheControl: false \}/);
assert.match(source, /cacheControl: false,[\s\S]*?dotfiles: "deny"/);

console.log(JSON.stringify(result, null, 2));
