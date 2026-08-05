export function getAccountAvatarTargetKey(user) {
  return typeof user?.id === "string" && user.id ? `user:${user.id}` : null;
}

export function createAccountAvatarOperationGuard() {
  let generation = 0;

  return Object.freeze({
    begin(targetKey) {
      generation += 1;
      return Object.freeze({ generation, targetKey });
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(operation, targetKey) {
      return Boolean(
        operation
          && operation.generation === generation
          && operation.targetKey !== null
          && operation.targetKey === targetKey
      );
    }
  });
}
