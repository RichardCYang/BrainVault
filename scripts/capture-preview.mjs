import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = join(projectRoot, "public");
// Screenshots live in a dated folder; bump this date when the preview is refreshed.
const previewDate = "2026-11-12";
const outputDirectory = join(projectRoot, "docs", "assets", previewDate);
const outputPath = join(outputDirectory, "preview.png");
const fixture = JSON.parse(await readFile(new URL("./demo-workspace.json", import.meta.url), "utf8"));
const now = `${previewDate}T08:00:00.000Z`;
const previewPageId = "preview-page";

const tagObjects = fixture.page.tags.map((name, index) => ({
  id: `preview-tag-${index + 1}`,
  name,
  createdAt: now
}));

const previewSummary = {
  id: previewPageId,
  title: fixture.page.title,
  icon: fixture.page.icon,
  coverUrl: null,
  version: 1,
  contentVersion: 1,
  isArchived: false,
  isCollection: false,
  ownerId: "preview-user",
  parentPageId: null,
  createdAt: now,
  updatedAt: now,
  tags: tagObjects,
  counts: { blocks: fixture.blocks.length, children: 0 }
};

const supportingPages = [
  {
    id: "preview-notes",
    title: "Weekly Meeting Notes",
    icon: "🗒️",
    coverUrl: null,
    version: 1,
    contentVersion: 1,
    isArchived: false,
    isCollection: false,
    ownerId: "preview-user",
    parentPageId: null,
    createdAt: "2026-07-15T04:00:00.000Z",
    updatedAt: "2026-07-16T09:15:00.000Z",
    tags: [],
    counts: { blocks: 6, children: 0 }
  },
  {
    id: "preview-research",
    title: "User Research",
    icon: "🔬",
    coverUrl: null,
    version: 1,
    contentVersion: 1,
    isArchived: false,
    isCollection: false,
    ownerId: "preview-user",
    parentPageId: null,
    createdAt: "2026-07-12T02:00:00.000Z",
    updatedAt: "2026-07-15T08:20:00.000Z",
    tags: [],
    counts: { blocks: 8, children: 0 }
  }
];

const previewDetail = {
  ...previewSummary,
  blocks: fixture.blocks.map((block, index) => ({
    id: `preview-block-${index + 1}`,
    pageId: previewPageId,
    parentBlockId: null,
    type: block.type,
    markdown: block.markdown,
    htmlCache: null,
    checked: Boolean(block.checked),
    sortOrder: index,
    metadata: block.metadata ?? null,
    createdAt: now,
    updatedAt: now,
    children: []
  })),
  children: []
};

const user = {
  id: "preview-user",
  username: "demo",
  name: "BrainVault Demo",
  avatarData: null,
  preferredLanguage: "en",
  defaultCollectionIcon: "📚",
  theme: "light",
  workspaceGeneration: 1,
  createdAt: now,
  updatedAt: now
};

const mimeTypes = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(response, status, value) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

function previewInjection() {
  return `
    <style>
      #status { display: none !important; }
      body.preview-capture-ready * { caret-color: transparent !important; }
    </style>
    <script>
      localStorage.setItem("brainvault.language", "en");
      window.addEventListener("DOMContentLoaded", () => {
        let opened = false;
        const preparePreview = () => {
          const pageButton = document.querySelector('[data-page-id="${previewPageId}"]');
          if (!opened && pageButton) {
            opened = true;
            pageButton.click();
          }

          const database = document.querySelector('.editor-block-row[data-block-type="DATABASE"]');
          const kanban = document.querySelector('.editor-block-row[data-block-type="KANBAN"]');
          if (database && kanban) {
            window.scrollTo({ top: 0, behavior: "instant" });
            document.body.classList.add("preview-capture-ready");
            return;
          }
          window.setTimeout(preparePreview, 75);
        };
        window.setTimeout(preparePreview, 75);
      });
    </script>
  `;
}

async function handleRequest(request, response) {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");

  if (url.pathname === "/api/auth/me") {
    sendJson(response, 200, { user });
    return;
  }

  if (url.pathname === "/api/auth/navigation-preferences") {
    sendJson(response, 200, { collapsedPageIds: [], navigationPageOrder: [] });
    return;
  }

  if (url.pathname === "/api/pages") {
    sendJson(response, 200, { pages: [previewSummary, ...supportingPages] });
    return;
  }

  if (url.pathname === `/api/pages/${previewPageId}`) {
    sendJson(response, 200, { page: previewDetail });
    return;
  }

  if (url.pathname === `/api/pages/${previewPageId}/comments`) {
    sendJson(response, 200, { comments: [] });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: { code: "PREVIEW_ONLY", message: "Preview mock endpoint not found" } });
    return;
  }

  const relativePath = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname.slice(1));
  const safePath = normalize(relativePath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicRoot, safePath);

  try {
    let body = await readFile(filePath);
    if (safePath === "index.html") {
      body = Buffer.from(body.toString("utf8").replace("</body>", `${previewInjection()}</body>`));
    }
    response.writeHead(200, {
      "Content-Type": mimeTypes[extname(filePath)] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    response.end(body);
  } catch {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Not found");
  }
}

function findChromium() {
  if (process.env.BRAINVAULT_CHROMIUM_PATH) return process.env.BRAINVAULT_CHROMIUM_PATH;
  const candidates = process.platform === "win32"
    ? ["chrome.exe", "msedge.exe", "chromium.exe"]
    : ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "chrome"];
  const lookupCommand = process.platform === "win32" ? "where" : "which";

  for (const candidate of candidates) {
    const result = spawnSync(lookupCommand, [candidate], { encoding: "utf8" });
    if (result.status === 0) return result.stdout.split(/\r?\n/).find(Boolean)?.trim();
  }
  return null;
}

