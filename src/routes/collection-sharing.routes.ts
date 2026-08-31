import { Router } from "express";
import { z } from "zod";
import { db, transaction, type DbClient } from "../lib/db.js";
import { assertCurrentAuthSessionBoundary } from "../lib/auth-sessions.js";
import { createId } from "../lib/id.js";
import { ApiError, notFound } from "../lib/http.js";
import {
  assertPageCanAdminister,
  getEffectivePageShareCount,
  getPageAccess,
  type CollectionSharePermission
} from "../lib/page-access.js";
import {
  collaborationShareAccountRateLimit,
  collaborationShareIpRateLimit
} from "../middleware/auth-rate-limit.js";
import { requireAuth, requireRequestAuthScope } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { requireUser, routeIdSchema, usernameSchema } from "../utils/schemas.js";
import { toPublicUser } from "../lib/mappers.js";
import type { PageRow, UserRow } from "../types/domain.js";
import {
  disconnectPageCollaborators,
  disconnectSharedUserGrant
} from "../lib/collaboration-server.js";
import {
  ensureCollaborationState,
  getCollaborationState
} from "../lib/collaboration-lineage.js";
import {
  isUnsupportedCollaborationMaterializationVersion,
  needsCollaborationMaterialization
} from "../lib/collaboration-protocol.js";
import { assertNoActiveCollaborationWriteLeases } from "../lib/collaboration-write-lease.js";
import {
  grantDirectPageRecovery,
  grantLegacyYjsPageRecovery,
  grantYjsPageRecovery
} from "../lib/recovery-candidates.js";

export const collectionSharingRouter = Router();
collectionSharingRouter.use(requireAuth);

const collectionIdParamsSchema = z.object({ collectionId: routeIdSchema });
const collectionShareParamsSchema = z.object({
  collectionId: routeIdSchema,
  userId: routeIdSchema
});
const collectionSharePermissionSchema = z.enum(["READ", "WRITE", "ADMIN"]);
const createCollectionShareSchema = z.object({
  username: usernameSchema,
  permission: collectionSharePermissionSchema
}).strict();
const updateCollectionShareSchema = z.object({
  permission: collectionSharePermissionSchema,
  expectedGeneration: routeIdSchema
}).strict();
const removeCollectionShareSchema = z.object({
  expectedGeneration: routeIdSchema
}).strict();

type CollectionShareUserRow = Pick<
  UserRow,
  | "id"
  | "username"
  | "name"
  | "avatar_data"
  | "preferred_language"
  | "default_collection_icon"
  | "theme"
  | "created_at"
  | "updated_at"
> & {
  permission: CollectionSharePermission;
  shared_at: string;
  updated_at: string;
  share_generation: string;
};

function toCollectionSharePayload(row: CollectionShareUserRow) {
  return {
    user: toPublicUser(row),
    permission: row.permission,
    sharedAt: row.shared_at,
    updatedAt: row.updated_at,
    generation: row.share_generation
  };
}

async function getCollectionShareRows(collectionId: string, client: DbClient = db) {
  return client.query<CollectionShareUserRow>(
    `SELECT u.id, u.username, u.name, u.avatar_data, u.preferred_language,
            u.default_collection_icon, u.theme, u.created_at, u.updated_at,
            cs.permission, cs.created_at AS shared_at, cs.updated_at AS updated_at,
            cs.generation AS share_generation
     FROM collection_shares cs
     INNER JOIN users u ON u.id = cs.user_id
     WHERE cs.collection_id = ?
     ORDER BY cs.created_at ASC, u.username ASC`,
    [collectionId]
  );
}

async function getManageableCollection(
  collectionId: string,
  userId: string,
  client: DbClient,
  lockPage = false
) {
  const access = await getPageAccess(collectionId, userId, client, { lockPage });
  if (!access.page.is_collection) throw notFound("Collection");
  assertPageCanAdminister(access, "Administrator permission is required to manage collection sharing");
  return access;
}

async function lockCollectionDocumentPages(collectionId: string, client: DbClient) {
  return client.query<PageRow>(
    `SELECT p.*
     FROM pages p
     INNER JOIN page_collection_memberships pcm ON pcm.page_id = p.id
     WHERE pcm.collection_id = ? AND p.is_collection = 0
     ORDER BY p.id ASC
     FOR UPDATE`,
    [collectionId]
  );
}

