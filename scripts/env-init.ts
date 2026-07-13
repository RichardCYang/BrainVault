import fs from "node:fs";
import path from "node:path";

const projectRoot = process.cwd();
const envPath = path.join(projectRoot, ".env");
const examplePath = path.join(projectRoot, ".env.example");

if (!fs.existsSync(examplePath)) {
  throw new Error(".env.example not found");
}

if (fs.existsSync(envPath)) {
  console.log(".env already exists. No changes made.");
  process.exit(0);
}

fs.copyFileSync(examplePath, envPath);
console.log("Created .env from .env.example.");
console.log("Review DATABASE_URL, JWT_SECRET, and optional MARIADB_ADMIN_URL before production use.");
