export function getIconPickerTargetKey(target) {
  if (!target || typeof target !== "object") return null;
  if (target.type === "defaultCollection") return "default-collection";
  if (target.type === "page" && typeof target.pageId === "string" && target.pageId) {
    return `page:${target.pageId}`;
  }
  return null;
}

export function createIconPickerOperationGuard() {
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
