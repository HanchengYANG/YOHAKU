// Teardown for the isolated browser database only. Product task deletion is
// deliberately restricted to error-paused work and must not be relaxed for tests.
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export function discardFixtureTasks(ids) {
  const owned = [...ids];
  if (!owned.length) return;
  const database = new DatabaseSync(fileURLToPath(new URL("../../artifacts/ai-e2e-data/yohaku.sqlite", import.meta.url)));
  let transactionOpen = false;
  try {
    database.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
    transactionOpen = true;
    const invalidate = database.prepare("UPDATE image_task_items SET attempt_token=NULL WHERE task_id=?");
    const discard = database.prepare("UPDATE image_tasks SET deleted_at=?,version=version+1 WHERE id=? AND deleted_at IS NULL");
    const at = new Date().toISOString();
    for (const id of owned) {
      if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid isolated fixture task ID");
      invalidate.run(id);
      discard.run(at, id);
    }
    database.exec("COMMIT");
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) database.exec("ROLLBACK");
    throw error;
  } finally { database.close(); }
}
