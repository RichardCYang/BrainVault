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
      // An authentication boundary must also detach the next session from any
      // unresolved work owned by the invalidated generation. Old operations
      // still settle through their captured chain, but new-account writes can
      // start immediately and remain protected by the generation checks above.
      tail = Promise.resolve();
    }
  });
}
