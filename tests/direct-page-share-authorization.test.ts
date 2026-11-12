import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn()
}));

vi.mock("../src/lib/db.js", () => ({
  db: database,
  transaction: async (fn: (client: unknown) => unknown) => fn(database)
}));

import { createApp } from "../src/app.js";
import { env } from "../src/config/env.js";
import { signAuthToken } from "../src/lib/auth.js";
import { getPageAccess, toAccessPayload } from "../src/lib/page-access.js";
import { legacyAuthSessionCookieName } from "../src/lib/session-cookie-policy.js";

const owner = {
  id: "usr_share_owner", username: "share-owner", name: "Owner", avatar_data: null,
  preferred_language: "en", default_collection_icon: null, theme: "light" as const,
  password_hash: "unused", auth_version: 1, attachment_generation: 1,
  country_login_mode: "OFF",
  created_at: "2026-11-01T00:00:00.000Z", updated_at: "2026-11-01T00:00:00.000Z"
};
const admin = { ...owner, id: "usr_share_admin", username: "share-admin" };
const writer = { ...owner, id: "usr_share_writer", username: "share-writer" };
const reader = { ...owner, id: "usr_share_reader", username: "share-reader" };
const editor = { ...owner, id: "usr_private_editor", username: "private-editor" };
const outsider = { ...owner, id: "usr_share_outsider", username: "share-outsider" };
const users = [owner, admin, writer, reader, editor, outsider];
const page = {
  id: "pag_private_shares", title: "Shared document", icon: null, cover_url: null,
  cover_position_x: 50, cover_position_y: 50, is_archived: 0, is_collection: 0,
  owner_id: owner.id, parent_page_id: "pag_share_collection", edit_version: 1,
  content_version: 1, last_mutation_id: null, last_mutation_hash: null,
  created_at: owner.created_at, updated_at: owner.updated_at
};
const collection = { ...page, id: "pag_share_collection", is_collection: 1, parent_page_id: null };
const privateGeneration = "share_private_editor_generation";
const collectionGeneration = "cshare_admin_generation";
const permissions = new Map([[admin.id, "ADMIN"], [writer.id, "WRITE"], [reader.id, "READ"]]);
const cookieFor = (user: typeof owner) => `${legacyAuthSessionCookieName}=${signAuthToken({
  sub: user.id, username: user.username, authVersion: 1
})}`;
const isDirectShareList = (sql: string) => sql.includes("FROM page_shares ps") && sql.includes("INNER JOIN users u");

beforeEach(() => {
  vi.clearAllMocks();
  database.execute.mockReset().mockResolvedValue({ affectedRows: 1 });
  database.query.mockReset().mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("AS cursor_created_at")) {
      return [page, collection].map((target) => ({ ...target, cursor_created_at: target.created_at }));
    }
    if (sql.includes("SELECT pcm.page_id, pcm.collection_id")) {
      return [page, collection].map((target) => ({ page_id: target.id,
        collection_id: collection.id, collection_permission: permissions.get(String(params[0])) ?? null }));
    }
    if (sql.includes("FROM users") && sql.includes("WHERE id IN")) return [owner];
    if (isDirectShareList(sql)) {
      expect(params).toEqual([owner.id, page.id]);
      return [{ ...editor, permission: "EDIT", shared_at: owner.created_at, share_generation: privateGeneration }];
    }
    if (sql.includes("FROM collection_shares cs") && sql.includes("INNER JOIN users u")) {
      return [{ ...admin, permission: "ADMIN", shared_at: owner.created_at,
        share_updated_at: owner.updated_at, share_generation: collectionGeneration }];
    }
    return [];
  });
  database.queryOne.mockReset().mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM user_auth_sessions")) return { id: String(params[0]) };
    if (sql.includes("FROM users WHERE id = ?")) return users.find((user) => user.id === params[0]);
    if (sql.includes("FROM pages WHERE id = ?")) {
      return [page, collection].find((target) => target.id === params[0]);
    }
    if (sql.includes("SELECT COUNT(*) AS share_count")) return { share_count: 4 };
    if (sql.includes("FROM page_collection_memberships")) return { collection_id: collection.id };
    if (sql.includes("FROM collection_shares")) {
      const permission = permissions.get(String(params[1]));
      return permission ? { permission, generation: collectionGeneration } : undefined;
    }
    if (sql.includes("FROM page_shares")) {
      return params[0] === page.id && params[1] === editor.id ? { generation: privateGeneration } : undefined;
    }
    if (sql.includes("cs.permission AS collection_permission")) {
      const actorId = String(params[0]);
      if (params[2] !== page.id) return undefined;
      return {
        owner_id: owner.id, attachment_generation: 1, collection_id: collection.id,
        collection_permission: permissions.get(actorId) ?? null,
        collection_share_generation: permissions.has(actorId) ? collectionGeneration : null,
        direct_share_user_id: actorId === editor.id ? editor.id : null
      };
    }
    return undefined;
  });
});

