import assert from "node:assert/strict";

const older = 9_007_199_254_740_992n;
const newer = 9_007_199_254_740_993n;
const vulnerableOlder = Number(older);
const vulnerableNewer = Number(newer);

function fixedAcceptsVersion(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && BigInt(numeric) === value;
}

const result = {
  vulnerable: {
    older: vulnerableOlder,
    newer: vulnerableNewer,
    compareEqual: vulnerableOlder === vulnerableNewer
  },
  fixed: {
    olderAccepted: fixedAcceptsVersion(older),
    newerAccepted: fixedAcceptsVersion(newer)
  }
};

assert.equal(result.vulnerable.compareEqual, true);
assert.equal(result.fixed.olderAccepted, false);
assert.equal(result.fixed.newerAccepted, false);
console.log(JSON.stringify(result, null, 2));
