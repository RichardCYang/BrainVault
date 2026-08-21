import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  bcryptPasswordMaxBytes,
  getPasswordUtf8ByteLength,
  isPasswordWithinBcryptLimit
} from "../src/lib/password-policy.ts";

const read = async (relativePath) => (
  await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8")
).replace(/\r\n/g, "\n");

test("the password policy enforces bcrypt's UTF-8 byte boundary", () => {
  assert.equal(bcryptPasswordMaxBytes, 72);
  assert.equal(getPasswordUtf8ByteLength("A".repeat(72)), 72);
  assert.equal(isPasswordWithinBcryptLimit("A".repeat(72)), true);
  assert.equal(isPasswordWithinBcryptLimit("A".repeat(73)), false);
  assert.equal(getPasswordUtf8ByteLength("🔐".repeat(18)), 72);
  assert.equal(isPasswordWithinBcryptLimit("🔐".repeat(18)), true);
  assert.equal(getPasswordUtf8ByteLength("🔐".repeat(19)), 76);
  assert.equal(isPasswordWithinBcryptLimit("🔐".repeat(19)), false);
});

test("bcrypt helpers fail closed even if a route schema is omitted", async () => {
  const source = await read("src/lib/auth.ts");

  assert.match(source, /bcrypt\.truncates\(password\)/);
  assert.match(source, /assertPasswordWithinBcryptLimit\(password\)/);
  assert.match(source, /if \(bcryptWouldTruncate\(password\)\) return Promise\.resolve\(false\)/);
});

test("every password-bearing route and seed path shares the byte policy", async () => {
  const schemas = await read("src/utils/schemas.ts");
  const authRoutes = await read("src/routes/auth.routes.ts");
  const mfaRoutes = await read("src/routes/mfa.routes.ts");
  const seed = await read("scripts/seed.ts");

  assert.match(schemas, /export function passwordInputSchema/);
  assert.match(schemas, /refine\(isPasswordWithinBcryptLimit, bcryptPasswordLimitMessage\)/);
  assert.ok((authRoutes.match(/passwordInputSchema\(/g) ?? []).length >= 4);
  assert.ok((mfaRoutes.match(/passwordInputSchema\(/g) ?? []).length >= 2);
  assert.match(seed, /isPasswordWithinBcryptLimit\(password\)/);
});

test("standalone reproduction shows the vulnerable collision and remediated rejection", () => {
  const result = JSON.parse(execFileSync(
    process.execPath,
    [
      "--import=tsx",
      fileURLToPath(new URL("../scripts/reproduce-bcrypt-password-boundary.mjs", import.meta.url))
    ],
    { encoding: "utf8" }
  ));

  assert.equal(result.passwordsDiffer, true);
  assert.equal(result.vulnerableModel.effectiveInputsEqual, true);
  assert.equal(result.vulnerableModel.originalEffectiveInputBytes, 72);
  assert.equal(result.fixedPolicy.originalAccepted, false);
  assert.equal(result.fixedPolicy.changedAccepted, false);
  assert.equal(result.fixedPolicy.exactBoundaryAccepted, true);
  assert.equal(result.fixedPolicy.boundaryPlusOneAccepted, false);
});
