import express from "express";
import http, { type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import request from "supertest";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { closeDb } from "../src/lib/db.js";
import { createStaticCompressionMiddleware } from "../src/lib/static-compression.js";

afterAll(async () => {
  await closeDb();
});

type RawResponse = { status: number; headers: IncomingHttpHeaders; body: Buffer };

// supertest transparently decodes bodies; use node:http directly so the test
// can prove the encoded bytes decode back to the exact file on disk.
async function fetchRaw(
  app: express.Express,
  url: string,
  headers: Record<string, string>,
  method = "GET"
): Promise<RawResponse> {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    const { port } = server.address() as AddressInfo;
    return await new Promise<RawResponse>((resolve, reject) => {
      http.request({ host: "127.0.0.1", port, path: url, headers, method }, (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
        response.on("error", reject);
      }).on("error", reject).end();
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

const publicFile = (name: string) => readFileSync(path.resolve(process.cwd(), "public", name));

describe("public static asset compression", () => {
  const app = createApp();

  it.each(["/app.js", "/styles.css", "/i18n.js", "/index.html", "/"])("serves byte-identical Brotli for %s", async (url) => {
    const response = await fetchRaw(app, url, { "Accept-Encoding": "br, gzip" });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("br");
    expect(response.headers.vary).toMatch(/Accept-Encoding/i);
    expect(response.headers["cache-control"]).toBe("public, max-age=0");
    expect(response.headers["x-content-type-options"]).toBe("nosniff");
    const original = publicFile(url === "/" ? "index.html" : url.slice(1));
    expect(Number(response.headers["content-length"])).toBe(response.body.length);
    expect(response.body.length).toBeLessThan(original.length / 2);
    expect(zlib.brotliDecompressSync(response.body).equals(original)).toBe(true);
  });

  it("compresses vendored KaTeX and the Yjs module while keeping their header policies", async () => {
    const vendor = (...parts: string[]) => readFileSync(path.resolve(process.cwd(), "node_modules", ...parts));

    const katex = await fetchRaw(app, "/vendor/katex/0.18.2/katex.min.js", { "Accept-Encoding": "br" });
    expect(katex.status).toBe(200);
    expect(katex.headers["content-encoding"]).toBe("br");
    // SRI in index.html is computed over the decoded bytes, which must be unchanged.
    expect(zlib.brotliDecompressSync(katex.body).equals(vendor("katex", "dist", "katex.min.js"))).toBe(true);

    const identityModule = await fetchRaw(app, "/vendor/yjs/yjs.mjs", { "Accept-Encoding": "identity" });
    const encodedModule = await fetchRaw(app, "/vendor/yjs/yjs.mjs", { "Accept-Encoding": "gzip" });
    expect(identityModule.headers["content-encoding"]).toBeUndefined();
    expect(encodedModule.headers["content-encoding"]).toBe("gzip");
    for (const header of ["cache-control", "content-type", "cross-origin-resource-policy", "x-content-type-options"]) {
      expect(encodedModule.headers[header]).toBe(identityModule.headers[header]);
    }
    expect(encodedModule.headers["cache-control"]).toBe("public, max-age=0, must-revalidate");
    expect(zlib.gunzipSync(encodedModule.body).equals(identityModule.body)).toBe(true);
    expect(identityModule.body.equals(vendor("yjs", "dist", "yjs.mjs"))).toBe(true);
  });

  it("never serves dotfiles through the compressed path", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-static-dot-"));
    try {
      writeFileSync(path.join(dir, ".secret.json"), JSON.stringify({ secret: "x".repeat(4096) }));
      const local = express();
      local.use(createStaticCompressionMiddleware({ rootDir: dir, assetPaths: new Set(["/.secret.json"]) }));
      local.use(express.static(dir));
      const response = await fetchRaw(local, "/.secret.json", { "Accept-Encoding": "br" });
      expect(response.status).toBe(404);
      expect(response.headers["content-encoding"]).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serves gzip when Brotli is not accepted, with the original content type", async () => {
    const identity = await fetchRaw(app, "/app.js", { "Accept-Encoding": "identity" });
    const response = await fetchRaw(app, "/app.js", { "Accept-Encoding": "gzip" });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["content-type"]).toBe(identity.headers["content-type"]);
    expect(zlib.gunzipSync(response.body).equals(publicFile("app.js"))).toBe(true);
  });

  it("keeps the identity response unchanged when compression is not accepted", async () => {
    for (const acceptEncoding of ["identity", "br;q=0, gzip;q=0"]) {
      const response = await fetchRaw(app, "/app.js", { "Accept-Encoding": acceptEncoding });
      expect(response.status).toBe(200);
      expect(response.headers["content-encoding"]).toBeUndefined();
      expect(response.headers.vary).toMatch(/Accept-Encoding/i);
      expect(response.body.equals(publicFile("app.js"))).toBe(true);
    }
  });

  it("revalidates the encoded representation with its own ETag", async () => {
    const encoded = await fetchRaw(app, "/styles.css", { "Accept-Encoding": "br" });
    const identity = await fetchRaw(app, "/styles.css", { "Accept-Encoding": "identity" });
    expect(encoded.headers.etag).toBeTruthy();
    expect(encoded.headers.etag).not.toBe(identity.headers.etag);
    const notModified = await fetchRaw(app, "/styles.css", {
      "Accept-Encoding": "br",
      "If-None-Match": String(encoded.headers.etag)
    });
    expect(notModified.status).toBe(304);
    expect(notModified.body.length).toBe(0);
    // A cached identity validator must not revalidate the Brotli body.
    const mismatched = await fetchRaw(app, "/styles.css", {
      "Accept-Encoding": "br",
      "If-None-Match": String(identity.headers.etag)
    });
    expect(mismatched.status).toBe(200);
  });

  it("leaves byte ranges and binary files on the original static handler", async () => {
    const ranged = await fetchRaw(app, "/app.js", { "Accept-Encoding": "br", Range: "bytes=0-9" });
    expect(ranged.status).toBe(206);
    expect(ranged.headers["content-encoding"]).toBeUndefined();
    expect(ranged.body.equals(publicFile("app.js").subarray(0, 10))).toBe(true);

    const png = await fetchRaw(app, "/img/favicon.png", { "Accept-Encoding": "br" });
    expect(png.status).toBe(200);
    expect(png.headers["content-encoding"]).toBeUndefined();
    expect(png.body.equals(publicFile("img/favicon.png"))).toBe(true);
  });

  it("answers HEAD with encoded headers and no body", async () => {
    const head = await fetchRaw(app, "/app.js", { "Accept-Encoding": "br" }, "HEAD");
    expect(head.status).toBe(200);
    expect(head.headers["content-encoding"]).toBe("br");
    expect(head.body.length).toBe(0);
  });

  it("never compresses API responses or paths outside the public asset set", async () => {
    const health = await request(app).get("/health").set("Accept-Encoding", "br, gzip").expect(200);
    expect(health.headers["content-encoding"]).toBeUndefined();
    expect(health.body).toEqual({ ok: true });

    const api = await request(app).get("/api/pages").set("Accept-Encoding", "br, gzip");
    expect(api.headers["content-encoding"]).toBeUndefined();

    const traversal = await fetchRaw(app, "/..%2Fpackage.json", { "Accept-Encoding": "br" });
    expect(traversal.headers["content-encoding"]).toBeUndefined();
    expect(traversal.body.toString()).not.toContain("\"name\": \"brainvault\"");
  });

  it("recompresses after a file changes instead of serving a stale cached body", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "bv-static-"));
    try {
      const file = path.join(dir, "asset.js");
      writeFileSync(file, "a".repeat(4096));
      const local = express();
      local.use(createStaticCompressionMiddleware({ rootDir: dir, assetPaths: new Set(["/asset.js"]) }));
      local.use(express.static(dir));
      const fetchBody = async () => {
        const response = await fetchRaw(local, "/asset.js", { "Accept-Encoding": "br" });
        expect(response.headers["content-encoding"]).toBe("br");
        return zlib.brotliDecompressSync(response.body).toString();
      };
      expect(await fetchBody()).toBe("a".repeat(4096));
      writeFileSync(file, "b".repeat(8192));
      const future = new Date(Date.now() + 5000);
      utimesSync(file, future, future);
      expect(await fetchBody()).toBe("b".repeat(8192));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
