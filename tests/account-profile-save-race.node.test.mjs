import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAccountAvatarOperationGuard,
  getAccountAvatarTargetKey,
  isAccountProfileDraftUnchanged
} from "../public/account-avatar-operation.js";

test("profile draft replacement requires the same account and unchanged submitted values", () => {
  const targetKey = getAccountAvatarTargetKey({ id: "user-one" });
  const submitted = { targetKey, name: "Before", avatarData: "avatar-a" };

  assert.equal(isAccountProfileDraftUnchanged(submitted, { ...submitted }), true);
  assert.equal(isAccountProfileDraftUnchanged(submitted, { ...submitted, name: "After" }), false);
  assert.equal(isAccountProfileDraftUnchanged(submitted, { ...submitted, avatarData: "avatar-b" }), false);
  assert.equal(
    isAccountProfileDraftUnchanged(submitted, { ...submitted, targetKey: "user:user-two" }),
    false
  );

  const guard = createAccountAvatarOperationGuard();
  const operation = guard.begin(targetKey);
  assert.equal(guard.isCurrent(operation, targetKey), true);
  assert.equal(guard.isCurrent(operation, "user:user-two"), false);
});

test("profile save response cannot overwrite a newer visible name or avatar draft", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  assert.match(app, /const accountProfileSaveGuard = createAccountAvatarOperationGuard\(\);/);
  assert.match(app, /accountProfileSaving: false/);
  assert.match(app, /accountProfileSave\.disabled = state\.accountAvatarPreparing \|\| state\.accountProfileSaving/);

  const profileSubmit = app.slice(
    app.indexOf('elements.accountProfileForm.addEventListener("submit"'),
    app.indexOf('elements.accountPasswordForm.addEventListener("submit"')
  );
  assert.match(profileSubmit, /if \(state\.accountAvatarPreparing \|\| state\.accountProfileSaving\) return;/);
  assert.match(profileSubmit, /const submittedDraft = Object\.freeze\(/);
  assert.match(profileSubmit, /const operation = accountProfileSaveGuard\.begin\(targetKey\);/);
  assert.match(profileSubmit, /isAccountProfileDraftUnchanged\(submittedDraft, getCurrentDraft\(\)\)/);
  assert.match(profileSubmit, /if \(canReplaceCurrentDraft\(\)\) \{[\s\S]*?fillAccountSettings\(\);/);
  assert.doesNotMatch(profileSubmit, /state\.user = data\.user;\s*fillAccountSettings\(\);/);
});

test("standalone reproduction proves the stale profile response and corrected preservation", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-profile-draft-race.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.newerNameWasOverwritten, true);
  assert.equal(result.vulnerable.newerAvatarWasOverwritten, true);
  assert.equal(result.fixed.newerNamePreserved, true);
  assert.equal(result.fixed.newerAvatarPreserved, true);
  assert.equal(result.fixed.crossAccountDraftMatches, false);
});
