import { createHmac, timingSafeEqual } from "node:crypto";
import { json, Router, type Request, type Response } from "express";
import { z } from "zod";
import { env } from "../config/env.js";
import { assertCurrentAuthSessionBoundary, type AuthSessionBoundaryScope } from "../lib/auth-sessions.js";
import { db, transaction, type DbClient } from "../lib/db.js";
import { ApiError } from "../lib/http.js";
import { requireAuth, requireJsonRequestBody, requireRequestAuthScope } from "../middleware/auth.js";
import { validate } from "../middleware/validate.js";
import { workspaceQueryRateLimit } from "../middleware/workspace-read-limits.js";
import { requireUser } from "../utils/schemas.js";
import { consumeMfaStepUpIfRequired } from "./mfa.routes.js";

const maxCollections = 32;
const maxRevision = 0xffffffff;
const maxDocumentBytes = 512 * 1024 + 16; // Includes the AES-GCM tag.
const idSchema = z.uuidv4().refine((value) => value === value.toLowerCase());
const paramsSchema = z.object({ id: idSchema });
const revisionSchema = z.number().int().min(1).max(maxRevision);

function base64url(minBytes: number, maxBytes = minBytes) {
  return z.string().min(Math.ceil(minBytes * 4 / 3)).max(Math.ceil(maxBytes * 4 / 3))
    .regex(/^[A-Za-z0-9_-]+$/).refine((value) => {
      const bytes = Buffer.from(value, "base64url");
      return bytes.length >= minBytes && bytes.length <= maxBytes && bytes.toString("base64url") === value;
    });
}

function envelope(minBytes: number, maxBytes = minBytes) {
  return z.object({ iv: base64url(12), ciphertext: base64url(minBytes, maxBytes) }).strict();
}

const keySlotsSchema = z.object({
  version: z.literal(1),
  password: z.object({ salt: base64url(32), wrapped: envelope(48) }).strict(),
  passkey: z.object({ credentialId: base64url(1, 1023), salt: base64url(32), wrapped: envelope(48) }).strict().nullable()
}).strict();
const documentSchema = envelope(17, maxDocumentBytes);
const openSchema = z.object({ stepUpToken: base64url(32).optional() }).strict();
const createSchema = openSchema.extend({ id: idSchema, keySlots: keySlotsSchema, document: documentSchema });
const mutationSchema = z.object({ grant: base64url(32), revision: revisionSchema }).strict();
const updateSchema = mutationSchema.extend({ document: documentSchema });

type KeySlots = z.infer<typeof keySlotsSchema>;
type CollectionSummary = { id: string; key_slots: string; created_at: Date; updated_at: Date };
type CollectionRow = CollectionSummary & { revision: number; document_iv: Buffer; document_ciphertext: Buffer };

function toSummary(row: CollectionSummary, keySlots: KeySlots = JSON.parse(row.key_slots)) {
  const passkey = keySlots.passkey;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    passkey: passkey && { credentialId: passkey.credentialId, salt: passkey.salt }
  };
}

function readCollection(client: DbClient, ownerId: string, id: string) {
  return client.queryOne<CollectionRow>(
    `SELECT id, key_slots, revision, document_iv, document_ciphertext, created_at, updated_at
     FROM encrypted_collections WHERE owner_id = ? AND id = ? FOR UPDATE`,
    [ownerId, id]
  );
}

function notFound() {
  return new ApiError(404, "ENCRYPTED_COLLECTION_NOT_FOUND", "Encrypted collection not found");
}

function conflict() {
  return new ApiError(409, "ENCRYPTED_COLLECTION_CONFLICT", "The encrypted collection changed in another session");
}

// Authorizes writes within the same live account session after step-up. This
// capability has no role in deriving or transporting the collection key.
function writeGrant(ownerId: string, id: string, scope: AuthSessionBoundaryScope) {
  return createHmac("sha256", env.JWT_SECRET)
    .update(JSON.stringify(["brainvault:encrypted-collection:write:v1", ownerId, id,
      scope.sessionId, scope.authVersion, scope.workspaceGeneration]))
    .digest();
}

function assertWriteGrant(grant: string, ownerId: string, id: string, scope: AuthSessionBoundaryScope) {
  if (!timingSafeEqual(Buffer.from(grant, "base64url"), writeGrant(ownerId, id, scope))) {
    throw new ApiError(403, "ENCRYPTED_COLLECTION_GRANT_REQUIRED", "Unlock this encrypted collection before editing it");
  }
}

function toOpened(row: CollectionRow, ownerId: string, scope: AuthSessionBoundaryScope) {
  const keySlots: KeySlots = JSON.parse(row.key_slots);
  return {
    ...toSummary(row, keySlots),
    keySlots,
    revision: row.revision,
    document: {
      iv: row.document_iv.toString("base64url"),
      ciphertext: row.document_ciphertext.toString("base64url")
    },
    grant: writeGrant(ownerId, row.id, scope).toString("base64url")
  };
}

export const encryptedCollectionRouter = Router();
encryptedCollectionRouter.use(requireAuth, workspaceQueryRateLimit);

const parseEncryptedJson = [requireJsonRequestBody, json({ limit: "720kb", inflate: false })];

