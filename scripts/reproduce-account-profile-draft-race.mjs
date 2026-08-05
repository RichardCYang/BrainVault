import {
  createAccountAvatarOperationGuard,
  getAccountAvatarTargetKey,
  isAccountProfileDraftUnchanged
} from "../public/account-avatar-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const userOneKey = getAccountAvatarTargetKey({ id: "user-one" });
const userTwoKey = getAccountAvatarTargetKey({ id: "user-two" });
const submittedDraft = Object.freeze({
  targetKey: userOneKey,
  name: "Before",
  avatarData: "avatar-a"
});

// Vulnerable flow: a profile request captures avatar A, then the user prepares
// avatar B before the older response calls fillAccountSettings().
let vulnerableDraft = { ...submittedDraft };
const vulnerableResponse = deferred();
const vulnerableSave = (async () => {
  const serverUser = await vulnerableResponse.promise;
  vulnerableDraft = {
    targetKey: getAccountAvatarTargetKey(serverUser),
    name: serverUser.name,
    avatarData: serverUser.avatarData
  };
})();
vulnerableDraft = { ...submittedDraft, name: "After", avatarData: "avatar-b" };
vulnerableResponse.resolve({ id: "user-one", name: "Before", avatarData: "avatar-a" });
await vulnerableSave;

// Corrected flow: the response may update authenticated server state, but it
// only replaces the form when the visible draft still matches the submitted snapshot.
const guard = createAccountAvatarOperationGuard();
const operation = guard.begin(userOneKey);
let fixedDraft = { ...submittedDraft, name: "After", avatarData: "avatar-b" };
const fixedResponse = deferred();
const fixedSave = (async () => {
  const serverUser = await fixedResponse.promise;
  const responseTargetKey = getAccountAvatarTargetKey(serverUser);
  if (
    guard.isCurrent(operation, responseTargetKey)
    && isAccountProfileDraftUnchanged(submittedDraft, fixedDraft)
  ) {
    fixedDraft = {
      targetKey: responseTargetKey,
      name: serverUser.name,
      avatarData: serverUser.avatarData
    };
  }
})();
fixedResponse.resolve({ id: "user-one", name: "Before", avatarData: "avatar-a" });
await fixedSave;

console.log(JSON.stringify({
  scenario: "older profile response after a newer visible account draft",
  vulnerable: {
    newerNameWasOverwritten: vulnerableDraft.name !== "After",
    newerAvatarWasOverwritten: vulnerableDraft.avatarData !== "avatar-b"
  },
  fixed: {
    newerNamePreserved: fixedDraft.name === "After",
    newerAvatarPreserved: fixedDraft.avatarData === "avatar-b",
    crossAccountDraftMatches: isAccountProfileDraftUnchanged(
      submittedDraft,
      { ...submittedDraft, targetKey: userTwoKey }
    )
  }
}, null, 2));
