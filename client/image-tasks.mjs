const labels = {
  draft: "待提交", queued: "排队中", running: "处理中", blocked: "等待恢复",
  needs_attention: "有图片待处理", ready: "待校对", cancelled: "已停止",
};

export function taskStateLabel(task) {
  return task?.appliedDocumentId ? "已保存" : labels[task?.state] || "正在读取";
}

export function taskItemState(item) {
  const recognized = !!(item.hasRecognition || item.recognized || item.recognition);
  const annotated = !!(item.hasAnnotation || item.annotated || item.annotation);
  if (item.error || item.status === "failed") return { status: recognized ? "注音未完成 · 正文已保留" : "识别未完成 · 可手动录入", statusKind: "error" };
  if (annotated) return { status: "已完成", statusKind: "done" };
  if (item.status === "running") return { status: item.phase === "annotate" ? "生成注音" : item.phase === "prepare" ? "保存方向" : "识别正文", statusKind: "working" };
  if (recognized) return { status: "正文已保留", statusKind: "retained" };
  return { status: item.imageId ? "原图已上传" : "等待上传", statusKind: "pending" };
}

export function newerTask(current, incoming) {
  if (current?.id === incoming?.id && Number(current.version) > Number(incoming.version)) return current;
  return incoming;
}

export function taskCounts(task) {
  const items = task?.items || [];
  return {
    total: task?.counts?.total ?? items.length,
    uploaded: task?.counts?.uploaded ?? items.filter((item) => item.imageId).length,
    completed: task?.counts?.completed ?? items.filter((item) => item.hasAnnotation || item.annotated || item.annotation).length,
    failed: task?.counts?.failed ?? items.filter((item) => item.error || item.status === "failed").length,
  };
}

export function taskDuration(task, now = Date.now()) {
  const start = Date.parse(task?.startedAt || task?.submittedAt || task?.createdAt);
  if (!Number.isFinite(start)) return "";
  const end = ["ready", "needs_attention", "cancelled"].includes(task?.state) ? Date.parse(task.completedAt || task.updatedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(end) ? end : now) - start) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export const taskImageUrl = (item) => item.imageId ? `/api/images/${encodeURIComponent(item.imageId)}/raw` : null;

export function pendingLocalEntries(entries, task) {
  return [...entries].filter((entry) => !(task?.items || []).some((item) => item.id === entry.id && item.imageId));
}
