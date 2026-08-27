import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authRoutes = await readFile(
  new URL("../src/routes/auth.routes.ts", import.meta.url),
  "utf8"
);

function routeSlice(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.notEqual(start, -1, `missing route marker: ${startMarker}`);
  assert.notEqual(end, -1, `missing route boundary: ${endMarker}`);
  return source.slice(start, end);
}

test("navigation preference reads re-authorize collapsed page ids in one snapshot", () => {
  const route = routeSlice(
    authRoutes,
    'authRouter.get("/navigation-preferences"',
    'authRouter.patch('
  );

  assert.match(route, /transaction\(async \(client\) => \{/);
  assert.match(
    route,
    /FROM user_navigation_collapsed_pages np[\s\S]*?INNER JOIN pages p ON p\.id = np\.page_id[\s\S]*?WHERE np\.user_id = \?[\s\S]*?p\.owner_id = \? OR EXISTS \([\s\S]*?FROM page_shares ps[\s\S]*?ps\.page_id = p\.id AND ps\.user_id = \? AND ps\.permission = 'EDIT'/
  );
  assert.match(
    route,
    /FROM user_navigation_page_order no[\s\S]*?INNER JOIN pages p ON p\.id = no\.page_id[\s\S]*?WHERE no\.user_id = \?[\s\S]*?p\.owner_id = \? OR EXISTS \([\s\S]*?FROM page_shares ps/
  );
  assert.doesNotMatch(route, /db\.query</);
});

test("revoked-share reproduction is closed by access-scoped collapsed lookup", () => {
  // Pre-fix reproduction:
  // 1. A collaborator collapses shared page P, storing (user, P).
  // 2. The owner revokes the share; the preference row may intentionally remain.
  // 3. GET /navigation-preferences used to select collapsed rows by user_id only,
  //    disclosing P after access revocation.
  //
  // The corrected SELECT joins pages and requires current owner/share access,
  // so that stale preference remains inert unless access is granted again.
  const route = routeSlice(
    authRoutes,
    'authRouter.get("/navigation-preferences"',
    'authRouter.patch('
  );
  const collapsedQuery = route.slice(
    route.indexOf("FROM user_navigation_collapsed_pages np"),
    route.indexOf("const orderRows")
  );
  assert.match(collapsedQuery, /INNER JOIN pages p ON p\.id = np\.page_id/);
  assert.match(collapsedQuery, /ps\.user_id = \?/);
  assert.match(collapsedQuery, /ps\.permission = 'EDIT'/);
});