async function resetCollaborationForFirstShare(
  page: PageRow,
  ownerId: string,
  client: DbClient
) {
  await grantDirectPageRecovery(client, {
    pageId: page.id,
    principalId: ownerId,
    ownerId,
    reason: "SHARE_STARTED"
  });
  await grantLegacyYjsPageRecovery(client, {
    pageId: page.id,
    principalId: ownerId,
    ownerId,
    reason: "SHARE_STARTED"
  });
  await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [page.id]);
  await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [page.id]);
  await ensureCollaborationState(page.id, client);
}

async function preserveRevokedGrantRecovery(
  page: PageRow,
  ownerId: string,
  revokedUserId: string,
  client: DbClient
) {
  await grantDirectPageRecovery(client, {
    pageId: page.id,
    principalId: revokedUserId,
    ownerId,
    reason: "SHARE_REMOVED"
  });
  await grantLegacyYjsPageRecovery(client, {
    pageId: page.id,
    principalId: revokedUserId,
    ownerId,
    reason: "SHARE_REMOVED"
  });
  await grantLegacyYjsPageRecovery(client, {
    pageId: page.id,
    principalId: ownerId,
    ownerId,
    reason: "SHARE_REMOVED"
  });

  const state = await getCollaborationState(page.id, client, { lock: true });
  if (state && isUnsupportedCollaborationMaterializationVersion(state.materialization_version)) {
    throw new ApiError(
      409,
      "COLLABORATION_MATERIALIZATION_VERSION_UNSUPPORTED",
      "This collaboration state was written by a newer BrainVault version. Upgrade this server before removing collection access."
    );
  }
  if (state) {
    await grantYjsPageRecovery(client, {
      pageId: page.id,
      principalId: revokedUserId,
      ownerId,
      documentEpoch: state.document_epoch,
      reason: "SHARE_REMOVED"
    });
    await grantYjsPageRecovery(client, {
      pageId: page.id,
      principalId: ownerId,
      ownerId,
      documentEpoch: state.document_epoch,
      reason: "SHARE_REMOVED"
    });
  }
  return state;
}

async function teardownCollaborationIfFinalShare(
  pageId: string,
  preRemovalState: Awaited<ReturnType<typeof getCollaborationState>>,
  client: DbClient
) {
  const remaining = await getEffectivePageShareCount(pageId, client, undefined, { lock: true });
  if (remaining > 0) return remaining;

  const latestUpdateRow = await client.queryOne<{ max_update_id: number | null }>(
    "SELECT MAX(id) AS max_update_id FROM page_yjs_updates WHERE page_id = ?",
    [pageId]
  );
  const state = preRemovalState ?? await getCollaborationState(pageId, client, { lock: true });
  const latestUpdateId = Number(latestUpdateRow?.max_update_id ?? 0);
  const materializedUpdateId = Number(state?.materialized_update_id ?? 0);
  const materializationVersion = Number(state?.materialization_version ?? 0);
  if (!Number.isSafeInteger(latestUpdateId) || latestUpdateId < 0) {
    throw new ApiError(500, "INVALID_COLLABORATION_STATE", "Collaboration update id exceeded the supported range");
  }
  if (needsCollaborationMaterialization({ latestUpdateId, materializedUpdateId, materializationVersion })) {
    throw new ApiError(
      409,
      "COLLABORATION_CHANGES_PENDING",
      "Synchronize the latest collaborative edits before removing the final collection collaborator",
      { pageId, latestUpdateId, materializedUpdateId, materializationVersion }
    );
  }
  await client.execute("DELETE FROM page_yjs_updates WHERE page_id = ?", [pageId]);
  await client.execute("DELETE FROM page_collaboration_state WHERE page_id = ?", [pageId]);
  return 0;
}

collectionSharingRouter.get(
  "/collections/:collectionId/shares",
  validate({ params: collectionIdParamsSchema }),
  async (req, res, next) => {
    try {
      const user = requireUser(req.user);
      const collectionId = String(req.params.collectionId);
      const rows = await transaction(async (client) => {
        await getManageableCollection(collectionId, user.id, client);
        return getCollectionShareRows(collectionId, client);
      });
      res.setHeader("Cache-Control", "private, no-store");
      res.json({ shares: rows.map(toCollectionSharePayload), count: rows.length });
    } catch (error) {
      next(error);
    }
  }
);

