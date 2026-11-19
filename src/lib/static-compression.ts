import type { NextFunction, Request, Response } from "express";
import path from "node:path";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";
import zlib from "node:zlib";

// Public application assets (app.js, i18n.js, styles.css, ...) are several MB
// of text. When BrainVault terminates HTTP itself (HTTPS_MODE=off/posh-acme) or
// sits behind a proxy without compression, every cold load transferred them
// uncompressed. This middleware serves Brotli/gzip variants of the *static,
// public* file set only. API and authenticated responses are never touched, so
// secrets are never compressed alongside attacker-influenced data (BREACH).

const brotliCompress = promisify(zlib.brotliCompress);
const gzipCompress = promisify(zlib.gzip);

const compressibleExtensions = new Set([".js", ".mjs", ".css", ".html", ".svg", ".json", ".txt"]);
const minimumCompressibleBytes = 1024;
const maximumCompressibleBytes = 16 * 1024 * 1024;

type Encoding = "br" | "gzip";

type CacheEntry = {
  size: number;
  mtimeMs: number;
  variants: Map<Encoding, Promise<Buffer>>;
};

export type StaticCompressionOptions = {
  rootDir: string;
  // Exact URL paths of files that existed in rootDir at startup.
  assetPaths: ReadonlySet<string>;
  // Extra URL paths served from a file in rootDir (for example "/" -> index.html).
  aliases?: Readonly<Record<string, string>>;
  // Applied after the express.static-compatible defaults so routes with their
  // own header policy (for example browser modules) keep it when encoded.
  setHeaders?: (res: Response) => void;
};

function compress(encoding: Encoding, data: Buffer) {
  if (encoding === "br") {
    return brotliCompress(data, {
      params: {
        // Quality 9 keeps the one-time cost per file well under a second while
        // capturing nearly all of the size win of the much slower quality 11.
        [zlib.constants.BROTLI_PARAM_QUALITY]: 9,
        [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT,
        [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length
      }
    });
  }
  return gzipCompress(data, { level: 9 });
}

function weakEtag(size: number, mtimeMs: number, encoding: Encoding) {
  // Mirrors the stat-based weak ETag of express.static, with the encoding
  // appended so caches never confuse an encoded body with the identity one.
  return `W/"${size.toString(16)}-${Math.trunc(mtimeMs).toString(16)}-${encoding}"`;
}

export function createStaticCompressionMiddleware(options: StaticCompressionOptions) {
  const cache = new Map<string, CacheEntry>();

  function resolveFile(requestPath: string) {
    const alias = options.aliases?.[requestPath];
    const urlPath = alias ?? requestPath;
    if (!alias && !options.assetPaths.has(urlPath)) return null;
    // express.static ignores/denies dotfiles; never expose them through here.
    if (urlPath.split("/").some((segment) => segment.startsWith("."))) return null;
    if (!compressibleExtensions.has(path.posix.extname(urlPath).toLowerCase())) return null;
    return path.join(options.rootDir, ...urlPath.split("/").filter(Boolean));
  }

  function getVariant(filePath: string, size: number, mtimeMs: number, encoding: Encoding) {
    let entry = cache.get(filePath);
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) {
      entry = { size, mtimeMs, variants: new Map() };
      cache.set(filePath, entry);
    }
    let variant = entry.variants.get(encoding);
    if (!variant) {
      const owner = entry;
      variant = readFile(filePath).then((data) => {
        // The file changed between stat and read; do not cache a body whose
        // validators describe a different file version.
        if (data.length !== size) throw new Error("Static asset changed while compressing");
        return compress(encoding, data);
      });
      variant.catch(() => {
        if (owner.variants.get(encoding) === variant) owner.variants.delete(encoding);
      });
      entry.variants.set(encoding, variant);
    }
    return variant;
  }

  return async function staticCompression(req: Request, res: Response, next: NextFunction) {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    const filePath = resolveFile(req.path);
    if (!filePath) return next();

    // The URL now has encoded representations, so every response for it,
    // including the identity fallback below, must tell caches it varies.
    res.vary("Accept-Encoding");
    // Byte ranges refer to the identity representation; let express.static
    // handle them unchanged.
    if (req.headers.range) return next();

    const negotiated = req.acceptsEncodings("br", "gzip");
    if (negotiated !== "br" && negotiated !== "gzip") return next();
    const encoding: Encoding = negotiated;

    try {
      const info = await stat(filePath);
      if (!info.isFile() || info.size < minimumCompressibleBytes || info.size > maximumCompressibleBytes) {
        return next();
      }

      res.type(path.extname(filePath));
      res.setHeader("Cache-Control", "public, max-age=0");
      res.setHeader("Last-Modified", info.mtime.toUTCString());
      res.setHeader("ETag", weakEtag(info.size, info.mtimeMs, encoding));
      options.setHeaders?.(res);
      if (req.fresh) {
        res.status(304).end();
        return;
      }

      const body = await getVariant(filePath, info.size, info.mtimeMs, encoding);
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Length", String(body.length));
      if (req.method === "HEAD") res.end();
      else res.end(body);
    } catch {
      // Any failure falls back to the original uncompressed static handler.
      if (res.headersSent) return;
      res.removeHeader("ETag");
      res.removeHeader("Last-Modified");
      res.removeHeader("Cache-Control");
      res.removeHeader("Content-Type");
      next();
    }
  };
}
