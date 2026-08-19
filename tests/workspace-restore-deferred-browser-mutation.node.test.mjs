import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("browser mutations retain the workspace generation from the user state that created them", async () => {
  const [app, middleware, mappers] = await Promise.all([
    read("public/app.js"),
    read("src/middleware/auth.ts"),
    read("src/lib/mappers.ts")
  ]);

  assert.match(mappers, /"attachment_generation"/);
  assert.match(mappers, /workspaceGeneration/);

  const captureStart = app.indexOf("function getUserWorkspaceGeneration");
  const apiStart = app.indexOf("async function api(path, options = {})");
  assert.ok(captureStart >= 0 && apiStart > captureStart);
  const scopeSource = app.slice(captureStart, apiStart);
  assert.match(scopeSource, /workspaceGeneration: getUserWorkspaceGeneration\(state\.user\)/);
  assert.match(
    scopeSource,
    /scope\.workspaceGeneration === getUserWorkspaceGeneration\(state\.user\)/
  );

  const apiEnd = app.indexOf("async function enqueueAccountProfilePatch", apiStart);
  const apiSource = app.slice(apiStart, apiEnd);
  const scopeCapture = apiSource.indexOf("const authenticationScope = captureAuthenticatedSessionScope()");
  const generationHeader = apiSource.indexOf('"X-BrainVault-Workspace-Generation"', scopeCapture);
  const fetchDispatch = apiSource.indexOf("await fetch(path", generationHeader);
  assert.ok(
    scopeCapture >= 0 && generationHeader > scopeCapture && fetchDispatch > generationHeader,
    "the originating workspace generation must be attached before request dispatch"
  );

  assert.match(middleware, /req\.header\("x-brainvault-workspace-generation"\)/);
  const currentGeneration = middleware.indexOf(
    "const workspaceGeneration = Number(user.attachment_generation ?? 1)"
  );
  const clientGeneration = middleware.indexOf(
    "const clientWorkspaceGeneration = getClientWorkspaceGeneration(req)",
    currentGeneration
  );
  const scopeAssignment = middleware.indexOf(
    "req.auth.workspaceGeneration = clientWorkspaceGeneration",
    clientGeneration
  );
  assert.ok(
    currentGeneration >= 0 && clientGeneration > currentGeneration && scopeAssignment > clientGeneration,
    "middleware must preserve the client generation in the durable auth scope"
  );
});

test("race model rejects a deferred pre-restore mutation without blocking same-generation writes", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-workspace-restore-deferred-browser-mutation.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.deepEqual(result.vulnerable, {
    intentGeneration: 12,
    admittedGeneration: 13,
    staleIntentAdoptedRestoredGeneration: true,
    mutationCommitted: true
  });
  assert.deepEqual(result.fixed, {
    intentGeneration: 12,
    admittedGeneration: 12,
    staleIntentAdoptedRestoredGeneration: false,
    mutationCommitted: false,
    rejectedAsWorkspaceRestored: true
  });
  assert.deepEqual(result.sameGeneration, {
    intentGeneration: 13,
    admittedGeneration: 13,
    staleIntentAdoptedRestoredGeneration: false,
    mutationCommitted: true,
    rejectedAsWorkspaceRestored: false
  });
});


test("sanitize-html raw-text advisory precondition stays excluded by the markdown policy", async () => {
  const markdown = await read("src/lib/markdown.ts");
  const allowedTagsStart = markdown.indexOf("const allowedTags =");
  const allowedAttributesStart = markdown.indexOf("const allowedAttributes", allowedTagsStart);
  assert.ok(
    allowedTagsStart >= 0 && allowedAttributesStart > allowedTagsStart,
    "markdown sanitizer must expose an explicit bounded allowedTags policy"
  );
  const allowedTagsSource = markdown.slice(allowedTagsStart, allowedAttributesStart);
  assert.doesNotMatch(
    allowedTagsSource,
    /["'](?:textarea|xmp)["']/i,
    "do not opt raw-text textarea/xmp tags into sanitize-html without a dependency/security review"
  );
});
