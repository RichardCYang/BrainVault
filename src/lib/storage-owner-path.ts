import path from "node:path";
import { ApiError } from "./http.js";

export function storageOwnerDirectory(root: string, userId: string) {
  if (typeof userId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(userId)) {
    throw new ApiError(400, "INVALID_STORAGE_OWNER", "The storage owner identifier is invalid");
  }
  const base = path.resolve(root);
  const directory = path.resolve(base, userId);
  const relative = path.relative(base, directory);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiError(400, "INVALID_STORAGE_OWNER", "The storage owner directory is outside its root");
  }
  return directory;
}
