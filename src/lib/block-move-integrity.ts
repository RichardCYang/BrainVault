export function areEquivalentPersistedValues(left: unknown, right: unknown) {
  if (left instanceof Date || right instanceof Date) {
    if (!(left instanceof Date) || !(right instanceof Date)) return false;
    const leftTime = left.getTime();
    const rightTime = right.getTime();
    return Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime === rightTime;
  }
  return left === right;
}
