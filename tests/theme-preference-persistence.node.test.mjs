import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { toPublicUser } from "../src/lib/mappers.ts";

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

test("a missing theme projection silently converts a dark account to light", () => {
  assert.equal(toPublicUser(darkUserRow).theme, "dark");
  assert.equal(toPublicUser({ ...darkUserRow, theme: undefined }).theme, "light");
});

test("session restoration selects the persisted theme before mapping /api/auth/me", () => {
  assert.match(
    authMiddlewareSource,
    /SELECT\s+id,\s*username,\s*name,\s*avatar_data,\s*preferred_language,\s*default_collection_icon,\s*theme,\s*password_hash,/s
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
  assert.equal(themeProjectionCount, 3);
});