collectionSharingRouter.post(
  "/collections/:collectionId/shares",
  collaborationShareIpRateLimit,
  collaborationShareAccountRateLimit,
  validate({ params: collectionIdParamsSchema, body: createCollectionShareSchema }),
  async (req, res, next) => {
    try {
      const actor = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const collectionId = String(req.params.collectionId);
      const username = String(req.body.username);
      const permission = String(req.body.permission) as CollectionSharePermission;
      const result = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(actor.id, authScope, client);
        const collectionAccess = await getManageableCollection(collectionId, actor.id, client, true);
        const ownerId = collectionAccess.page.owner_id;
        const pages = await lockCollectionDocumentPages(collectionId, client);
        const target = await client.queryOne<UserRow>(
          `SELECT u.* FROM users u
           WHERE u.username = ? AND u.id <> ?
             AND NOT EXISTS (
               SELECT 1 FROM collection_shares cs
               WHERE cs.collection_id = ? AND cs.user_id = u.id
             )`,
          [username, ownerId, collectionId]
        );
        if (!target) {
          throw new ApiError(400, "SHARE_TARGET_UNAVAILABLE", "The requested account cannot be added");
        }

        const firstSharePages: PageRow[] = [];
        const downgradedTargetPages: PageRow[] = [];
        for (const page of pages) {
          const shareCount = await getEffectivePageShareCount(page.id, client, collectionId, { lock: true });
          if (shareCount === 0) firstSharePages.push(page);
          if (permission === "READ") {
            // A newly added collection READ grant is immediately authoritative.
            // If this account already has a direct EDIT grant for a member page,
            // adding the collection share is a write-permission downgrade for
            // that page even though the legacy grant remains stored underneath.
            const directTargetGrant = await client.queryOne<{ user_id: string }>(
              `SELECT user_id FROM page_shares
               WHERE page_id = ? AND user_id = ? AND permission = 'EDIT'`,
              [page.id, target.id]
            );
            if (directTargetGrant) downgradedTargetPages.push(page);
          }
        }
        const fencedPageIds = [...new Set([
          ...firstSharePages.map((page) => page.id),
          ...downgradedTargetPages.map((page) => page.id)
        ])];
        await assertNoActiveCollaborationWriteLeases(client, fencedPageIds);
        for (const page of downgradedTargetPages) {
          await preserveRevokedGrantRecovery(page, ownerId, target.id, client);
        }
        for (const page of firstSharePages) {
          await resetCollaborationForFirstShare(page, ownerId, client);
        }

        const generation = createId("cshare");
        await client.execute(
          `INSERT INTO collection_shares (collection_id, user_id, permission, shared_by, generation)
           VALUES (?, ?, ?, ?, ?)`,
          [collectionId, target.id, permission, actor.id, generation]
        );
        const created = (await getCollectionShareRows(collectionId, client))
          .find((row) => row.id === target.id);
        if (!created) throw new ApiError(500, "COLLECTION_SHARE_FAILED", "The collection share was not created");
        const rows = await getCollectionShareRows(collectionId, client);
        return { created, count: rows.length, pages };
      });

      for (const page of result.pages) {
        disconnectPageCollaborators(page.id, "Collection sharing changed");
      }
      res.status(201).json({ share: toCollectionSharePayload(result.created), count: result.count });
    } catch (error) {
      next(error);
    }
  }
);

