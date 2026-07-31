import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const scriptPath = join(rootDir, "scripts", "generate-secrets.mjs");
const assignmentPattern = /^(JWT_SECRET|MFA_ENCRYPTION_KEY)="([A-Za-z0-9_-]+)"$/gm;

function run(args, cwd = rootDir) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8"
  });
}

function parseAssignments(contents) {
  const values = new Map();
  for (const match of contents.matchAll(assignmentPattern)) {
    values.set(match[1], match[2]);
  }
  return values;
}

function assertValidSecretPair(values) {
  assert.equal(values.size, 2);
  const jwtSecret = values.get("JWT_SECRET");
  const mfaEncryptionKey = values.get("MFA_ENCRYPTION_KEY");
  assert.equal(Buffer.from(jwtSecret, "base64url").length, 32);
  assert.equal(Buffer.from(mfaEncryptionKey, "base64url").length, 32);
  assert.notEqual(jwtSecret, mfaEncryptionKey);
}

test("secret generation prints independent 32-byte base64url values", () => {
  const result = run([]);
  assert.equal(result.status, 0, result.stderr);
  assertValidSecretPair(parseAssignments(result.stdout));
});

test("--write fills placeholder values and protects existing secrets", () => {
  const workDir = mkdtempSync(join(tmpdir(), "brainvault-secret-test-"));
  const envPath = join(workDir, ".env");
  try {
    writeFileSync(
      envPath,
      'JWT_SECRET="GENERATED_BY_NPM_RUN_ENV_INIT"\nMFA_ENCRYPTION_KEY="GENERATED_BY_NPM_RUN_ENV_INIT"\nOTHER_VALUE="keep-me"\n',
      "utf8"
    );

    const first = run(["--write"], workDir);
    assert.equal(first.status, 0, first.stderr);
    const firstContents = readFileSync(envPath, "utf8");
    const firstValues = parseAssignments(firstContents);
    assertValidSecretPair(firstValues);
    assert.match(firstContents, /^OTHER_VALUE="keep-me"$/m);

    const protectedRun = run(["--write"], workDir);
    assert.notEqual(protectedRun.status, 0);
    assert.match(protectedRun.stderr, /Refusing to overwrite existing secrets without --force/);
    assert.equal(readFileSync(envPath, "utf8"), firstContents);

    const forcedRun = run(["--write", "--force"], workDir);
    assert.equal(forcedRun.status, 0, forcedRun.stderr);
    const forcedValues = parseAssignments(readFileSync(envPath, "utf8"));
    assertValidSecretPair(forcedValues);
    assert.notEqual(forcedValues.get("JWT_SECRET"), firstValues.get("JWT_SECRET"));
    assert.notEqual(forcedValues.get("MFA_ENCRYPTION_KEY"), firstValues.get("MFA_ENCRYPTION_KEY"));
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