describe("IDOR-2026-001 direct page-share authorization", () => {
  it("returns the direct collaborator and generation to the owner", async () => {
    const response = await request(createApp()).get(`/api/pages/${page.id}/shares`)
      .set("Cookie", cookieFor(owner)).expect(200);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body.count).toBe(1);
    expect(response.body.shares).toEqual([expect.objectContaining({
      user: expect.objectContaining({ id: editor.id, username: editor.username }),
      permission: "EDIT", generation: privateGeneration
    })]);
    expect(response.body.shares[0].user).not.toHaveProperty("password_hash");
  });

  it.each([
    [admin, "PAGE_OWNER_REQUIRED"],
    [writer, "PAGE_ADMIN_REQUIRED"],
    [reader, "PAGE_ADMIN_REQUIRED"],
    [editor, "PAGE_ADMIN_REQUIRED"]
  ])("denies direct-share listing for $username", async (actor, code) => {
    const response = await request(createApp()).get(`/api/pages/${page.id}/shares`)
      .set("Cookie", cookieFor(actor)).expect(403);
    expect(response.body.error.code).toBe(code);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    expect(response.body).not.toHaveProperty("shares");
    expect(response.text).not.toContain(privateGeneration);
    expect(response.text).not.toContain(editor.username);
    expect(database.query.mock.calls.some(([sql]) => isDirectShareList(sql))).toBe(false);
  });

  it.each(["GET", "HEAD"])("denies delegated administrators through %s", async (method) => {
    const app = request(createApp());
    const response = await (method === "GET" ? app.get(`/api/pages/${page.id}/shares`) : app.head(`/api/pages/${page.id}/shares`))
      .set("Cookie", cookieFor(admin)).expect(403);
    if (method === "HEAD") expect(response.text ?? "").toBe("");
    expect(database.query.mock.calls.some(([sql]) => isDirectShareList(sql))).toBe(false);
  });

  it("requires authentication and hides inaccessible or missing pages", async () => {
    await request(createApp()).get(`/api/pages/${page.id}/shares`).expect(401);
    for (const pageId of [page.id, "pag_missing"]) {
      const response = await request(createApp()).get(`/api/pages/${pageId}/shares`)
        .set("Cookie", cookieFor(outsider)).expect(404);
      expect(response.body.error.code).toBe("NOT_FOUND");
      expect(response.text).not.toContain(privateGeneration);
    }
    expect(database.query.mock.calls.some(([sql]) => isDirectShareList(sql))).toBe(false);
  });

  it.each(["POST", "DELETE"])("retains owner-only %s admission", async (method) => {
    const app = request(createApp());
    const response = await (method === "POST"
      ? app.post(`/api/pages/${page.id}/shares`).send({ username: outsider.username })
      : app.delete(`/api/pages/${page.id}/shares/${editor.id}`).send({ expectedGeneration: privateGeneration }))
      .set("Cookie", cookieFor(admin)).set("Origin", env.PUBLIC_ORIGIN).expect(403);
    expect(response.body.error.code).toBe("PAGE_OWNER_REQUIRED");
    expect(database.execute.mock.calls.every(([sql]) => sql.includes("user_auth_sessions"))).toBe(true);
  });

  it("keeps collection grants visible to their delegated administrator", async () => {
    const response = await request(createApp()).get(`/api/collections/${collection.id}/shares`)
      .set("Cookie", cookieFor(admin)).expect(200);
    expect(response.body.shares[0].generation).toBe(collectionGeneration);
    expect(response.text).not.toContain(privateGeneration);
    expect(database.query.mock.calls.some(([sql]) => isDirectShareList(sql))).toBe(false);
  });

  it.each([true, false])("advertises scoped sharing controls in page lists (compact=%s)", async (compact) => {
    for (const actor of [owner, admin]) {
      const response = await request(createApp()).get(`/api/pages?compact=${compact}`)
        .set("Cookie", cookieFor(actor)).expect(200);
      const document = response.body.pages.find((item: { id: string }) => item.id === page.id);
      const root = response.body.pages.find((item: { id: string }) => item.id === collection.id);
      expect(document.access).toMatchObject({ canManageSharing: actor.id === owner.id, canManagePage: true });
      expect(root.access).toMatchObject({ canManageSharing: true, canManagePage: true });
    }
  });

  it("advertises scoped sharing controls in page details", async () => {
    for (const actor of [owner, admin]) {
      const response = await request(createApp()).get(`/api/pages/${page.id}`)
        .set("Cookie", cookieFor(actor)).expect(200);
      expect(response.body.page.access).toMatchObject({ canManageSharing: actor.id === owner.id, canManagePage: true });
    }
  });

  it("advertises sharing capability for the authorized object scope", async () => {
    const ownerAccess = await getPageAccess(page.id, owner.id);
    const adminAccess = await getPageAccess(page.id, admin.id);
    const collectionAccess = await getPageAccess(collection.id, admin.id);
    expect(adminAccess).toMatchObject({ role: "ADMIN", scope: "COLLECTION" });
    expect(toAccessPayload(ownerAccess).canManageSharing).toBe(true);
    expect(toAccessPayload(adminAccess)).toMatchObject({ canManageSharing: false, canManagePage: true });
    expect(toAccessPayload(collectionAccess)).toMatchObject({ canManageSharing: true, canManagePage: true });
    for (const actor of [reader, writer, editor]) {
      expect(toAccessPayload(await getPageAccess(page.id, actor.id)).canManageSharing).toBe(false);
    }
  });
});
