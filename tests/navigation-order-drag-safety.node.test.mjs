import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (value) => value.replace(/\r\n/g, "\n");
const read = async (relativePath) => normalize(await readFile(new URL(`../${relativePath}`, import.meta.url), "utf8"));

test("sidebar reorder uses pointer capture on the existing three-dot handle for mouse and touch", async () => {
  const app = await read("public/app.js");
  const styles = await read("public/styles.css");

  assert.match(app, /elements\.appSidebar\.addEventListener\("pointerdown"[\s\S]*?\.navigation-more-button/);
  assert.match(app, /handle\.setPointerCapture\?\.\(event\.pointerId\)/);
  assert.match(app, /event\.pointerType === "touch" \? 7 : 4/);
  assert.match(app, /elements\.appSidebar\.addEventListener\("pointermove"/);
  assert.match(app, /elements\.appSidebar\.addEventListener\("pointerup"/);
  assert.match(app, /elements\.appSidebar\.addEventListener\("pointercancel"/);
  assert.match(styles, /\.app-mode \.navigation-more-button\s*\{[\s\S]*?touch-action:\s*none/);
});

test("sidebar reorder changes preference state only and rolls back when persistence fails", async () => {
  const app = await read("public/app.js");
  const finish = app.slice(app.indexOf("async function finishNavigationDrag"), app.indexOf("function renderSubpageIndexItem"));

  assert.match(finish, /snapshotNavigationPageOrder\(orderedIds\)/);
  assert.match(finish, /applyNavigationPageOrder\(orderedIds\)/);
  assert.match(finish, /api\("\/api\/auth\/navigation-order"/);
  assert.match(finish, /restoreNavigationPageOrder\(previousOrder\)/);
  assert.doesNotMatch(finish, /\/api\/pages\//);
  assert.match(app, /state\.searchQuery[\s\S]*?\|\| state\.activeTag[\s\S]*?event\.isPrimary/);
  assert.match(app, /suppressNavigationMenuClickUntil = Date\.now\(\) \+ 500/);
});

test("navigation-order API is user-scoped, access-checked, and never mutates page or block rows", async () => {
  const routes = await read("src/routes/auth.routes.ts");
  const start = routes.indexOf('authRouter.patch(\n  "/navigation-order"');
  const end = routes.indexOf('authRouter.get(\n  "/login-history"', start);
  assert.ok(start >= 0 && end > start, "navigation-order route is present");
  const route = routes.slice(start, end);

  assert.match(route, /SELECT id FROM users WHERE id = \? FOR UPDATE/);
  assert.match(route, /p\.owner_id = \? OR EXISTS/);
  assert.match(route, /ps\.permission = 'EDIT'/);
  assert.match(route, /INSERT INTO user_navigation_page_order/);
  assert.match(route, /ON DUPLICATE KEY UPDATE sort_order = VALUES\(sort_order\)/);
  assert.doesNotMatch(route, /UPDATE\s+pages\b/i);
  assert.doesNotMatch(route, /UPDATE\s+blocks\b/i);
  assert.doesNotMatch(route, /DELETE\s+FROM\s+pages\b/i);
  assert.doesNotMatch(route, /DELETE\s+FROM\s+blocks\b/i);
});

test("navigation-order migration is additive and backup round-trip preserves the preference", async () => {
  const migration = await read("migrations/049_navigation_page_order.sql");
  const transfer = await read("src/lib/data-transfer.ts");

  assert.match(migration, /CREATE TABLE IF NOT EXISTS user_navigation_page_order/);
  assert.match(migration, /PRIMARY KEY \(user_id, page_id\)/);
  assert.match(migration, /FOREIGN KEY \(user_id\) REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(migration, /FOREIGN KEY \(page_id\) REFERENCES pages\(id\) ON DELETE CASCADE/);
  assert.doesNotMatch(migration, /^\s*(?:DROP|TRUNCATE|DELETE|ALTER)\b/im);
  assert.match(transfer, /navigationPageOrder: z\.array\(navigationPageOrderSchema\)[^\n]*\.optional\(\)/);
  assert.match(transfer, /FROM user_navigation_page_order no/);
  assert.match(transfer, /INSERT INTO user_navigation_page_order/);
  assert.match(transfer, /navigationOrderedPages/);
});
