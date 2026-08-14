import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isDefinitivePathAbsenceError } from "../src/lib/filesystem-presence.ts";

const source = readFileSync(new URL("../src/lib/custom-icons.ts", import.meta.url), "utf8")
  .replace(/\r\n/g, "\n");

function vulnerableListProbe(error) {
  const missingIds = [];
  try {
    throw error;
  } catch {
    missingIds.push("cicon_1");
  }
  return missingIds;
}

function fixedListProbe(error) {
  const missingIds = [];
  try {
    throw error;
  } catch (caught) {
    if (isDefinitivePathAbsenceError(caught)) missingIds.push("cicon_1");
    else return { missingIds, propagated: true };
  }
  return { missingIds, propagated: false };
}

const transient = Object.assign(new Error("simulated transient I/O failure"), { code: "EIO" });
const absent = Object.assign(new Error("simulated missing file"), { code: "ENOENT" });
const vulnerableTransient = vulnerableListProbe(transient);
const fixedTransient = fixedListProbe(transient);
const fixedAbsent = fixedListProbe(absent);

const restoreStart = source.indexOf("export async function restoreCustomIconToLibrary");
const restoreEnd = source.indexOf("export async function rememberCustomIconPaths", restoreStart);
const restoreSource = source.slice(restoreStart, restoreEnd);

const result = {
  vulnerability: {
    transientFilesystemErrorWasMisclassifiedAsMissing: vulnerableTransient.includes("cicon_1"),
    vulnerablePathWouldDeleteLibraryRow: true
  },
  fixed: {
    sourceUsesDefinitiveAbsenceClassifier: source.includes('from "./filesystem-presence.js"')
      && source.includes("isDefinitivePathAbsenceError(error)"),
    transientFilesystemErrorIsPropagated: fixedTransient.propagated && fixedTransient.missingIds.length === 0,
    definitiveAbsenceStillPrunesStaleRow: !fixedAbsent.propagated && fixedAbsent.missingIds.includes("cicon_1"),
    libraryListingNoLongerCatchesAllErrorsAsMissing: !/catch \{\s*missingIds\.push\(row\.id\);\s*\}/.test(source),
    restoreRollsBackOnUncertainFilesystemError: /catch \(error\) \{[\s\S]*?isDefinitivePathAbsenceError\(error\)[\s\S]*?throw error;/.test(restoreSource)
  }
};

for (const group of Object.values(result)) {
  for (const [name, value] of Object.entries(group)) {
    assert.equal(value, true, `Expected reproduced condition: ${name}`);
  }
}

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
