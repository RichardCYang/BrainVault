import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

const migrationsDir = new URL("../migrations/", import.meta.url);

// This registry is intentionally explicit. A newly-created table must be
// classified before durability tests pass, so a schema migration cannot add
// user-visible state without forcing a backup/restore scope review.
const tableScope = new Map([
  ["blocks", "portable"],
  ["collection_shares", "portable"],
  ["custom_icon_library_removals", "portable"],
  ["custom_icons", "portable"],
  // Explicit owner publication grants are portable only with their owned pages
  // and archived icon files; restore rebinds the owner to the destination user.
  ["custom_icon_page_publications", "portable"],
  ["page_comments", "portable"],
  ["page_shares", "portable"],
  ["page_tags", "portable"],
  ["page_versions", "portable"],
  ["pages", "portable"],
  ["tags", "portable"],
  ["user_navigation_collapsed_pages", "portable"],
  ["user_navigation_page_order", "portable"],
  // Only the profile/preferences subset of users is portable. Credentials,
  // account identity, authentication generations, lockouts and login policy
  // are deliberately retained by the destination account instead.
  ["users", "portable-profile-subset"],

  // Rebuilt from the restored page hierarchy rather than serialized verbatim.
  ["page_collection_memberships", "derived"],

  // Backup archives are themselves snapshots of workspace state; nesting the
  // snapshot catalog and its archives recursively is deliberately out of scope.
  ["workspace_snapshots", "snapshot-catalog"],

  ["block_create_mutations", "operational"],
  ["block_delete_mutations", "operational"],
  ["block_move_mutations", "operational"],
  ["block_order_mutations", "operational"],
  ["data_restore_markers", "operational"],
  ["page_collaboration_state", "operational"],
  ["page_collaboration_write_leases", "operational"],
  ["page_comment_create_mutations", "operational"],
  ["page_create_mutations", "operational"],
  ["page_delete_mutations", "operational"],
  ["page_recovery_candidates", "operational"],
  ["page_recovery_grants", "operational"],
  ["page_version_reset_mutations", "operational"],
  ["page_yjs_updates", "operational"],
  ["schema_migrations", "operational"],

  ["mfa_login_sessions", "security"],
  ["mfa_step_up_sessions", "security"],
  ["mfa_totp_setups", "security"],
  ["passkey_login_challenges", "security"],
  ["user_auth_sessions", "security"],
  ["user_country_login_blocks", "security"],
  ["user_country_login_countries", "security"],
  ["user_login_attempts", "security"],
  ["user_passkeys", "security"],
  ["user_totp_credentials", "security"],
  ["user_totp_ip_blocks", "security"],
  ["user_totp_ip_failures", "security"],
  ["webauthn_challenges", "security"]
]);

// Any new ALTER/CREATE migration touching a portable table must be reviewed
// against src/lib/data-transfer.ts before this allowlist is advanced. This
// catches the easy-to-miss case where a new column is added to an existing
// workspace table while the backup manifest silently remains unchanged.
const reviewedPortableDdlMigrations = [
  "001_init.sql",
  "002_users_username.sql",
  "003_blocks_table_type.sql",
  "004_blocks_kanban_type.sql",
  "005_blocks_attachment_type.sql",
  "006_blocks_database_type.sql",
  "007_blocks_bookmark_type.sql",
  "008_user_account_settings.sql",
  "009_pages_collection_kind.sql",
  "011_blocks_ai_chat_type.sql",
  "012_blocks_math_type.sql",
  "013_edit_versions.sql",
  "015_page_content_versions.sql",
  "016_edit_mutation_ids.sql",
  "019_mutation_request_hashes.sql",
  "020_page_sharing_yjs_collaboration.sql",
  "023_blocks_parent_page_integrity.sql",
  "024_auth_session_revocation.sql",
  "026_page_custom_icons.sql",
  "027_page_version_history.sql",
  "028_blocks_gantt_type.sql",
  "029_blocks_timetable_type.sql",
  "030_account_login_lockout.sql",
  "031_blocks_video_type.sql",
  "032_blocks_toggle_type.sql",
  "034_user_theme_preference.sql",
  "035_page_covers.sql",
  "041_custom_icon_files.sql",
  "042_custom_icon_library_removals.sql",
  "043_navigation_collapse_preferences.sql",
  "045_country_login_access_policy.sql",
  "046_vpn_access_policy.sql",
  "048_blocks_list_types.sql",
  "049_navigation_page_order.sql",
  "050_totp_ip_permanent_block.sql",
  "053_blocks_accordion_type.sql",
  "054_blocks_treeview_type.sql",
  "060_attachment_storage_generation.sql",
  "061_page_share_generation.sql",
  "064_page_parent_owner_integrity.sql",
  "065_blocks_mermaid_type.sql",
  "066_blocks_heading_4_5_types.sql",
  "067_page_comments.sql",
  "068_collection_sharing.sql",
  "070_page_comment_edit_versions.sql",
  "077_custom_icon_tenant_identity.sql",
  "079_security_assessment_remediation.sql",
  // Registration approval is security state; it is never imported from a backup.
  "080_registration_approval.sql"
];

const createTablePattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+`?([A-Za-z0-9_]+)`?/gi;

async function migrationSources() {
  const names = (await readdir(migrationsDir))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  return Promise.all(names.map(async (name) => ({
    name,
    source: await readFile(new URL(name, migrationsDir), "utf8")
  })));
}

test("every created database table has an explicit backup-scope classification", async () => {
  const createdTables = new Set();
  for (const { source } of await migrationSources()) {
    createTablePattern.lastIndex = 0;
    for (const match of source.matchAll(createTablePattern)) createdTables.add(match[1]);
  }

  assert.deepEqual(
    [...createdTables].sort(),
    [...tableScope.keys()].sort(),
    "A database table was added or removed without reviewing its backup/restore scope. "
      + "Classify the table here and add/adjust data-transfer coverage before accepting the schema change."
  );
});

test("portable-table DDL cannot change without an explicit backup contract review", async () => {
  const portableTables = [...tableScope]
    .filter(([, scope]) => scope === "portable" || scope === "portable-profile-subset")
    .map(([name]) => name);

  const ddlPatterns = portableTables.map((tableName) => new RegExp(
    String.raw`\b(?:CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?|ALTER\s+TABLE|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|RENAME\s+TABLE)\s+\x60?${tableName}\x60?\b`,
    "i"
  ));

  const touched = [];
  for (const { name, source } of await migrationSources()) {
    if (ddlPatterns.some((pattern) => pattern.test(source))) touched.push(name);
  }

  assert.deepEqual(
    touched,
    reviewedPortableDdlMigrations,
    "A migration changed a portable workspace table after the backup contract was last reviewed. "
      + "Verify export + validation + import + round-trip tests first, then update this reviewed migration list."
  );
});
