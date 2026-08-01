import "dotenv/config";
import { randomBytes } from "node:crypto";
import net from "node:net";
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

const knownInsecureDatabasePasswords = new Set(
  ["brainvault_password", "generated_database_password", "password", "change-me", "changeme"].map(
    (value) => value.toLowerCase()
  )
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
  DATABASE_URL: z.string().trim().min(1, "DATABASE_URL must be configured"),
  MARIADB_ADMIN_URL: z.string().trim().min(1).optional(),
  DB_USER_HOSTS: z.string().trim().min(1).default("localhost,127.0.0.1,::1"),
  AUTO_BOOTSTRAP_DATABASE: enabledByDefault,
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters long").optional(),
  JWT_EXPIRES_IN: z.string().default("7d"),
  MFA_ENCRYPTION_KEY: z.string().min(32, "MFA_ENCRYPTION_KEY must be at least 32 characters long").optional(),
  WEBAUTHN_RP_NAME: z.string().trim().min(1).max(100).default("BrainVault"),
  WEBAUTHN_RP_ID: z.string().trim().min(1).default("localhost"),
  WEBAUTHN_ORIGIN: z.string().trim().min(1).default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:4000,http://127.0.0.1:4000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"),
  PUBLIC_ORIGIN: z.string().trim().min(1).optional(),
  HTTPS_MODE: z.enum(["off", "proxy"]).default("off"),
  HTTPS_REDIRECT: booleanValue.optional(),
  HTTPS_HEALTHCHECK_BYPASS: enabledByDefault,
  REGISTRATION_ENABLED: booleanValue.optional(),
  SERVE_INTERNAL_DOCS: disabledByDefault,
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  AUTH_LOGIN_IP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_LOGIN_IP_MAX: z.coerce.number().int().positive().default(20),
  AUTH_LOGIN_ACCOUNT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_LOGIN_ACCOUNT_MAX: z.coerce.number().int().positive().default(30),
  AUTH_MFA_IP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_MFA_IP_MAX: z.coerce.number().int().positive().default(15),
  AUTH_MFA_ACCOUNT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_MFA_ACCOUNT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_MFA_SETUP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_MFA_SETUP_MAX: z.coerce.number().int().positive().default(10),
  AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  BOOKMARK_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  BOOKMARK_FETCH_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(768 * 1024).default(512 * 1024),
  ATTACHMENT_UPLOAD_DIR: z.string().min(1).default("uploads"),
  MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).max(500).default(25),
  DATA_TRANSFER_MAX_SIZE_MB: z.coerce.number().int().min(1).max(102_400).default(4096),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  TRUST_PROXY_ADDRESSES: z.string().trim().max(2_048).default("")
});

const inputEnv: NodeJS.ProcessEnv = { ...process.env };
if (!inputEnv.DATABASE_URL && inputEnv.NODE_ENV === "test") {
  inputEnv.DATABASE_URL = "mariadb://brainvault:test-only-password@127.0.0.1:3306/brainvault_test";
}
const parsedEnv = envSchema.parse(inputEnv);

function generateEphemeralSecret() {
  return randomBytes(48).toString("base64url");
}

function assertSecretIsNotKnown(name: string, value: string) {
  if (knownInsecureSecrets.has(value.trim().toLowerCase())) {
    throw new Error(`${name} uses a public placeholder or legacy development value`);
  }
}

function assertDatabasePasswordIsSecure(databaseUrl: string) {
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error("DATABASE_URL must be a valid MariaDB URL");
  }

  const password = decodeURIComponent(parsed.password).trim();
  if (!password) {
    throw new Error("DATABASE_URL must include a non-empty database password");
  }
  if (knownInsecureDatabasePasswords.has(password.toLowerCase())) {
    throw new Error("DATABASE_URL uses a public placeholder or known default database password");
  }
}

function parseExactHttpOrigins(name: "WEBAUTHN_ORIGIN" | "CORS_ORIGIN", value: string) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim().replace(/\/$/, ""))
    .filter(Boolean);

  if (!origins.length) {
    throw new Error(`${name} must include at least one browser origin`);
  }

  for (const origin of origins) {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`${name} contains an invalid origin: ${origin}`);
    }
    if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== origin) {
      throw new Error(`${name} must contain exact HTTP(S) origins without paths: ${origin}`);
    }
    if (parsedEnv.NODE_ENV === "production" && parsed.protocol !== "https:") {
      throw new Error(`${name} must use HTTPS in production`);
    }
  }

  return origins;
}

function parsePublicOrigin(value: string) {
  const normalized = value.trim().replace(/\/$/, "");
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`PUBLIC_ORIGIN contains an invalid origin: ${value}`);
  }
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.origin !== normalized) {
    throw new Error("PUBLIC_ORIGIN must be one exact HTTP(S) origin without a path");
  }
  return normalized;
}

