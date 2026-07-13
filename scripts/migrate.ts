import { closeDb } from "../src/lib/db.js";
import { ensureSchema } from "../src/lib/schema.js";

async function main() {
  const result = await ensureSchema();

  for (const file of result.skipped) {
    console.log(`Already applied: ${file}`);
  }

  for (const file of result.applied) {
    console.log(`Applied: ${file}`);
  }

  if (result.baselineReconciled) {
    console.log("Baseline schema reconciled.");
  }

  console.log("MariaDB database is up to date.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeDb();
  });
