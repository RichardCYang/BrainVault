import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  createAccountAvatarOperationGuard,
  getAccountAvatarTargetKey
} from "../public/account-avatar-operation.js";

test("account-avatar operations are scoped to the authenticated user", () => {
  assert.equal(getAccountAvatarTargetKey({ id: "user-one" }), "user:user-one");
  assert.equal(getAccountAvatarTargetKey({ id: "" }), null);
  assert.equal(getAccountAvatarTargetKey(null), null);

  const guard = createAccountAvatarOperationGuard();
  const userOne = getAccountAvatarTargetKey({ id: "user-one" });
  const userTwo = getAccountAvatarTargetKey({ id: "user-two" });
  const preparation = guard.begin(userOne);
  assert.equal(guard.isCurrent(preparation, userOne), true);
  assert.equal(guard.isCurrent(preparation, userTwo), false);
  guard.invalidate();
  assert.equal(guard.isCurrent(preparation, userOne), false);
  assert.equal(guard.isCurrent(guard.begin(null), null), false);
});

test("avatar preparation cannot outlive settings, auth identity, or a removal intent", async () => {
  const app = (await readFile(new URL("../public/app.js", import.meta.url), "utf8")).replace(/\r\n/g, "\n");

  const preparationState = app.slice(app.indexOf("function syncAccountProfileControls"), app.indexOf("function getAccountSettingsFocusableElements"));
  assert.match(preparationState, /accountAvatarInput\.disabled = state\.accountAvatarPreparing/);
  assert.match(preparationState, /accountProfileSave\.disabled = state\.accountAvatarPreparing \|\| state\.accountProfileSaving/);

  const openSettings = app.slice(app.indexOf("function openAccountSettings"), app.indexOf("function closeAccountSettings"));
  assert.match(openSettings, /accountAvatarOperationGuard\.invalidate\(\);/);
  assert.match(openSettings, /setAccountAvatarPreparing\(false\);/);

  const closeSettings = app.slice(app.indexOf("function closeAccountSettings"), app.indexOf("function handleAccountSettingsKeydown"));
  assert.match(closeSettings, /accountAvatarOperationGuard\.invalidate\(\);/);

  const avatarChange = app.slice(
    app.indexOf('elements.accountAvatarInput.addEventListener("change"'),
    app.indexOf('elements.accountAvatarRemove.addEventListener("click"')
  );
  assert.match(avatarChange, /const operation = accountAvatarOperationGuard\.begin\(targetKey\);/);
  assert.match(avatarChange, /setAccountAvatarPreparing\(true\);/);
  assert.match(avatarChange, /const avatarData = await createAvatarDataUrl\(file\);/);
  assert.match(avatarChange, /!state\.accountSettingsOpen[\s\S]*?!accountAvatarOperationGuard\.isCurrent/);
  assert.match(avatarChange, /accountAvatarOperationGuard\.isCurrent\(operation, getAccountAvatarTargetKey\(state\.user\)\)[\s\S]*?setAccountAvatarPreparing\(false\)/);

  const avatarRemove = app.slice(
    app.indexOf('elements.accountAvatarRemove.addEventListener("click"'),
    app.indexOf('elements.accountProfileForm.addEventListener("submit"')
  );
  assert.match(avatarRemove, /accountAvatarOperationGuard\.invalidate\(\);/);
  assert.match(avatarRemove, /state\.pendingAvatarData = null;[\s\S]*?setAccountAvatarPreparing\(false\);/);

  const profileSubmit = app.slice(
    app.indexOf('elements.accountProfileForm.addEventListener("submit"'),
    app.indexOf('elements.accountPasswordForm.addEventListener("submit"')
  );
  assert.match(profileSubmit, /if \(state\.accountAvatarPreparing \|\| state\.accountProfileSaving\) return;/);
});

test("standalone reproduction demonstrates stale avatar preparation and premature save", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [fileURLToPath(new URL("../scripts/reproduce-account-avatar-operation-scope.mjs", import.meta.url))],
    { encoding: "utf8" }
  ));

  assert.equal(result.vulnerable.removedAvatarWouldReappear, true);
  assert.equal(result.vulnerable.profileSaveCouldUsePreviousAvatar, true);
  assert.equal(result.fixed.removedAvatarWouldReappear, false);
  assert.equal(result.fixed.crossAccountAvatarAccepted, false);
  assert.equal(result.fixed.profileSaveAllowedWhilePreparing, false);
});