const trustedProxyAddressGroups = new Set(["loopback", "linklocal", "uniquelocal"]);

function assertTrustedProxyAddress(value: string) {
  if (trustedProxyAddressGroups.has(value.toLowerCase())) return;

  const slashIndex = value.lastIndexOf("/");
  const address = slashIndex === -1 ? value : value.slice(0, slashIndex);
  const family = net.isIP(address);
  if (family !== 4 && family !== 6) {
    throw new Error(`TRUST_PROXY_ADDRESSES contains an invalid IP, CIDR, or named range: ${value}`);
  }
  if (slashIndex === -1) return;

  const prefixText = value.slice(slashIndex + 1);
  const prefix = Number(prefixText);
  const maxPrefix = family === 4 ? 32 : 128;
  if (!/^\d+$/.test(prefixText) || !Number.isInteger(prefix) || prefix < 0 || prefix > maxPrefix) {
    throw new Error(`TRUST_PROXY_ADDRESSES contains an invalid CIDR prefix: ${value}`);
  }
}

assertDatabasePasswordIsSecure(parsedEnv.DATABASE_URL);

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

export const webAuthnOrigins = parseExactHttpOrigins("WEBAUTHN_ORIGIN", parsedEnv.WEBAUTHN_ORIGIN);
export const corsOrigins = parseExactHttpOrigins("CORS_ORIGIN", parsedEnv.CORS_ORIGIN);

for (const origin of webAuthnOrigins) {
  const hostname = new URL(origin).hostname;
  if (hostname !== parsedEnv.WEBAUTHN_RP_ID && !hostname.endsWith(`.${parsedEnv.WEBAUTHN_RP_ID}`)) {
    throw new Error(`WEBAUTHN_RP_ID must match or be a registrable suffix of ${hostname}`);
  }
}

const publicOrigin = parsePublicOrigin(parsedEnv.PUBLIC_ORIGIN ?? webAuthnOrigins[0]);
const httpsRedirect = parsedEnv.HTTPS_REDIRECT ?? parsedEnv.HTTPS_MODE === "proxy";
const trustedProxyAddresses = parsedEnv.TRUST_PROXY_ADDRESSES
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

for (const address of trustedProxyAddresses) assertTrustedProxyAddress(address);

if (parsedEnv.TRUST_PROXY_HOPS > 0 && trustedProxyAddresses.length > 0) {
  throw new Error("Configure either TRUST_PROXY_HOPS or TRUST_PROXY_ADDRESSES, not both");
}
if (parsedEnv.HTTPS_MODE === "proxy" && parsedEnv.TRUST_PROXY_HOPS === 0 && trustedProxyAddresses.length === 0) {
  throw new Error("HTTPS_MODE=proxy requires TRUST_PROXY_HOPS or TRUST_PROXY_ADDRESSES");
}
if (parsedEnv.HTTPS_MODE === "off" && httpsRedirect) {
  throw new Error("HTTPS_REDIRECT=true requires HTTPS_MODE=proxy");
}
if (parsedEnv.HTTPS_MODE === "proxy" && new URL(publicOrigin).protocol !== "https:") {
  throw new Error("PUBLIC_ORIGIN must use HTTPS when HTTPS_MODE=proxy");
}
if (parsedEnv.HTTPS_MODE === "proxy" && !webAuthnOrigins.includes(publicOrigin)) {
  throw new Error("PUBLIC_ORIGIN must also be listed in WEBAUTHN_ORIGIN when HTTPS_MODE=proxy");
}
if (parsedEnv.HTTPS_MODE === "proxy" && !corsOrigins.includes(publicOrigin)) {
  throw new Error("PUBLIC_ORIGIN must also be listed in CORS_ORIGIN when HTTPS_MODE=proxy");
}

export const env = {
  ...parsedEnv,
  JWT_SECRET: jwtSecret,
  MFA_ENCRYPTION_KEY: mfaEncryptionKey,
  PUBLIC_ORIGIN: publicOrigin,
  HTTPS_REDIRECT: httpsRedirect,
  TRUST_PROXY_ADDRESSES: trustedProxyAddresses,
  REGISTRATION_ENABLED: parsedEnv.REGISTRATION_ENABLED ?? parsedEnv.NODE_ENV !== "production"
};

export const databaseUserHosts = env.DB_USER_HOSTS.split(",")
  .map((host) => host.trim())
  .filter(Boolean);

if (!databaseUserHosts.length) {
  throw new Error("DB_USER_HOSTS must include at least one exact MariaDB account host");
}
for (const host of databaseUserHosts) {
  if (host.length > 255 || host.includes("%") || host.includes("_")) {
    throw new Error(`DB_USER_HOSTS must not contain wildcard hosts: ${host}`);
  }
}
