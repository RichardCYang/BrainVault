export function createAccountProfileMutationQueue({ getCurrentTargetKey }) {
  if (typeof getCurrentTargetKey !== "function") {
    throw new TypeError("getCurrentTargetKey must be a function");
  }

  let tail = Promise.resolve();
  let generation = 0;

  return Object.freeze({
    enqueue(targetKey, operation) {
      if (typeof operation !== "function") {
        throw new TypeError("operation must be a function");
      }

      const queuedGeneration = generation;
      const run = async () => {
        if (
          !targetKey
          || queuedGeneration !== generation
          || getCurrentTargetKey() !== targetKey
        ) {
          return Object.freeze({ applied: false });
        }

        let value;
        try {
          value = await operation();
        } catch (error) {
          if (
            queuedGeneration !== generation
            || getCurrentTargetKey() !== targetKey
          ) {
            return Object.freeze({ applied: false });
          }
          throw error;
        }

        if (
          queuedGeneration !== generation
          || getCurrentTargetKey() !== targetKey
        ) {
          return Object.freeze({ applied: false });
        }
        return Object.freeze({ applied: true, value });
      };

      const pending = tail.then(run, run);
      tail = pending.then(() => undefined, () => undefined);
      return pending;
    },
    invalidate() {
      generation += 1;
    }
  });
}
