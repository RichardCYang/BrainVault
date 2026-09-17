import { closeDb, transaction } from "../src/lib/db.js";

// Run only from a trusted operator shell after verifying the applicant through
// an independent channel. This is deliberately not an unauthenticated API.
async function main() {
  const [username, ...extra] = process.argv.slice(2);
  if (!username?.trim() || extra.length) {
    throw new Error("Usage: npm run registration:approve -- <username>");
  }
  const changed = await transaction(async (client) => {
    const user = await client.queryOne<{ id: string; registration_approved: number }>(
      "SELECT id, registration_approved FROM users WHERE username = ? FOR UPDATE",
      [username.trim()]
    );
    if (!user) throw new Error("Registration request not found");
    if (Number(user.registration_approved) === 1) return false;
    const result = await client.execute<{ affectedRows: number }>(
      "UPDATE users SET registration_approved = 1 WHERE id = ? AND registration_approved = 0",
      [user.id]
    );
    if (Number(result.affectedRows) !== 1) throw new Error("Registration approval did not complete");
    return true;
  });
  console.log(changed ? "Registration approved." : "The account is already approved.");
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Registration approval failed");
  process.exitCode = 1;
}).finally(() => closeDb());
