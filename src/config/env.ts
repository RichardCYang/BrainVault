import "dotenv/config";
import { randomBytes } from "node:crypto";
import { z } from "zod";

const knownInsecureSecrets = new Set(
  [
    "brainvault-local-development-secret-change-me-32chars",
    "brainvault-local-development-mfa-key-change-me-32chars",
    "replace-this-with-a-long-random-secret-before-sharing",
    "replace-this-with-a-separate-long-random-secret",
    "generated-by-npm-run-env-init",
    "generated_by_npm_run_env_init"
  ].map((value) => value.toLowerCase())
);

const booleanValue = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .transform((value) => ["true", "1", "yes", "on"].includes(value));
const enabledByDefault = booleanValue.default("true");
const disabledByDefault = booleanValue.default("false");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().trim().min(1).max(255).default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("mariadb://brainvault:brainvault_password@localhost:3306/brainvault"),
  MARIADB_ADMIN_URL: z.string().min(1).optional(),
  AUTO_BOOTSTRAP_DATABASE: enabledByDefault,
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters long").optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  MFA_ENCRYPTION_KEY: z.string().min(32, "MFA_ENCRYPTION_KEY must be at least 32 characters long").optional(),
  WEBAUTHN_RP_NAME: z.string().trim().min(1).max(100).default("BrainVault"),
  WEBAUTHN_RP_ID: z.string().trim().min(1).default("localhost"),
  WEBAUTHN_ORIGIN: z.string().trim().min(1).default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:4000,http://127.0.0.1:4000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"),
  REGISTRATION_ENABLED: booleanValue.optional(),
  SERVE_INTERNAL_DOCS: disabledByDefault,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_LOGIN_IP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_LOGIN_IP_MAX: z.coerce.number().int().positive().default(20),
  AUTH_LOGIN_ACCOUNT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_LOGIN_ACCOUNT_MAX: z.coerce.number().int().positive().default(30),
  AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  BOOKMARK_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  BOOKMARK_FETCH_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(768 * 1024).default(512 * 1024),
  ATTACHMENT_UPLOAD_DIR: z.string().min(1).default("uploads"),
  MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).max(500).default(25),
  DATA_TRANSFER_MAX_SIZE_MB: z.coerce.number().int().min(1).max(102_400).default(4096)
});

const parsedEnv = envSchema.parse(process.env);

function generateEphemeralSecret() {
  return randomBytes(48).toString("base64url");
}

function assertSecretIsNotKnown(name: string, value: string) {
  if (knownInsecureSecrets.has(value.trim().toLowerCase())) {
    throw new Error(`${name} uses a public placeholder or legacy development value`);
  }
}

if (parsedEnv.NODE_ENV === "production" && !parsedEnv.JWT_SECRET) {
  throw new Error("JWT_SECRET must be explicitly configured in production");
}
if (parsedEnv.NODE_ENV === "production" && !parsedEnv.MFA_ENCRYPTION_KEY) {
  throw new Error("MFA_ENCRYPTION_KEY must be explicitly configured in production");
}

const jwtSecret = parsedEnv.JWT_SECRET ?? generateEphemeralSecret();
const mfaEncryptionKey = parsedEnv.MFA_ENCRYPTION_KEY ?? generateEphemeralSecret();
assertSecretIsNotKnown("JWT_SECRET", jwtSecret);
assertSecretIsNotKnown("MFA_ENCRYPTION_KEY", mfaEncryptionKey);
if (jwtSecret === mfaEncryptionKey) {
  throw new Error("JWT_SECRET and MFA_ENCRYPTION_KEY must be different values");
}

export const env = {
  ...parsedEnv,
  JWT_SECRET: jwtSecret,
  MFA_ENCRYPTION_KEY: mfaEncryptionKey,
  REGISTRATION_ENABLED: parsedEnv.REGISTRATION_ENABLED ?? parsedEnv.NODE_ENV !== "production"
};

const webAuthnOrigins = env.WEBAUTHN_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (!webAuthnOrigins.length) {
  throw new Error("WEBAUTHN_ORIGIN must include at least one browser origin");
}

for (const origin of webAuthnOrigins) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`WEBAUTHN_ORIGIN contains an invalid origin: ${origin}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`WEBAUTHN_ORIGIN must contain exact HTTP(S) origins without paths: ${origin}`);
  }
  if (parsed.hostname !== env.WEBAUTHN_RP_ID && !parsed.hostname.endsWith(`.${env.WEBAUTHN_RP_ID}`)) {
    throw new Error(`WEBAUTHN_RP_ID must match or be a registrable suffix of ${parsed.hostname}`);
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("WEBAUTHN_ORIGIN must use HTTPS in production");
  }
}

export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim().replace(/\/$/, ""))
  .filter(Boolean);

if (!corsOrigins.length) {
  throw new Error("CORS_ORIGIN must include at least one browser origin");
}

for (const origin of corsOrigins) {
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`CORS_ORIGIN contains an invalid origin: ${origin}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
    throw new Error(`CORS_ORIGIN must contain exact HTTP(S) origins without paths: ${origin}`);
  }
  if (env.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("CORS_ORIGIN must use HTTPS in production");
  }
}
