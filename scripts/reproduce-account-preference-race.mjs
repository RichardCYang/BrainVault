import { createAccountProfileMutationQueue } from "../public/account-profile-mutation-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const vulnerableDarkGate = deferred();
const vulnerableLightGate = deferred();
let vulnerableTheme = "light";

const vulnerableDark = (async () => {
  await vulnerableDarkGate.promise;
  vulnerableTheme = "dark";
})();
const vulnerableLight = (async () => {
  await vulnerableLightGate.promise;
  vulnerableTheme = "light";
})();

// The latest user choice (light) reaches the server first. The older dark
// request then finishes later and incorrectly becomes the durable value.
vulnerableLightGate.resolve();
await vulnerableLight;
vulnerableDarkGate.resolve();
await vulnerableDark;

const targetKey = "user:user-one";
const fixedDarkGate = deferred();
const fixedLightGate = deferred();
let fixedTheme = "light";
let firstCompleted = false;
let laterWriteStartedBeforeEarlierCompleted = false;
const queue = createAccountProfileMutationQueue({ getCurrentTargetKey: () => targetKey });

const fixedDark = queue.enqueue(targetKey, async () => {
  await fixedDarkGate.promise;
  fixedTheme = "dark";
  firstCompleted = true;
});
const fixedLight = queue.enqueue(targetKey, async () => {
  if (!firstCompleted) laterWriteStartedBeforeEarlierCompleted = true;
  await fixedLightGate.promise;
  fixedTheme = "light";
});

// Resolve the later operation first to reproduce hostile network timing. It
// cannot start until the earlier operation has completed.
fixedLightGate.resolve();
await Promise.resolve();
fixedDarkGate.resolve();
await fixedDark;
await fixedLight;

console.log(JSON.stringify({
  scenario: "rapid dark then light profile preference changes with reversed network completion",
  vulnerable: {
    intendedTheme: "light",
    finalTheme: vulnerableTheme,
    latestSelectionLost: vulnerableTheme !== "light"
  },
  fixed: {
    intendedTheme: "light",
    finalTheme: fixedTheme,
    latestSelectionPreserved: fixedTheme === "light",
    laterWriteStartedBeforeEarlierCompleted
  }
}, null, 2));
