import fs from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { parseEnv } from "node:util";

const DEFAULT_DATABASE_URL = "mariadb://brainvault:brainvault_password@127.0.0.1:3306/brainvault";

class PromptOutput extends Writable {
  muted = false;

  _write(chunk, _encoding, callback) {
    if (!this.muted) {
      process.stdout.write(chunk);
    }
    callback();
  }
}

function readFileIfPresent(filePath) {
  return fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : undefined;
}

function readDatabaseUrl(contents) {
  if (!contents) {
    return undefined;
  }

  try {
    return parseEnv(contents).DATABASE_URL;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Unable to parse the environment file: ${reason}`);
  }
}

function updateDatabaseUrl(contents, databaseUrl) {
  const newline = contents.includes("\r\n") ? "\r\n" : "\n";
  const assignment = `DATABASE_URL="${databaseUrl}"`;
  const databaseUrlLine = /^[\t ]*(?:export[\t ]+)?DATABASE_URL[\t ]*=.*$/gm;

  if (contents.match(databaseUrlLine)) {
    return contents.replace(databaseUrlLine, assignment);
  }

  if (contents.length === 0) {
    return `${assignment}${newline}`;
  }

  const separator = contents.endsWith("\n") || contents.endsWith("\r") ? "" : newline;
  return `${contents}${separator}${assignment}${newline}`;
}

async function main() {
  const projectRoot = process.cwd();
  const envPath = path.join(projectRoot, ".env");
  const examplePath = path.join(projectRoot, ".env.example");
  const existingEnv = readFileIfPresent(envPath);
  const exampleEnv = readFileIfPresent(examplePath);
  const baseContents = existingEnv ?? exampleEnv ?? "";
  const rawDatabaseUrl = readDatabaseUrl(existingEnv) ?? readDatabaseUrl(exampleEnv) ?? DEFAULT_DATABASE_URL;
  const databaseUrl = new URL(rawDatabaseUrl);

  if (databaseUrl.protocol !== "mariadb:" && databaseUrl.protocol !== "mysql:") {
    throw new Error("DATABASE_URL must start with mariadb:// or mysql://");
  }

  let username;
  let password;

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    const [rawUsername = "", rawPassword = ""] = fs.readFileSync(0, "utf8").split(/\r?\n/);
    username = rawUsername.trim();
    password = rawPassword;

    if (!username) {
      throw new Error("Database username cannot be empty.");
    }

    console.log("Database credentials read from standard input.");
  } else {
    const promptOutput = new PromptOutput();
    const prompt = createInterface({
      input: process.stdin,
      output: promptOutput,
      terminal: true
    });

    try {
      username = "";
      while (!username) {
        username = (await prompt.question("Database username: ")).trim();
        if (!username) {
          console.log("Database username cannot be empty.");
        }
      }

      process.stdout.write("Database password (hidden): ");
      promptOutput.muted = true;
      try {
        password = await prompt.question("");
      } finally {
        promptOutput.muted = false;
        process.stdout.write("\n");
      }
    } finally {
      prompt.close();
    }
  }

  databaseUrl.username = username;
  databaseUrl.password = password;

  const updatedContents = updateDatabaseUrl(baseContents, databaseUrl.toString());
  fs.writeFileSync(envPath, updatedContents, "utf8");

  const action = existingEnv === undefined ? "Created" : "Updated";
  const databaseName = databaseUrl.pathname.replace(/^\//, "") || "(no database selected)";
  console.log(`${action} ${path.relative(projectRoot, envPath) || ".env"}.`);
  console.log(
    `DATABASE_URL now uses user "${username}" for ${databaseUrl.hostname}:${databaseUrl.port || "3306"}/${databaseName}.`
  );
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