encryptedCollectionRouter.get("/", async (req, res) => {
  const { id: ownerId } = requireUser(req.user);
  const rows = await db.query<CollectionSummary>(
    `SELECT id, key_slots, created_at, updated_at FROM encrypted_collections
     WHERE owner_id = ? ORDER BY created_at, id LIMIT ?`,
    [ownerId, maxCollections]
  );
  res.json({ collections: rows.map((row) => toSummary(row)) });
});

encryptedCollectionRouter.post("/", parseEncryptedJson, validate({ body: createSchema }), async (req: Request, res: Response) => {
  const { id: ownerId } = requireUser(req.user);
  const scope = requireRequestAuthScope(req);
  const { id, keySlots, document, stepUpToken } = req.body as z.infer<typeof createSchema>;
  const row = await transaction(async (client) => {
    await assertCurrentAuthSessionBoundary(ownerId, scope, client);
    await consumeMfaStepUpIfRequired(client, ownerId, scope, stepUpToken, "encrypted-collection-create", id);
    const existing = await readCollection(client, ownerId, id);
    const keySlotsJson = JSON.stringify(keySlots);
    if (existing) {
      if (existing.revision === 1 && existing.key_slots === keySlotsJson
        && existing.document_iv.toString("base64url") === document.iv
        && existing.document_ciphertext.toString("base64url") === document.ciphertext) return existing;
      throw conflict();
    }
    const usage = await client.queryOne<{ total: number }>(
      "SELECT COUNT(*) AS total FROM encrypted_collections WHERE owner_id = ?", [ownerId]
    );
    if (Number(usage?.total) >= maxCollections) {
      throw new ApiError(409, "ENCRYPTED_COLLECTION_LIMIT", "An account can hold up to 32 encrypted collections");
    }
    await client.execute(
      `INSERT INTO encrypted_collections (owner_id, id, key_slots, document_iv, document_ciphertext)
       VALUES (?, ?, ?, ?, ?)`,
      [ownerId, id, keySlotsJson, Buffer.from(document.iv, "base64url"), Buffer.from(document.ciphertext, "base64url")]
    );
    const created = await readCollection(client, ownerId, id);
    if (!created) throw new Error("Encrypted collection insert did not return a row");
    return created;
  });
  res.status(201).json(toOpened(row, ownerId, scope));
});

encryptedCollectionRouter.post("/:id/open", parseEncryptedJson, validate({ params: paramsSchema, body: openSchema }), async (req: Request, res: Response) => {
  const { id: ownerId } = requireUser(req.user);
  const { id } = req.params as z.infer<typeof paramsSchema>;
  const scope = requireRequestAuthScope(req);
  const { stepUpToken } = req.body as z.infer<typeof openSchema>;
  const row = await transaction(async (client) => {
    await assertCurrentAuthSessionBoundary(ownerId, scope, client);
    const current = await readCollection(client, ownerId, id);
    if (!current) throw notFound();
    await consumeMfaStepUpIfRequired(client, ownerId, scope, stepUpToken, "encrypted-collection-open", id);
    return current;
  });
  res.json(toOpened(row, ownerId, scope));
});

encryptedCollectionRouter.patch("/:id", parseEncryptedJson, validate({ params: paramsSchema, body: updateSchema }), async (req: Request, res: Response) => {
  const { id: ownerId } = requireUser(req.user);
  const { id } = req.params as z.infer<typeof paramsSchema>;
  const scope = requireRequestAuthScope(req);
  const { document, grant, revision } = req.body as z.infer<typeof updateSchema>;
  assertWriteGrant(grant, ownerId, id, scope);
  const nextRevision = await transaction(async (client) => {
    await assertCurrentAuthSessionBoundary(ownerId, scope, client);
    const row = await readCollection(client, ownerId, id);
    if (!row) throw notFound();
    const iv = Buffer.from(document.iv, "base64url");
    const ciphertext = Buffer.from(document.ciphertext, "base64url");
    const next = revision + 1;
    // The browser retries the original sealed bytes after a lost response.
    if (row.revision === next && row.document_iv.equals(iv) && row.document_ciphertext.equals(ciphertext)) return next;
    if (row.revision !== revision || next > maxRevision) throw conflict();
    await client.execute(
      `UPDATE encrypted_collections SET revision = ?, document_iv = ?, document_ciphertext = ?
       WHERE owner_id = ? AND id = ?`,
      [next, iv, ciphertext, ownerId, id]
    );
    return next;
  });
  res.json({ revision: nextRevision });
});

encryptedCollectionRouter.delete("/:id", parseEncryptedJson, validate({ params: paramsSchema, body: mutationSchema }), async (req: Request, res: Response) => {
  const { id: ownerId } = requireUser(req.user);
  const { id } = req.params as z.infer<typeof paramsSchema>;
  const scope = requireRequestAuthScope(req);
  const { grant, revision } = req.body as z.infer<typeof mutationSchema>;
  assertWriteGrant(grant, ownerId, id, scope);
  await transaction(async (client) => {
    await assertCurrentAuthSessionBoundary(ownerId, scope, client);
    const row = await readCollection(client, ownerId, id);
    if (!row) return;
    if (row.revision !== revision) throw conflict();
    await client.execute("DELETE FROM encrypted_collections WHERE owner_id = ? AND id = ?", [ownerId, id]);
  });
  res.sendStatus(204);
});