collectionSharingRouter.patch(
  "/collections/:collectionId/shares/:userId",
  validate({ params: collectionShareParamsSchema, body: updateCollectionShareSchema }),
  async (req, res, next) => {
    try {
      const actor = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const collectionId = String(req.params.collectionId);
      const sharedUserId = String(req.params.userId);
      const permission = String(req.body.permission) as CollectionSharePermission;
      const expectedGeneration = String(req.body.expectedGeneration);
      const result = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(actor.id, authScope, client);
        const collectionAccess = await getManageableCollection(collectionId, actor.id, client, true);
        const ownerId = collectionAccess.page.owner_id;
        const pages = await lockCollectionDocumentPages(collectionId, client);
        const existing = await client.queryOne<{ generation: string; permission: CollectionSharePermission }>(
          `SELECT generation, permission FROM collection_shares
           WHERE collection_id = ? AND user_id = ? FOR UPDATE`,
          [collectionId, sharedUserId]
        );
        if (!existing) throw notFound("Collection share");
        if (existing.generation !== expectedGeneration) {
          throw new ApiError(
            409,
            "COLLECTION_SHARE_GENERATION_CHANGED",
            "The collection grant changed in another session. Refresh before updating it."
          );
        }
        // A WRITE/ADMIN -> READ downgrade can strand browser-local Yjs updates.
        // Preserve a recovery admission before rotating the grant generation, so
        // those bytes are recoverable without allowing the downgraded session to
        // keep mutating the live shared document.
        if (existing.permission !== "READ" && permission === "READ") {
          await assertNoActiveCollaborationWriteLeases(client, pages.map((page) => page.id));
          for (const page of pages) {
            await preserveRevokedGrantRecovery(page, ownerId, sharedUserId, client);
          }
        }
        const generation = createId("cshare");
        const update = await client.execute<{ affectedRows: number }>(
          `UPDATE collection_shares
           SET permission = ?, generation = ?, shared_by = ?, updated_at = CURRENT_TIMESTAMP(3)
           WHERE collection_id = ? AND user_id = ? AND generation = ?`,
          [permission, generation, actor.id, collectionId, sharedUserId, expectedGeneration]
        );
        if (Number(update.affectedRows) !== 1) {
          throw new ApiError(409, "COLLECTION_SHARE_GENERATION_CHANGED", "The collection grant changed in another session.");
        }
        const updated = (await getCollectionShareRows(collectionId, client))
          .find((row) => row.id === sharedUserId);
        if (!updated) throw notFound("Collection share");
        return { updated, oldGeneration: existing.generation, pages };
      });

      for (const page of result.pages) {
        disconnectSharedUserGrant(
          page.id,
          sharedUserId,
          result.oldGeneration,
          "Collection permission changed"
        );
      }
      res.json({ share: toCollectionSharePayload(result.updated) });
    } catch (error) {
      next(error);
    }
  }
);

collectionSharingRouter.delete(
  "/collections/:collectionId/shares/:userId",
  validate({ params: collectionShareParamsSchema, body: removeCollectionShareSchema }),
  async (req, res, next) => {
    try {
      const actor = requireUser(req.user);
      const authScope = requireRequestAuthScope(req);
      const collectionId = String(req.params.collectionId);
      const sharedUserId = String(req.params.userId);
      const expectedGeneration = String(req.body.expectedGeneration);
      const result = await transaction(async (client) => {
        await assertCurrentAuthSessionBoundary(actor.id, authScope, client);
        const collectionAccess = await getManageableCollection(collectionId, actor.id, client, true);
        const ownerId = collectionAccess.page.owner_id;
        const pages = await lockCollectionDocumentPages(collectionId, client);
        await assertNoActiveCollaborationWriteLeases(client, pages.map((page) => page.id));
        const existing = await client.queryOne<{ generation: string }>(
          `SELECT generation FROM collection_shares
           WHERE collection_id = ? AND user_id = ? FOR UPDATE`,
          [collectionId, sharedUserId]
        );
        if (!existing) throw notFound("Collection share");
        if (existing.generation !== expectedGeneration) {
          throw new ApiError(
            409,
            "COLLECTION_SHARE_GENERATION_CHANGED",
            "The collection grant changed in another session. Refresh before removing it."
          );
        }

        const preRemovalStates = new Map<string, Awaited<ReturnType<typeof getCollaborationState>>>();
        for (const page of pages) {
          preRemovalStates.set(
            page.id,
            await preserveRevokedGrantRecovery(page, ownerId, sharedUserId, client)
          );
        }
        const deletion = await client.execute<{ affectedRows: number }>(
          `DELETE FROM collection_shares
           WHERE collection_id = ? AND user_id = ? AND generation = ?`,
          [collectionId, sharedUserId, expectedGeneration]
        );
        if (Number(deletion.affectedRows) !== 1) {
          throw new ApiError(409, "COLLECTION_SHARE_GENERATION_CHANGED", "The collection grant changed in another session.");
        }

        for (const page of pages) {
          await teardownCollaborationIfFinalShare(page.id, preRemovalStates.get(page.id) ?? null, client);
        }
        const rows = await getCollectionShareRows(collectionId, client);
        return { count: rows.length, oldGeneration: existing.generation, pages };
      });

      for (const page of result.pages) {
        disconnectSharedUserGrant(page.id, sharedUserId, result.oldGeneration, "Collection access was removed");
        // The removed collection grant can expose a lower-priority direct page
        // grant. Reconnecting all remaining clients keeps the room's effective
        // participant and write permissions aligned immediately.
        disconnectPageCollaborators(page.id, "Collection sharing changed");
      }
      res.json({ removed: true, count: result.count });
    } catch (error) {
      next(error);
    }
  }
);
