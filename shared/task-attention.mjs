// shared/task-attention.mjs
// Decides whether a task needs the reader (failed, waiting for confirmation or
// an unfinished draft) or is still working by itself. The server counts the
// first kind for the sidebar and home; the book page maps both onto articles.
const attentionStatuses = new Set([
  "failed", "timeout", "timed_out", "needs_attention", "blocked", "error",
  "interrupted", "requires_review", "needs_review", "draft",
]);
// Also the server's list of task states that are still running (server/tasks.mjs).
export const workingStatuses = new Set([
  "queued", "running", "retrying", "retry_wait", "resource_wait", "waiting_resource",
]);
// Legacy image-task states "paused" and "cancelled" are no longer written, so they count as neither.

export function taskAttention(task) {
  if (!task || task.archived) return null;
  const status = task.status || task.state;
  if (attentionStatuses.has(status)) return "attention";
  if (workingStatuses.has(status)) return "working";
  return null;
}
