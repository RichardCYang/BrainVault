import express, { type NextFunction, type Request, type Response } from "express";
import path from "node:path";
import { type ServerResponse } from "node:http";
import helmet from "helmet";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";
import { corsOrigins, env } from "./config/env.js";
import { corsOptionsDelegate } from "./middleware/cors.js";
import { authRouter } from "./routes/auth.routes.js";
import { pageRouter } from "./routes/page.routes.js";
import { blockRouter } from "./routes/block.routes.js";
import { searchRouter } from "./routes/search.routes.js";
import { dataRouter } from "./routes/data.routes.js";
import { collaborationRouter } from "./routes/collaboration.routes.js";
import { customIconRouter } from "./routes/custom-icon.routes.js";
import { errorHandler, notFoundHandler } from "./middleware/error.js";
import { requireAuth } from "./middleware/auth.js";
import { createHttpsEnforcementMiddleware } from "./middleware/https.js";
import { enforcePermanentTotpIpBlock } from "./middleware/totp-ip-block.js";
import { setPrivateNoStoreCacheControl } from "./lib/cache-control.js";
import { createExpressTrustProxySetting } from "./lib/reverse-proxy.js";
import { customIconUploadRoot } from "./lib/custom-icons.js";
import {
  developmentAccessLogFormat,
  productionAccessLogFormat,
  stripUrlQueryAndFragment
} from "./lib/access-log.js";

const trustProxySetting = env.HTTPS_MODE === "proxy"
  ? createExpressTrustProxySetting(env.TRUST_PROXY_HOPS, env.TRUST_PROXY_ADDRESSES)
  : false;

const configuredWebSocketOrigins = corsOrigins.map((origin) => {
  const parsed = new URL(origin);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  return parsed.origin;
});

morgan.token("safe-url", (req) => {
  const request = req as Request;
  return stripUrlQueryAndFragment(request.originalUrl ?? request.url, "/");
});
morgan.token("safe-referrer", (req) => {
  const referrer = req.headers.referer ?? req.headers.referrer;
  return stripUrlQueryAndFragment(Array.isArray(referrer) ? referrer[0] : referrer);
});

export function createApp() {
  const app = express();

  app.disable("x-powered-by");
  app.set("trust proxy", trustProxySetting);
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          imgSrc: ["'self'", "data:", "http:", "https:"],
          scriptSrc: [
            "'self'",
            "'sha256-AQrGHmNf2ToDPODxkNyXldxWl9tWr2pnwbahY0pFneE='",
            "https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.js"
          ],
          styleSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/katex.min.css"],
          fontSrc: ["'self'", "data:", "https://cdn.jsdelivr.net/npm/katex@0.17.0/dist/fonts/"],
          connectSrc: ["'self'", ...configuredWebSocketOrigins],
          frameSrc: ["'self'", "https://www.youtube-nocookie.com", "https://www.youtube.com"]
        }
      }
    })
  );
  app.use(enforcePermanentTotpIpBlock);
  app.use(
    createHttpsEnforcementMiddleware({
      enabled: env.HTTPS_MODE !== "off",
      publicOrigin: env.PUBLIC_ORIGIN,
      redirect: env.HTTPS_REDIRECT,
      healthcheckBypass: env.HTTPS_HEALTHCHECK_BYPASS,
      trustedProxyAddresses: env.HTTPS_MODE === "proxy" ? env.TRUST_PROXY_ADDRESSES : []
    })
  );
  app.use(cors(corsOptionsDelegate));
  app.use(morgan(env.NODE_ENV === "production" ? productionAccessLogFormat : developmentAccessLogFormat));
  app.use(
    rateLimit({
      windowMs: env.RATE_LIMIT_WINDOW_MS,
      limit: env.RATE_LIMIT_MAX,
      standardHeaders: "draft-8",
      legacyHeaders: false
    })
  );
  // Passwordless WebAuthn assertions have a deliberately small, bounded JSON
  // contract. Parse this anonymous endpoint with a tighter limit before the
  // broader application parser so chunked requests cannot bypass the bound.
  app.use("/api/auth/passkey", express.json({ limit: "64kb" }));
  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: false }));

  const publicDir = path.resolve(process.cwd(), "public");
  const docsDir = path.resolve(process.cwd(), "docs");
  const browserModuleRoot = path.resolve(process.cwd(), "node_modules");
  // These module URLs are stable across deployments, so they must revalidate.
  // Long-lived immutable caching is safe only when the URL itself is versioned.
  const browserModuleCacheControl = "public, max-age=0, must-revalidate";

  function setBrowserModuleHeaders(res: ServerResponse) {
    res.setHeader("Cache-Control", browserModuleCacheControl);
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }

  function sendBrowserModule(res: Response, next: NextFunction, filePath: string) {
    setBrowserModuleHeaders(res);
    res.sendFile(filePath, { cacheControl: false }, (error) => {
      if (error) next(error);
    });
  }

  app.get("/vendor/yjs/yjs.mjs", (_req, res, next) => {
    sendBrowserModule(res, next, path.join(browserModuleRoot, "yjs", "dist", "yjs.mjs"));
  });
  app.get("/vendor/yjs/isomorphic/browser.mjs", (_req, res, next) => {
    sendBrowserModule(res, next, path.join(browserModuleRoot, "isomorphic.js", "browser.mjs"));
  });
  app.use(
    "/vendor/yjs/lib0",
    (req, res, next) => {
      const extension = path.posix.extname(req.path);
      if (extension && extension !== ".js") {
        res.sendStatus(404);
        return;
      }
      next();
    },
    express.static(path.join(browserModuleRoot, "lib0"), {
      cacheControl: false,
      dotfiles: "deny",
      extensions: ["js"],
      index: false,
      redirect: false,
      setHeaders: setBrowserModuleHeaders
    })
  );
  app.use(
    "/upload/icons",
    express.static(customIconUploadRoot, {
      dotfiles: "deny",
      index: false,
      redirect: false,
      setHeaders(res) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");
      }
    })
  );
  app.use(express.static(publicDir, { index: false }));
  if (env.SERVE_INTERNAL_DOCS) {
    app.use(
      "/docs",
      requireAuth,
      express.static(docsDir, {
        cacheControl: false,
        etag: false,
        index: false,
        lastModified: false,
        setHeaders: setPrivateNoStoreCacheControl
      })
    );
  }

  app.get("/", (_req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  app.use("/api/auth", authRouter);
  app.use("/api", collaborationRouter);
  app.use("/api/pages", pageRouter);
  app.use("/api", blockRouter);
  app.use("/api/search", searchRouter);
  app.use("/api/data", dataRouter);
  app.use("/api/custom-icons", customIconRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
