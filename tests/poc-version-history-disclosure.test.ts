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
import { signAuthToken } from "../src/lib/auth.js";
import { env } from "../src/config/env.js";
import { legacyAuthSessionCookieName } from "../src/lib/session-cookie-policy.js";

const owner = {
  id: "usr_history_owner",
  username: "history-owner",
  name: "History Owner",
  avatar_data: null,
  preferred_language: "en",
  default_collection_icon: null,
  password_hash: "unused",
  auth_version: 1,
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-04T00:00:00.000Z",
  theme: "light",
  country_login_mode: "OFF",
  vpn_block_enabled: 0,
  attachment_generation: 1
};
const editor = { ...owner, id: "usr_history_editor", username: "history-editor", name: "History Editor" };
const outsider = { ...owner, id: "usr_history_outsider", username: "history-outsider", name: "History Outsider" };
const page = {
  id: "pag_version_secret",
  title: "Shared page",
  icon: null,
  cover_url: null,
  is_archived: 0,
  is_collection: 0,
  owner_id: owner.id,
  parent_page_id: null,
  edit_version: 4,
  content_version: 4,
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-04T00:05:00.000Z"
};
const deletedSecret = "PROD_DB=mysql://root:secret@10.0.0.7/main";
const version = {
  id: 3,
  page_id: page.id,
  revision: 3,
  page_edit_version: 3,
  page_content_version: 3,
  actors: JSON.stringify([{ id: owner.id, username: owner.username, name: owner.name }]),
  source: "BLOCK_DELETE",
  change_count: 1,
  change_summary: JSON.stringify({
    baseline: 0,
    pageCreated: 0,
    pageFields: [],
    blocksCreated: 0,
    blocksUpdated: 0,
    blocksDeleted: 1,
    blocksMoved: 0
  }),
  changes: JSON.stringify([{ kind: "block-deleted", block: { id: "blk_secret", type: "MARKDOWN", markdown: deletedSecret } }]),
  created_at: "2026-08-04T00:03:00.000Z"
};

const tokenFor = (user: typeof owner) => signAuthToken({ sub: user.id, username: user.username, authVersion: 1 });
const cookieFor = (user: typeof owner) => `${legacyAuthSessionCookieName}=${tokenFor(user)}`;

beforeEach(() => {
  database.query.mockReset();
  database.queryOne.mockReset();
  database.execute.mockReset().mockResolvedValue({ affectedRows: 0 });

  database.query.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM page_versions")) return [{ ...version }];
    return [];
  });
  database.queryOne.mockImplementation(async (sql: string, params: readonly unknown[] = []) => {
    if (sql.includes("FROM user_auth_sessions")) return { id: String(params[0]) };
    if (sql.includes("FROM user_totp_ip_blocks")) return undefined;
    if (sql.includes("FROM users WHERE id = ?")) {
      if (sql.includes("country_login_mode") && !sql.includes("username")) return { country_login_mode: "OFF" };
      if (sql.includes("vpn_block_enabled") && !sql.includes("username")) return { vpn_block_enabled: 0 };
      return [owner, editor, outsider].find((user) => user.id === params[0]);
    }
    if (sql.includes("FROM pages WHERE id = ?")) return params[0] === page.id ? { ...page } : undefined;
    if (sql.includes("FROM page_collection_memberships")) return { collection_id: "pag_collection" };
    if (sql.includes("FROM collection_shares")) {
      return params[1] === editor.id ? { permission: "ADMIN", generation: "cshare_admin" } : undefined;
    }
    if (sql.includes("FROM page_shares")) return undefined;
    if (sql.includes("SELECT COUNT(*) AS share_count")) return { share_count: 1 };
    if (sql.includes("SELECT MAX(revision) AS revision FROM page_versions")) return { revision: 3 };
    if (sql.includes("FROM page_versions") && sql.includes("changes")) {
      return params[0] === page.id && String(params[1]) === String(version.id) ? { ...version } : undefined;
    }
    return undefined;
  });
});

describe("Version history disclosure regression", () => {
  it("keeps pre-share deleted content available to the owner only", async () => {
    const ownerList = await request(createApp())
      .get(`/api/pages/${page.id}/versions?limit=50`)
      .set("Cookie", cookieFor(owner))
      .expect(200);
    expect(ownerList.body.versions).toHaveLength(1);

    const ownerDetail = await request(createApp())
      .get(`/api/pages/${page.id}/versions/${version.id}`)
      .set("Cookie", cookieFor(owner))
      .expect(200);
    expect(ownerDetail.body.version.changes[0].block.markdown).toBe(deletedSecret);

    for (const user of [editor, outsider]) {
      const list = await request(createApp())
        .get(`/api/pages/${page.id}/versions?limit=50`)
        .set("Cookie", cookieFor(user))
        .expect(404);
      expect(list.body.error.code).toBe("NOT_FOUND");

      const detail = await request(createApp())
        .get(`/api/pages/${page.id}/versions/${version.id}`)
        .set("Cookie", cookieFor(user))
        .expect(404);
      expect(detail.body.error.code).toBe("NOT_FOUND");
    }

    const editorDelete = await request(createApp())
      .delete(`/api/pages/${page.id}/versions`)
      .set("Cookie", cookieFor(editor))
      .set("Origin", env.PUBLIC_ORIGIN)
      .send({ mutationId: "mut_editor_reset", expectedVersion: 4, expectedContentVersion: 4, expectedRevision: 3 })
      .expect(404);
    expect(editorDelete.body.error.code).toBe("NOT_FOUND");
  });
});
