import {
  createIconPickerOperationGuard,
  getIconPickerTargetKey
} from "../public/icon-picker-operation.js";

function deferred() {
  let resolve;
  const promise = new Promise((next) => { resolve = next; });
  return { promise, resolve };
}

const pageOneTarget = { type: "page", pageId: "page-one" };
const pageTwoTarget = { type: "page", pageId: "page-two" };
const pageOneKey = getIconPickerTargetKey(pageOneTarget);
const pageTwoKey = getIconPickerTargetKey(pageTwoTarget);

// Vulnerable flow: the file read starts for page one, but saveEmojiSelection()
// reads the mutable global picker target only after FileReader resolves.
let vulnerableCurrentTarget = pageOneTarget;
const vulnerableRead = deferred();
const vulnerableApply = (async () => {
  await vulnerableRead.promise;
  return getIconPickerTargetKey(vulnerableCurrentTarget);
})();
vulnerableCurrentTarget = pageTwoTarget;
vulnerableRead.resolve();
const vulnerableCrossPageWriteTarget = await vulnerableApply;

// Corrected flow: the read owns a generation plus the originating target key.
let fixedCurrentTarget = pageOneTarget;
const crossPageGuard = createIconPickerOperationGuard();
const scopedRead = crossPageGuard.begin(pageOneKey);
const fixedRead = deferred();
const fixedApply = (async () => {
  await fixedRead.promise;
  return crossPageGuard.isCurrent(scopedRead, getIconPickerTargetKey(fixedCurrentTarget));
})();
fixedCurrentTarget = pageTwoTarget;
crossPageGuard.invalidate(); // closing/opening the picker invalidates prior intent
fixedRead.resolve();
const fixedCrossPageWriteAccepted = await fixedApply;

// Two files can also finish out of order while the same picker remains open.
const replacementGuard = createIconPickerOperationGuard();
const firstRead = replacementGuard.begin(pageOneKey);
const secondRead = replacementGuard.begin(pageOneKey);
const vulnerableSupersededReadAccepted = true;
const fixedSupersededReadAccepted = replacementGuard.isCurrent(firstRead, pageOneKey);
const fixedLatestReadAccepted = replacementGuard.isCurrent(secondRead, pageOneKey);

// A save response that arrives after the old picker was closed must update the
// saved page model, but it must not close or focus a newly opened picker.
const completionGuard = createIconPickerOperationGuard();
const oldSave = completionGuard.begin(pageOneKey);
completionGuard.invalidate();
const fixedClosedPickerCompletionCanCloseReplacementPicker = completionGuard.isCurrent(oldSave, pageOneKey);

console.log(JSON.stringify({
  scenario: "custom icon FileReader completion after picker replacement",
  vulnerable: {
    originatingReadTarget: pageOneKey,
    crossPageWriteTarget: vulnerableCrossPageWriteTarget,
    supersededReadAccepted: vulnerableSupersededReadAccepted
  },
  fixed: {
    crossPageWriteAccepted: fixedCrossPageWriteAccepted,
    supersededReadAccepted: fixedSupersededReadAccepted,
    latestReadAccepted: fixedLatestReadAccepted,
    closedPickerCompletionCanCloseReplacementPicker: fixedClosedPickerCompletionCanCloseReplacementPicker
  }
}, null, 2));
