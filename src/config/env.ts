import "dotenv/config";
import { z } from "zod";

const defaultJwtSecret = "brainvault-local-development-secret-change-me-32chars";

const booleanString = z
  .enum(["true", "false", "1", "0", "yes", "no", "on", "off"])
  .default("true")
  .transform((value) => ["true", "1", "yes", "on"].includes(value));

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4000),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("mariadb://brainvault:brainvault_password@localhost:3306/brainvault"),
  MARIADB_ADMIN_URL: z.string().min(1).optional(),
  AUTO_BOOTSTRAP_DATABASE: booleanString,
  DATABASE_CONNECTION_LIMIT: z.coerce.number().int().min(1).max(50).default(10),
  JWT_SECRET: z.string().min(32, "JWT_SECRET must be at least 32 characters long").default(defaultJwtSecret),
  JWT_EXPIRES_IN: z.string().default("7d"),
  CORS_ORIGIN: z.string().default("http://localhost:4000,http://127.0.0.1:4000,http://localhost:3000,http://localhost:5173,http://127.0.0.1:5173"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(120),
  BOOKMARK_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(8_000),
  BOOKMARK_FETCH_MAX_BYTES: z.coerce.number().int().min(64 * 1024).max(768 * 1024).default(512 * 1024),
  ATTACHMENT_UPLOAD_DIR: z.string().min(1).default("uploads"),
  MAX_ATTACHMENT_SIZE_MB: z.coerce.number().int().min(1).max(500).default(25)
});

export const env = envSchema.parse(process.env);

if (env.NODE_ENV === "production" && env.JWT_SECRET === defaultJwtSecret) {
  throw new Error("JWT_SECRET must be changed before running BrainVault in production");
}

export const corsOrigins = env.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
