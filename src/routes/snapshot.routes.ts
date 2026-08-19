import { Router } from "express";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  diffWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreWorkspaceSnapshot
} from "../lib/workspace-snapshots.js";
import { toPublicUser } from "../lib/mappers.js";
import { requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import {
  beginDataImportProcessing,
  dataExportRateLimit,
  dataImportConcurrencyLimit,
  dataImportRateLimit
} from "../middleware/data-rate-limit.js";
import { requireUser } from "../utils/schemas.js";

type SnapshotRouteParams = { snapshotId: string };

export const snapshotRouter = Router();
snapshotRouter.use(requireAuth);

snapshotRouter.get("/", async (req, res) => {
  const user = requireUser(req.user);
  const snapshots = await listWorkspaceSnapshots(user.id);
  res.json({ snapshots });
});

snapshotRouter.post("/", dataExportRateLimit, async (req, res) => {
  const user = requireUser(req.user);
  const authScope = requireRequestAuthScope(req);
  const snapshot = await createWorkspaceSnapshot(user.id, authScope);
  res.status(201).json({ snapshot });
});

snapshotRouter.get<SnapshotRouteParams>("/:snapshotId/diff", dataExportRateLimit, async (req, res) => {
  const user = requireUser(req.user);
  const diff = await diffWorkspaceSnapshot(user.id, req.params.snapshotId);
  res.json({ diff });
});

snapshotRouter.post<SnapshotRouteParams>(
  "/:snapshotId/restore",
  dataImportRateLimit,
  dataImportConcurrencyLimit,
  async (req, res) => {
    let releaseDataImport: (() => void) | null = null;
    try {
      releaseDataImport = beginDataImportProcessing(res);
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const result = await restoreWorkspaceSnapshot(user.id, req.params.snapshotId, authScope);
      res.json({ user: toPublicUser(result.user), counts: result.counts, sharing: result.sharing });
    } finally {
      releaseDataImport?.();
    }
  }
);

snapshotRouter.delete<SnapshotRouteParams>("/:snapshotId", async (req, res) => {
  const user = requireUser(req.user);
  const authScope = requireRequestAuthScope(req);
  await deleteWorkspaceSnapshot(user.id, req.params.snapshotId, authScope);
  res.status(204).end();
});
