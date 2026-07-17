import express from "express";
import path from "node:path";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { env } from "./config/env.js";
import { corsOptionsDelegate } from "./middleware/cors.js";
import { authRouter } from "./routes/auth.routes.js";
import { pageRouter } from "./routes/page.routes.js";
import { blockRouter } from "./routes/block.routes.js";
import { searchRouter } from "./routes/search.routes.js";
import { dataRouter } from "./routes/data.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", "data:", "http:", "https:"],
          scriptSrc: ["'self'", "https://cdn.jsdelivr.net"],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
          fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net"]
        }
      }
    })
  );
  app.use(cors(corsOptionsDelegate));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false }));
  app.use(morgan(env.NODE_ENV === "production" ? "combined" : "dev"));
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-8",
      legacyHeaders: false
    })
  );

  const publicDir = path.resolve(process.cwd(), "public");
  const docsDir = path.resolve(process.cwd(), "docs");
  app.use(express.static(publicDir, { index: false }));
  app.use("/docs", express.static(docsDir, { index: false }));

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, name: "BrainVault", version: "1.0.0" });
  });

  app.use("/api/auth", authRouter);
  app.use("/api/pages", pageRouter);
  app.use("/api", blockRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/data", dataRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
