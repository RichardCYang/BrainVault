import { Router } from "express";
import {
  createWorkspaceSnapshot,
  deleteWorkspaceSnapshot,
  diffWorkspaceSnapshot,
  listWorkspaceSnapshots,
  restoreSafetySnapshotSkipHeader,
  restoreWorkspaceSnapshot,
  wantsRestoreWithoutSafetySnapshot
} from "../lib/workspace-snapshots.js";
import { getWorkspaceBackupCapacity } from "../lib/data-transfer.js";
import { toPublicUser } from "../lib/mappers.js";
import { requireRestoreOperationId } from "../lib/data-restore-operation.js";
import { requireRecentAuthentication, requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import {
  beginDataImportProcessing,
  finishDataExportProcessing,
  dataExportConcurrencyLimit,
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
  const [snapshots, capacity] = await Promise.all([
    listWorkspaceSnapshots(user.id),
    getWorkspaceBackupCapacity(user.id)
  ]);
  res.json({ snapshots, capacity });
});

snapshotRouter.post("/", requireRecentAuthentication, dataExportRateLimit, async (req, res) => {
  const user = requireUser(req.user);
  const authScope = requireRequestAuthScope(req);
  const snapshot = await createWorkspaceSnapshot(user.id, authScope);
  res.status(201).json({ snapshot });
});

snapshotRouter.get<SnapshotRouteParams>("/:snapshotId/diff", requireRecentAuthentication, dataExportRateLimit, dataExportConcurrencyLimit, async (req, res) => {
  try {
    const user = requireUser(req.user);
    const diff = await diffWorkspaceSnapshot(user.id, req.params.snapshotId);
    res.json({ diff });
  } finally {
    finishDataExportProcessing(res);
  }
});

snapshotRouter.post<SnapshotRouteParams>(
  "/:snapshotId/restore",
  requireRecentAuthentication,
  dataImportRateLimit,
  dataImportConcurrencyLimit,
  async (req, res) => {
    let releaseDataImport: (() => void) | null = null;
    try {
      releaseDataImport = beginDataImportProcessing(res);
      const user = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const operationId = requireRestoreOperationId(req.header("X-Restore-Operation-Id"));
      const result = await restoreWorkspaceSnapshot(user.id, req.params.snapshotId, authScope, operationId, {
        safetySnapshot: !wantsRestoreWithoutSafetySnapshot(req.header(restoreSafetySnapshotSkipHeader))
      });
      res.json({
        user: toPublicUser(result.user),
        counts: result.counts,
        sharing: result.sharing,
        safetySnapshotId: "safetySnapshotId" in result ? result.safetySnapshotId : null
      });
    } finally {
      releaseDataImport?.();
    }
  }
);

snapshotRouter.delete<SnapshotRouteParams>("/:snapshotId", requireRecentAuthentication, async (req, res) => {
  const user = requireUser(req.user);
  const authScope = requireRequestAuthScope(req);
  await deleteWorkspaceSnapshot(user.id, req.params.snapshotId, authScope);
  res.status(204).end();
});
