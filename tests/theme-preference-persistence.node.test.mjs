import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { after } from "node:test";
process.env.NODE_ENV = "test";
const { toPublicUser } = await import("../src/lib/mappers.ts");
const { closeDb } = await import("../src/lib/db.ts");
after(closeDb);

const authMiddlewareSource = await readFile(new URL("../src/middleware/auth.ts", import.meta.url), "utf8");
const pageAccessSource = await readFile(new URL("../src/lib/page-access.ts", import.meta.url), "utf8");
const collaborationRoutesSource = await readFile(
  new URL("../src/routes/collaboration.routes.ts", import.meta.url),
  "utf8"
);

const darkUserRow = {
  id: "usr_theme",
  username: "theme-user",
  name: null,
  avatar_data: null,
  preferred_language: "ko",
  default_collection_icon: null,
  theme: "dark",
  created_at: "2026-08-04T00:00:00.000Z",
  updated_at: "2026-08-04T00:00:00.000Z"
};

test("the page-open mode is only exposed by the signed-in account's own projection", () => {
  assert.equal(toPublicUser({ ...darkUserRow, default_page_mode: "write" }).defaultPageMode, "write");
  assert.equal(toPublicUser({ ...darkUserRow, default_page_mode: "read" }).defaultPageMode, "read");
  // Owner/share projections never select the column, so other people's
  // preferences are not part of the public user shape.
  assert.equal("defaultPageMode" in toPublicUser(darkUserRow), false);
});

test("a missing theme projection silently converts a dark account to light", () => {
  assert.equal(toPublicUser(darkUserRow).theme, "dark");
  assert.equal(toPublicUser({ ...darkUserRow, theme: undefined }).theme, "light");
});

test("session restoration selects the persisted theme before mapping /api/auth/me", () => {
  assert.match(
    authMiddlewareSource,
    /SELECT\s+id,\s*username,\s*name,\s*avatar_data,\s*preferred_language,\s*default_collection_icon,\s*theme,\s*default_page_mode,\s*country_login_mode,\s*password_hash,/s
  );
});

test("page owner and share projections satisfy the public-user theme contract", () => {
  assert.match(pageAccessSource, /\|\s*"default_collection_icon"\s*\|\s*"theme"/s);
  assert.match(
    pageAccessSource,
    /SELECT\s+id,\s*username,\s*name,\s*avatar_data,\s*preferred_language,\s*default_collection_icon,\s*theme,\s*created_at,\s*updated_at/s
  );

  assert.match(collaborationRoutesSource, /\|\s*"default_collection_icon"\s*\|\s*"theme"/s);
  const themeProjectionCount = collaborationRoutesSource.match(/u\.default_collection_icon,\s*u\.theme,/g)?.length ?? 0;
  const userProjectionCount = collaborationRoutesSource.match(/u\.default_collection_icon,/g)?.length ?? 0;
  assert.ok(userProjectionCount > 0);
  assert.equal(themeProjectionCount, userProjectionCount);
});
