import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const SECRET_BYTES = 32;
const SECRET_NAMES = ["JWT_SECRET", "MFA_ENCRYPTION_KEY"];
const REPLACEABLE_VALUES = new Set(["", "GENERATED_BY_NPM_RUN_ENV_INIT"]);

function printHelp() {
  console.log(`Generate independent 32-byte (256-bit) secrets for BrainVault.

Usage:
  npm run secrets:generate
  npm run secrets:generate -- --write
  npm run secrets:generate -- --write --force

Options:
  --write  Write the generated values to an existing .env file.
  --force  Replace existing non-placeholder values. Requires --write.
  --help   Show this help.

Without --write, the command only prints copy-ready environment assignments.
Warning: changing MFA_ENCRYPTION_KEY after TOTP enrollment makes existing TOTP secrets unreadable.`);
}

function createSecret() {
  return randomBytes(SECRET_BYTES).toString("base64url");
}

function unquoteEnvValue(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

function generateSecrets() {
  const jwtSecret = createSecret();
  let mfaEncryptionKey = createSecret();
  while (mfaEncryptionKey === jwtSecret) {
    mfaEncryptionKey = createSecret();
  }
  return {
    JWT_SECRET: jwtSecret,
    MFA_ENCRYPTION_KEY: mfaEncryptionKey
  };
}

function formatAssignments(secrets) {
  return SECRET_NAMES.map((name) => `${name}="${secrets[name]}"`).join("\n");
}

function writeSecretsToEnv(envPath, secrets, force) {
  if (!fs.existsSync(envPath)) {
    throw new Error(`.env not found at ${envPath}. Run npm run env:init first.`);
  }

  let contents = fs.readFileSync(envPath, "utf8");
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const assignments = [];

  for (const name of SECRET_NAMES) {
    const pattern = new RegExp(`^([ \\t]*${name}[ \\t]*=)([^\\r\\n]*)$`, "gm");
    const matches = [...contents.matchAll(pattern)];
    if (matches.length > 1) {
      throw new Error(`.env contains more than one ${name} assignment`);
    }

    const existingValue = matches.length === 1 ? unquoteEnvValue(matches[0][2]) : null;
    if (!force && existingValue !== null && !REPLACEABLE_VALUES.has(existingValue)) {
      assignments.push(name);
    }
  }

  if (assignments.length) {
    throw new Error(
      `Refusing to overwrite existing secrets without --force: ${assignments.join(", ")}. ` +
        "Rotating MFA_ENCRYPTION_KEY can invalidate enrolled TOTP authenticators."
    );
  }

  for (const name of SECRET_NAMES) {
    const pattern = new RegExp(`^([ \\t]*${name}[ \\t]*=)([^\\r\\n]*)$`, "gm");
    if (pattern.test(contents)) {
      pattern.lastIndex = 0;
      contents = contents.replace(pattern, `$1"${secrets[name]}"`);
    } else {
      if (contents.length && !contents.endsWith("\n")) {
        contents += newline;
      }
      contents += `${name}="${secrets[name]}"${newline}`;
    }
  }

  fs.writeFileSync(envPath, contents, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(envPath, 0o600);
  } catch {
    // Some platforms do not support POSIX permission bits.
  }
}

function main() {
  const args = new Set(process.argv.slice(2));
  const knownArgs = new Set(["--write", "--force", "--help"]);
  const unknownArgs = [...args].filter((arg) => !knownArgs.has(arg));
  if (unknownArgs.length) {
    throw new Error(`Unknown option(s): ${unknownArgs.join(", ")}`);
  }
  if (args.has("--help")) {
    printHelp();
    return;
  }
  if (args.has("--force") && !args.has("--write")) {
    throw new Error("--force requires --write");
  }

  const secrets = generateSecrets();
  if (args.has("--write")) {
    const envPath = path.join(process.cwd(), ".env");
    writeSecretsToEnv(envPath, secrets, args.has("--force"));
    console.log(`Updated ${envPath} with independent 32-byte JWT and MFA secrets.`);
    return;
  }

  console.log(formatAssignments(secrets));
}

try {
  main();
} catch (error) {
  console.error(`Secret generation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
