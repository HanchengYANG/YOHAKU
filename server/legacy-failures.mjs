import { LEGACY_FAILURE, parseFailure } from "../shared/error-codes.mjs";

const MIGRATION_KEY = "legacy_failures_migrated_v1";
const legacy = (value) => typeof value === "string" && value !== "" && value !== LEGACY_FAILURE && !parseFailure(value);
const hasTable = (database, name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function rewriteColumn(database, table, column) {
  if (!hasTable(database, table)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all())
    if (legacy(row.value)) update.run(LEGACY_FAILURE, row.id);
}

function rewriteJson(database, table, column, mutate) {
  if (!hasTable(database, table)) return;
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
  if (database.prepare("SELECT 1 FROM app_settings WHERE key=?").get(MIGRATION_KEY)) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of [["article_sources", "error"], ["source_steps", "error"], ["conversations", "last_error"], ["image_tasks", "blocked_reason"]])
      rewriteColumn(database, table, column);
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
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}
