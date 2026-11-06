import { LEGACY_FAILURE, parseFailure } from "../shared/error-codes.mjs";

const MIGRATION_KEY = "legacy_failures_migrated_v1";
const legacy = (value) => typeof value === "string" && value !== "" && value !== LEGACY_FAILURE && !parseFailure(value);
const hasTable = (database, name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
const hasColumn = (database, table, name) => Boolean(database.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name=?").get(table, name));

// `only` limits the rewrite to failed rows, because the same column can hold
// other text (article_sources.error also stores review reasons). Without the
// status column the rows cannot be told apart, so the table is left alone.
function rewriteColumn(database, table, column, only = null) {
  if (!hasTable(database, table) || !hasColumn(database, table, column)) return;
  if (only && !hasColumn(database, table, only.column)) return;
  const filter = only ? ` AND ${only.column} IN (${only.values.map(() => "?").join(",")})` : "";
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL${filter}`).all(...(only?.values ?? [])))
    if (legacy(row.value)) update.run(LEGACY_FAILURE, row.id);
}

const COLUMNS = [
  ["article_sources", "error", { column: "status", values: ["failed"] }],
  ["source_steps", "error", { column: "status", values: ["failed", "stale"] }],
  ["source_step_attempts", "message", { column: "state", values: ["failed"] }],
  ["conversations", "last_error"],
  ["image_tasks", "blocked_reason"],
];

function rewriteJson(database, table, column, mutate) {
  if (!hasTable(database, table) || !hasColumn(database, table, column)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all()) {
    let value;
    try { value = JSON.parse(row.value); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const before = JSON.stringify(value);
    mutate(value);
    const after = JSON.stringify(value);
    if (after !== before) update.run(after, row.id);
  }
}

const clean = (holder, key = "error") => { if (holder && legacy(holder[key])) holder[key] = LEGACY_FAILURE; };

export function migrateLegacyFailures(database) {
  if (!hasTable(database, "app_settings")) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    // Checked under the write lock so two processes cannot both migrate.
    if (database.prepare("SELECT 1 FROM app_settings WHERE key=?").get(MIGRATION_KEY)) {
      database.exec("COMMIT");
      return false;
    }
    for (const [table, column, only] of COLUMNS) rewriteColumn(database, table, column, only);
    rewriteJson(database, "image_tasks", "segmentation_json", (step) => clean(step));
    rewriteJson(database, "image_task_items", "steps_json", (steps) => { for (const step of Object.values(steps)) clean(step); });
    rewriteJson(database, "import_drafts", "draft_json", (draft) => {
      clean(draft, "chapterError");
      clean(draft.chapterProcessing);
      clean(draft.inspectionProcessing);
      for (const file of Array.isArray(draft.files) ? draft.files : []) { clean(file?.info); clean(file?.inspection); }
    });
    database.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run(MIGRATION_KEY, new Date().toISOString());
    database.exec("COMMIT");
    return true;
  } catch (error) {
    // SQLite may already have rolled back on its own (for example SQLITE_FULL).
    if (database.isTransaction) database.exec("ROLLBACK");
    throw error;
  }
}
