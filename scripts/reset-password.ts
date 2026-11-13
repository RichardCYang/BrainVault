import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import { hashPassword, normalizeAuthVersion } from "../src/lib/auth.js";
import { closeDb, transaction } from "../src/lib/db.js";
import { passwordInputSchema } from "../src/utils/schemas.js";

// Run only from a trusted operator shell after verifying the account holder
// through an independent channel. This is deliberately not an unauthenticated
// API: a self-hosted server has no mail channel to prove who is asking.
//
// The password is read from the terminal (hidden, asked twice) or from the
// first line of piped stdin, never from argv, so it stays out of shell history
// and process listings.

async function readHiddenLine(prompt: string): Promise<string> {
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding as BufferEncoding);
      callback();
    }
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    return await new Promise<string>((resolve) => {
      rl.question(prompt, (answer) => {
        process.stdout.write("\n");
        resolve(answer);
      });
      muted = true;
    });
  } finally {
    rl.close();
  }
}

async function readPipedLine(): Promise<string> {
  const rl = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of rl) return line;
    return "";
  } finally {
    rl.close();
  }
}

async function readNewPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();
  const first = await readHiddenLine("New password: ");
  const second = await readHiddenLine("Repeat new password: ");
  if (first !== second) throw new Error("The passwords did not match. Nothing was changed.");
  return first;
}

async function main() {
  const [username, ...extra] = process.argv.slice(2);
  if (!username?.trim() || extra.length) {
    throw new Error("Usage: npm run password:reset -- <username>");
  }

  const password = await readNewPassword();
  const parsed = passwordInputSchema(8).safeParse(password);
  if (!parsed.success) {
    throw new Error("The password must be at least 8 characters and at most 72 bytes. Nothing was changed.");
  }
  const passwordHash = await hashPassword(parsed.data);

  await transaction(async (client) => {
    const user = await client.queryOne<{ id: string; auth_version: unknown }>(
      "SELECT id, auth_version FROM users WHERE username = ? FOR UPDATE",
      [username.trim()]
    );
    if (!user) throw new Error("No account uses that ID. Nothing was changed.");

    // Same boundary as an in-app password change: every existing session and
    // enrolled authenticator stops working, and the failure lockout is cleared
    // so the person can sign in straight away.
    const authVersion = normalizeAuthVersion(user.auth_version) + 1;
    const result = await client.execute<{ affectedRows: number }>(
      `UPDATE users
          SET password_hash = ?, auth_version = ?,
              failed_login_attempts = 0, last_failed_login_at = NULL, login_locked_until = NULL
        WHERE id = ?`,
      [passwordHash, authVersion, user.id]
    );
    if (Number(result.affectedRows) !== 1) throw new Error("The password reset did not complete.");
    await client.execute("DELETE FROM mfa_login_sessions WHERE user_id = ?", [user.id]);
    await client.execute("DELETE FROM webauthn_challenges WHERE user_id = ?", [user.id]);
    await client.execute("DELETE FROM mfa_totp_setups WHERE user_id = ?", [user.id]);
    await client.execute("DELETE FROM mfa_step_up_sessions WHERE user_id = ?", [user.id]);
    await client.execute("DELETE FROM user_passkeys WHERE user_id = ?", [user.id]);
    await client.execute("DELETE FROM user_totp_credentials WHERE user_id = ?", [user.id]);
  });

  console.log(
    "Password reset. Existing sessions were signed out, the sign-in lockout was cleared, "
    + "and passkeys and authenticator apps were removed; the person can enroll them again after signing in."
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Password reset failed");
  process.exitCode = 1;
}).finally(() => closeDb());
