import { createAccountProfileMutationQueue } from "../public/account-profile-mutation-queue.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

function createVulnerableQueue({ getCurrentTargetKey }) {
  let tail = Promise.resolve();
  let generation = 0;

  return {
    enqueue(targetKey, operation) {
      const queuedGeneration = generation;
      const run = async () => {
        if (queuedGeneration !== generation || getCurrentTargetKey() !== targetKey) {
          return { applied: false };
        }

        const value = await operation();
        if (queuedGeneration !== generation || getCurrentTargetKey() !== targetKey) {
          return { applied: false };
        }
        return { applied: true, value };
      };

      const pending = tail.then(run, run);
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
    invalidate() {
      generation += 1;
    }
  };
}

async function exercise(createQueue) {
  const oldTargetKey = "user:user-one";
  const newTargetKey = "user:user-two";
  let currentTargetKey = oldTargetKey;
  const oldGate = deferred();
  let newAccountStarted = false;
  const queue = createQueue({ getCurrentTargetKey: () => currentTargetKey });

  const oldMutation = queue.enqueue(oldTargetKey, async () => {
    await oldGate.promise;
    return "old-account-result";
  });

  await Promise.resolve();
  currentTargetKey = newTargetKey;
  queue.invalidate();

  const newMutation = queue.enqueue(newTargetKey, async () => {
    newAccountStarted = true;
    return "new-account-result";
  });

  await Promise.resolve();
  await Promise.resolve();
  const newAccountStartedBeforeOldRelease = newAccountStarted;

  oldGate.resolve();
  const [oldResult, newResult] = await Promise.all([oldMutation, newMutation]);

  return {
    newAccountStartedBeforeOldRelease,
    newAccountBlockedByOldGeneration: !newAccountStartedBeforeOldRelease,
    oldResult,
    newResult
  };
}

const vulnerable = await exercise(createVulnerableQueue);
const fixed = await exercise(createAccountProfileMutationQueue);

console.log(JSON.stringify({
  scenario: "an unresolved account-A profile mutation followed by authentication reset and an account-B profile mutation",
  vulnerable,
  fixed
}, null, 2));
