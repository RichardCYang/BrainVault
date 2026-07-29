import { rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputDirectory = path.join(projectRoot, "dist");

if (path.dirname(outputDirectory) !== projectRoot || path.basename(outputDirectory) !== "dist") {
  throw new Error("Refusing to clean an unexpected build output directory");
}

await rm(outputDirectory, { recursive: true, force: true });
