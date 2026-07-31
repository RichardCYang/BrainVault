import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");
const examplePath = path.join(projectRoot, ".env.example");
const generatedPlaceholder = "GENERATED_BY_NPM_RUN_ENV_INIT";

if (!fs.existsSync(examplePath)) {
  throw new Error(".env.example not found");
}

if (fs.existsSync(envPath)) {
  console.log(".env already exists. No changes made.");
  process.exit(0);
}

const createSecret = () => randomBytes(48).toString("base64url");
let contents = fs.readFileSync(examplePath, "utf8");
const placeholderPattern = new RegExp(generatedPlaceholder, "g");
const placeholderCount = contents.match(placeholderPattern)?.length ?? 0;
if (placeholderCount !== 2) {
  throw new Error(".env.example must contain exactly two generated-secret placeholders");
}

contents = contents.replace(generatedPlaceholder, createSecret()).replace(generatedPlaceholder, createSecret());
fs.writeFileSync(envPath, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
try {
  fs.chmodSync(envPath, 0o600);
} catch {
  // Some platforms do not support POSIX permission bits.
}

console.log("Created .env with unique JWT and MFA secrets.");
console.log("Review DATABASE_URL, browser origins, and production settings before deployment.");
