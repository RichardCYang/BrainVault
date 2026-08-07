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
const jwtExpirySchema = z.string().trim().regex(/^\d+[smhd]$/, "JWT_EXPIRES_IN must use s, m, h, or d units")
  .refine((value) => {
    const unitMs = { s: 1_000, m: 60_000, h: 60 * 60_000, d: 24 * 60 * 60_000 } as const;
    const durationMs = Number(value.slice(0, -1)) * unitMs[value.at(-1) as keyof typeof unitMs];
    return Number.isSafeInteger(durationMs) && durationMs >= 5 * 60_000 && durationMs <= 24 * 60 * 60_000;
  }, "JWT_EXPIRES_IN must be between 5 minutes and 24 hours");

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
  JWT_EXPIRES_IN: jwtExpirySchema.default("12h"),
  AUTH_ALLOW_BEARER_TOKENS: booleanValue.optional(),
  MFA_ENCRYPTION_KEY: z.string().min(32, "MFA_ENCRYPTION_KEY must be at least 32 characters long").optional(),
  WEBAUTHN_RP_NAME: z.string().trim().min(1).max(100).default("BrainVault"),
  WEBAUTHN_RP_ID: z.string().trim().min(1).default("localhost"),
  WEBAUTHN_ORIGIN: z.string().trim().min(1).default("http://localhost:4000"),
  CORS_ORIGIN: z.string().default("http://localhost:4000,http://127.0.0.1:4000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"),
  PUBLIC_ORIGIN: z.string().trim().min(1).optional(),
  HTTPS_MODE: z.enum(["off", "proxy", "posh-acme"]).default("off"),
  POSH_ACME_CERT_PATH: z.string().trim().min(1).max(4_096).optional(),
  POSH_ACME_KEY_PATH: z.string().trim().min(1).max(4_096).optional(),
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
  AUTH_LOGIN_LOCK_THRESHOLD: z.coerce.number().int().min(3).max(50).default(8),
  AUTH_LOGIN_LOCK_BASE_MS: z.coerce.number().int().min(1_000).max(60 * 60_000).default(30_000),
  AUTH_LOGIN_LOCK_MAX_MS: z.coerce.number().int().min(1_000).max(24 * 60 * 60_000).default(15 * 60_000),
  AUTH_LOGIN_FAILURE_RESET_MS: z.coerce.number().int().min(60_000).max(7 * 24 * 60 * 60_000).default(60 * 60_000),
  AUTH_MFA_IP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_MFA_IP_MAX: z.coerce.number().int().positive().default(15),
  AUTH_MFA_ACCOUNT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_MFA_ACCOUNT_MAX: z.coerce.number().int().positive().default(20),
  AUTH_MFA_SETUP_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60_000),
  AUTH_MFA_SETUP_MAX: z.coerce.number().int().positive().default(10),
  MFA_TOTP_WINDOW_STEPS: z.coerce.number().int().min(0).max(1).default(0),
  AUTH_REGISTER_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  AUTH_REGISTER_MAX: z.coerce.number().int().positive().default(5),
  AUTH_REGISTER_GLOBAL_MAX: z.coerce.number().int().positive().default(20),
  BOOKMARK_PREVIEW_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  BOOKMARK_PREVIEW_MAX: z.coerce.number().int().positive().default(12),
  BOOKMARK_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  BOOKMARK_FETCH_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(768 * 1024).default(512 * 1024),
  BOOKMARK_FETCH_ALLOWED_PORTS: z.string().trim().min(1).default("80,443"),
  ATTACHMENT_UPLOAD_DIR: z.string().min(1).default("uploads"),
  ATTACHMENT_TEMP_MAX_AGE_MS: z.coerce.number().int().min(60_000).max(30 * 24 * 60 * 60_000).default(24 * 60 * 60_000),
  MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).max(500).default(25),
  ATTACHMENT_STORAGE_MAX_MB: z.coerce.number().int().min(1).max(1_048_576).default(2048),
  DATA_TRANSFER_MAX_SIZE_MB: z.coerce.number().int().min(1).max(16_384).default(1024),
  DATA_TRANSFER_MAX_MANIFEST_SIZE_MB: z.coerce.number().int().min(1).max(64).default(16),
  DATA_EXPORT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  DATA_EXPORT_MAX: z.coerce.number().int().positive().default(20),
  DATA_IMPORT_WINDOW_MS: z.coerce.number().int().positive().default(60 * 60_000),
  DATA_IMPORT_MAX: z.coerce.number().int().min(1).max(100).default(3),
  DATA_IMPORT_MAX_CONCURRENT: z.coerce.number().int().min(1).max(32).default(2),
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(10).default(0),
  TRUST_PROXY_ADDRESSES: z.string().trim().max(2_048).default("")
});

