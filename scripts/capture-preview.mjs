import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { access, readFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const publicRoot = join(projectRoot, "public");
const outputPath = join(projectRoot, "docs", "preview.png");
const fixture = JSON.parse(await readFile(new URL("./demo-workspace.json", import.meta.url), "utf8"));
const now = "2026-07-17T06:30:00.000Z";
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
      localStorage.setItem("brainvault.token", "preview-token");
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

  if (url.pathname === "/api/pages") {
    sendJson(response, 200, { pages: [previewSummary, ...supportingPages] });
    return;
  }

  if (url.pathname === `/api/pages/${previewPageId}`) {
    sendJson(response, 200, { page: previewDetail });
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

await mkdir(join(projectRoot, "docs"), { recursive: true });
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
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=7000",
    "--window-size=1600,1250",
    `--user-data-dir=${browserProfilePath}`,
    `--screenshot=${outputPath}`,
    url
  ];
  if (typeof process.getuid === "function" && process.getuid() === 0) args.unshift("--no-sandbox");

  await new Promise((resolve, reject) => {
    const browser = spawn(chromiumPath, args, { stdio: "inherit" });
    let settled = false;
    let timeout;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve();
    };
    timeout = setTimeout(() => {
      browser.kill("SIGKILL");
      finish(new Error("Chromium preview capture timed out after 45 seconds"));
    }, 45_000);
    browser.once("error", finish);
    browser.once("exit", (code) => finish(code === 0 ? null : new Error(`Chromium exited with code ${code}`)));
  });

  await access(outputPath);
  console.log(`Preview captured: ${outputPath}`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await rm(browserProfilePath, { recursive: true, force: true });
}
