import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { dismissDatabaseToolbarPopovers } from "../public/database-block.js";

const databaseClientSource = readFileSync(new URL("../public/database-block.js", import.meta.url), "utf8");
const appClientSource = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");

function createPanel(kind = "properties") {
  const selector = `.database-${kind}-panel`;
  const row = {};
  return {
    open: true,
    removeAttribute(name) {
      if (name === "open") this.open = false;
    },
    matches(candidate) {
      return candidate === selector;
    },
    closest(candidate) {
      return candidate === ".editor-block-row" ? row : null;
    }
  };
}

function createRoot(panels) {
  return {
    querySelectorAll() {
      return panels.filter((panel) => panel.open);
    }
  };
}

test("outside pointer/click targets close open database toolbar popovers", () => {
  const properties = createPanel("properties");
  const filters = createPanel("filter");
  const root = createRoot([properties, filters]);
  const outside = { closest: () => null };

  assert.equal(dismissDatabaseToolbarPopovers(root, outside), true);
  assert.equal(properties.open, false);
  assert.equal(filters.open, false);
});

test("interaction inside one open popover keeps it open while closing peers", () => {
  const properties = createPanel("properties");
  const filters = createPanel("filter");
  const root = createRoot([properties, filters]);
  const insideProperties = { closest: () => properties };

  assert.equal(dismissDatabaseToolbarPopovers(root, insideProperties), true);
  assert.equal(properties.open, true);
  assert.equal(filters.open, false);
});

test("capture-phase dismissal is wired before database controls can rerender", () => {
  assert.match(appClientSource, /addEventListener\("pointerdown", lightDismissDatabaseToolbarPopovers, \{ capture: true \}\)/);
  assert.match(appClientSource, /addEventListener\("click", lightDismissDatabaseToolbarPopovers, \{ capture: true \}\)/);
  assert.match(databaseClientSource, /consumeDatabaseToolbarLightDismiss\(row, "openProperties"\)/);
  assert.match(databaseClientSource, /markDatabaseToolbarLightDismiss\(panel\);/);
  assert.match(databaseClientSource, /focus\.focusPropertyId && reopen\.openProperties/);
});
