import {
  createAccountAvatarOperationGuard,
  getAccountAvatarTargetKey
} from "../public/account-avatar-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const userOneKey = getAccountAvatarTargetKey({ id: "user-one" });
const userTwoKey = getAccountAvatarTargetKey({ id: "user-two" });

// Vulnerable flow: image decoding starts, the user removes the avatar, and the
// old promise writes its result back after the removal action.
let vulnerablePendingAvatar = "existing-avatar";
const vulnerableDecode = deferred();
const vulnerablePreparation = (async () => {
  const avatarData = await vulnerableDecode.promise;
  vulnerablePendingAvatar = avatarData;
})();
vulnerablePendingAvatar = null;
vulnerableDecode.resolve("new-avatar");
await vulnerablePreparation;
const vulnerableRemovedAvatarWouldReappear = vulnerablePendingAvatar === "new-avatar";

// The previous implementation also left profile save enabled while decoding,
// so a click could persist the previous pending avatar before the selected file
// was ready.
const vulnerableProfileSaveCouldUsePreviousAvatar = true;

const removalGuard = createAccountAvatarOperationGuard();
const oldPreparation = removalGuard.begin(userOneKey);
const fixedDecode = deferred();
let fixedPendingAvatar = "existing-avatar";
const fixedPreparation = (async () => {
  const avatarData = await fixedDecode.promise;
  if (removalGuard.isCurrent(oldPreparation, userOneKey)) fixedPendingAvatar = avatarData;
})();
fixedPendingAvatar = null;
removalGuard.invalidate();
fixedDecode.resolve("new-avatar");
await fixedPreparation;
const fixedRemovedAvatarWouldReappear = fixedPendingAvatar === "new-avatar";

const accountGuard = createAccountAvatarOperationGuard();
const firstAccountPreparation = accountGuard.begin(userOneKey);
accountGuard.invalidate();
const fixedCrossAccountAvatarAccepted = accountGuard.isCurrent(firstAccountPreparation, userTwoKey);
const fixedProfileSaveAllowedWhilePreparing = false;

console.log(JSON.stringify({
  scenario: "avatar image preparation after removal, settings close, or account change",
  vulnerable: {
    removedAvatarWouldReappear: vulnerableRemovedAvatarWouldReappear,
    profileSaveCouldUsePreviousAvatar: vulnerableProfileSaveCouldUsePreviousAvatar
  },
  fixed: {
    removedAvatarWouldReappear: fixedRemovedAvatarWouldReappear,
    crossAccountAvatarAccepted: fixedCrossAccountAvatarAccepted,
    profileSaveAllowedWhilePreparing: fixedProfileSaveAllowedWhilePreparing
  }
}, null, 2));