const inputEnv: NodeJS.ProcessEnv = { ...process.env };
if (!inputEnv.DATABASE_URL && inputEnv.NODE_ENV === "test") {
  inputEnv.DATABASE_URL = "mariadb://brainvault:test-only-password@127.0.0.1:3306/brainvault_test";
}
const parsedEnv = envSchema.parse(inputEnv);
if (parsedEnv.ATTACHMENT_STORAGE_MAX_MB < parsedEnv.MAX_ATTACHMENT_SIZE_MB) {
  throw new Error("ATTACHMENT_STORAGE_MAX_MB must be at least MAX_ATTACHMENT_SIZE_MB");
}

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
  if (parsedEnv.NODE_ENV === "production" && parsed.protocol !== "https:") {
    throw new Error("PUBLIC_ORIGIN must use HTTPS in production");
  }
  return normalized;
}

function parseBookmarkFetchAllowedPorts(value: string) {
  const ports = value.split(",").map((item) => item.trim()).filter(Boolean).map(Number);
  if (!ports.length || ports.some((port) => !Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("BOOKMARK_FETCH_ALLOWED_PORTS must be a comma-separated list of ports from 1 to 65535");
  }
  return [...new Set(ports)];
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
  if (prefix === 0) {
    throw new Error(`TRUST_PROXY_ADDRESSES must not trust every address: ${value}`);
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
const bookmarkFetchAllowedPorts = parseBookmarkFetchAllowedPorts(parsedEnv.BOOKMARK_FETCH_ALLOWED_PORTS);
const httpsRedirect = parsedEnv.HTTPS_REDIRECT ?? parsedEnv.HTTPS_MODE === "proxy";
const secureHttpsMode = parsedEnv.HTTPS_MODE !== "off";
const trustedProxyAddresses = parsedEnv.TRUST_PROXY_ADDRESSES
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

for (const address of trustedProxyAddresses) assertTrustedProxyAddress(address);

if (parsedEnv.TRUST_PROXY_HOPS !== 0) {
  throw new Error("TRUST_PROXY_HOPS must remain 0; configure TRUST_PROXY_ADDRESSES with exact proxy peers");
}
if (parsedEnv.NODE_ENV === "production" && parsedEnv.HTTPS_MODE === "off") {
  throw new Error("HTTPS_MODE must be proxy or posh-acme in production");
}
if (parsedEnv.HTTPS_MODE === "proxy" && trustedProxyAddresses.length === 0) {
  throw new Error("HTTPS_MODE=proxy requires TRUST_PROXY_ADDRESSES");
}
if (parsedEnv.HTTPS_MODE !== "proxy" && httpsRedirect) {
  throw new Error("HTTPS_REDIRECT=true requires HTTPS_MODE=proxy");
}
if (secureHttpsMode && new URL(publicOrigin).protocol !== "https:") {
  throw new Error("PUBLIC_ORIGIN must use HTTPS when HTTPS_MODE is proxy or posh-acme");
}
if (secureHttpsMode && !webAuthnOrigins.includes(publicOrigin)) {
  throw new Error("PUBLIC_ORIGIN must also be listed in WEBAUTHN_ORIGIN when HTTPS is enabled");
}
if (secureHttpsMode && !corsOrigins.includes(publicOrigin)) {
  throw new Error("PUBLIC_ORIGIN must also be listed in CORS_ORIGIN when HTTPS is enabled");
}
if (parsedEnv.HTTPS_MODE === "posh-acme" && !parsedEnv.POSH_ACME_CERT_PATH) {
  throw new Error("HTTPS_MODE=posh-acme requires POSH_ACME_CERT_PATH");
}

export const env = {
  ...parsedEnv,
  JWT_SECRET: jwtSecret,
  MFA_ENCRYPTION_KEY: mfaEncryptionKey,
  PUBLIC_ORIGIN: publicOrigin,
  BOOKMARK_FETCH_ALLOWED_PORTS: bookmarkFetchAllowedPorts,
  HTTPS_REDIRECT: httpsRedirect,
  TRUST_PROXY_ADDRESSES: trustedProxyAddresses,
  AUTH_ALLOW_BEARER_TOKENS: parsedEnv.AUTH_ALLOW_BEARER_TOKENS ?? parsedEnv.NODE_ENV !== "production",
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
