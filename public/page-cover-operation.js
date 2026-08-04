export function createPageCoverOperationGuard() {
  let generation = 0;

  return Object.freeze({
    begin(pageId) {
      generation += 1;
      return Object.freeze({ generation, pageId });
    },
    invalidate() {
      generation += 1;
    },
    isCurrent(operation, pageId) {
      return Boolean(
        operation
          && operation.generation === generation
          && operation.pageId === pageId
      );
    }
  });
}