await mkdir(outputDirectory, { recursive: true });
const chromiumPath = findChromium();
if (!chromiumPath) {
  throw new Error("Chromium/Chrome was not found. Set BRAINVAULT_CHROMIUM_PATH and retry.");
}
await rm(outputPath, { force: true });
const browserProfilePath = await mkdtemp(join(tmpdir(), "brainvault-preview-"));

const server = createServer((request, response) => {
  void handleRequest(request, response).catch((error) => {
    console.error(error);
    if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Preview server error");
  });
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const viewport = { width: 1600, height: 1250 };
const captureTimeoutMs = 45_000;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function readDevToolsEndpoint(profilePath, deadline) {
  // Chromium writes the chosen debugging port to DevToolsActivePort when it is
  // started with --remote-debugging-port=0, which avoids port collisions.
  while (Date.now() < deadline) {
    try {
      const [port] = (await readFile(join(profilePath, "DevToolsActivePort"), "utf8")).split(/\r?\n/);
      if (port) return `http://127.0.0.1:${port.trim()}`;
    } catch {
      // The browser has not written the file yet.
    }
    await delay(100);
  }
  throw new Error("Chromium did not expose a DevTools endpoint");
}

async function connectToPage(endpoint, deadline) {
  while (Date.now() < deadline) {
    try {
      const targets = await (await fetch(`${endpoint}/json/list`)).json();
      const page = targets.find((target) => target.type === "page");
      if (page?.webSocketDebuggerUrl) return openCdpSession(page.webSocketDebuggerUrl);
    } catch {
      // The page target is not ready yet.
    }
    await delay(100);
  }
  throw new Error("Chromium did not expose a page target");
}

function openCdpSession(webSocketUrl) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const pending = new Map();
    let nextId = 0;
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.method === "Runtime.exceptionThrown") {
        console.error("Preview page error:", message.params.exceptionDetails?.exception?.description
          ?? message.params.exceptionDetails?.text);
      }
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      if (message.error) request.reject(new Error(`${request.method}: ${message.error.message}`));
      else request.resolve(message.result);
    });
    socket.addEventListener("error", () => reject(new Error("DevTools connection failed")));
    socket.addEventListener("open", () => resolve({
      send(method, params = {}) {
        const id = ++nextId;
        socket.send(JSON.stringify({ id, method, params }));
        return new Promise((resolveRequest, rejectRequest) => {
          pending.set(id, { method, resolve: resolveRequest, reject: rejectRequest });
        });
      },
      close: () => socket.close()
    }));
  });
}

async function waitForPreviewReady(session, deadline) {
  while (Date.now() < deadline) {
    const { result } = await session.send("Runtime.evaluate", {
      expression: "document.body?.classList.contains('preview-capture-ready') === true",
      returnByValue: true
    });
    if (result?.value === true) return;
    await delay(100);
  }
  throw new Error("The preview page did not finish rendering the demo workspace");
}

let browser = null;
try {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Preview server did not expose a TCP port");
  const url = `http://127.0.0.1:${address.port}/`;
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--disable-background-networking",
    "--disable-crash-reporter",
    "--disable-extensions",
    "--disable-dev-shm-usage",
    "--disable-sync",
    "--hide-scrollbars",
    "--metrics-recording-only",
    "--no-default-browser-check",
    "--no-first-run",
    "--lang=en-US",
    "--force-device-scale-factor=1",
    `--window-size=${viewport.width},${viewport.height}`,
    "--remote-debugging-port=0",
    `--user-data-dir=${browserProfilePath}`,
    "about:blank"
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");

  browser = spawn(chromiumPath, args, { stdio: "ignore" });
  const browserExit = new Promise((resolve) => browser.once("exit", resolve));
  const browserFailure = new Promise((_, reject) => {
    browser.once("error", reject);
    browserExit.then((code) => reject(new Error(`Chromium exited early with code ${code}`)));
  });
  browserFailure.catch(() => {});

  const deadline = Date.now() + captureTimeoutMs;
  const capture = (async () => {
    const endpoint = await readDevToolsEndpoint(browserProfilePath, deadline);
    const session = await connectToPage(endpoint, deadline);
    try {
      await session.send("Runtime.enable");
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: false
      });
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "UTC" });
      await session.send("Page.enable");
      await session.send("Page.navigate", { url });
      await waitForPreviewReady(session, deadline);
      // Let web fonts, emoji images, and the final layout settle before capturing.
      await session.send("Runtime.evaluate", {
        expression: "document.fonts.ready.then(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))",
        awaitPromise: true
      });
      await delay(500);
      const { data } = await session.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      await writeFile(outputPath, Buffer.from(data, "base64"));
    } finally {
      session.close();
    }
  })();

  await Promise.race([capture, browserFailure]);
  await access(outputPath);
  console.log(`Preview captured: ${outputPath}`);
} finally {
  if (browser && browser.exitCode === null) {
    const exited = new Promise((resolve) => browser.once("exit", resolve));
    browser.kill();
    await Promise.race([exited, delay(5_000)]);
  }
  await new Promise((resolve) => server.close(resolve));
  await rm(browserProfilePath, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
