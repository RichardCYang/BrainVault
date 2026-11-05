import { lstat, open } from "node:fs/promises";

/** Flush file contents on every platform, and directory entries where supported. */
export async function syncPath(targetPath: string) {
  // Windows cannot fsync directories through Node's fs API. Only skip
  // confirmed directories; permission and I/O failures on files must propagate.
  if (process.platform === "win32" && (await lstat(targetPath)).isDirectory()) return;
  const handle = await open(targetPath, process.platform === "win32" ? "r+" : "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
