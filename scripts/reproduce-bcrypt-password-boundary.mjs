import { Buffer } from "node:buffer";
import {
  bcryptPasswordMaxBytes,
  getPasswordUtf8ByteLength,
  isPasswordWithinBcryptLimit
} from "../src/lib/password-policy.ts";

function bcryptEffectiveInput(password) {
  return Buffer.from(password, "utf8").subarray(0, bcryptPasswordMaxBytes);
}

const sharedPrefix = "A".repeat(bcryptPasswordMaxBytes);
const originalPassword = `${sharedPrefix}-ORIGINAL-SUFFIX`;
const changedPassword = `${sharedPrefix}-CHANGED-SUFFIX`;
const effectiveOriginal = bcryptEffectiveInput(originalPassword);
const effectiveChanged = bcryptEffectiveInput(changedPassword);

const result = {
  passwordsDiffer: originalPassword !== changedPassword,
  originalUtf8Bytes: getPasswordUtf8ByteLength(originalPassword),
  changedUtf8Bytes: getPasswordUtf8ByteLength(changedPassword),
  vulnerableModel: {
    effectiveInputsEqual: effectiveOriginal.equals(effectiveChanged),
    originalEffectiveInputBytes: effectiveOriginal.length,
    changedEffectiveInputBytes: effectiveChanged.length
  },
  fixedPolicy: {
    originalAccepted: isPasswordWithinBcryptLimit(originalPassword),
    changedAccepted: isPasswordWithinBcryptLimit(changedPassword),
    exactBoundaryAccepted: isPasswordWithinBcryptLimit(sharedPrefix),
    boundaryPlusOneAccepted: isPasswordWithinBcryptLimit(`${sharedPrefix}B`)
  }
};

console.log(JSON.stringify(result, null, 2));
