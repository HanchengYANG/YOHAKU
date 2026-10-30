const labels = {
  draft: "待提交", queued: "排队中", running: "处理中", blocked: "等待恢复",
  needs_attention: "有图片待处理", ready: "待校对", paused: "已暂停", cancelled: "已停止",
};

export const imageTasksChangedEvent = "image-tasks-changed";

export function notifyImageTasksChanged() {
  window.dispatchEvent(new Event(imageTasksChangedEvent));
}

export function taskDisplayName(task) {
  if (!task) return "";
  const created = new Date(task.createdAt), pad = (number) => String(number).padStart(2, "0");
  const date = Number.isFinite(created.getTime())
    ? `${created.getFullYear()}-${pad(created.getMonth() + 1)}-${pad(created.getDate())} ${pad(created.getHours())}:${pad(created.getMinutes())}:${pad(created.getSeconds())}` : "";
  const names = [...new Set([task.bookTitle || task.newBookTitle, task.targetTitle, task.title].map((value) => String(value || "").trim()).filter(Boolean))];
  if (!names.length && task.items?.length) names.push(`${task.items[0].name} · ${taskCounts(task).total} 张`);
  const shortId = String(task.id || "").replace(/[^a-z0-9]/gi, "").slice(0, 8);
  return [date, ...names, shortId && `#${shortId}`].filter(Boolean).join(" · ");
}

export function taskStateLabel(task) {
  if (task?.appliedDocumentId) return "已保存";
  if (task?.phase === "segment") {
    if (task.state === "needs_attention") return "分句待处理";
    if (task.state === "blocked") return "分句等待恢复";
    if (["queued", "running"].includes(task.state)) return "整批分句中";
  }
  return labels[task?.state] || "正在读取";
}

export function taskSegmentationState(task) {
  const step = task?.segmentation;
  if (!step || task.appliedDocumentId) return null;
  if (step.state === "succeeded") return { status: "整批分句已完成", statusKind: "done" };
  if (step.state === "failed") return { status: "整批分句未完成，识别与注音结果已保留", statusKind: "error" };
  if (task.phase !== "segment") return { status: "整批分句：等待识别与注音完成", statusKind: "pending" };
  return { status: step.state === "running" ? "正在整批分句，请稍候" : "等待整批分句，图片识别与注音已完成", statusKind: "working" };
}

export function taskItemState(item) {
  const recognized = !!(item.hasRecognition || item.recognized || item.recognition);
  const annotated = !!(item.hasAnnotation || item.annotated || item.annotation);
  if (item.error || item.status === "failed") return { status: recognized ? "注音未完成 · 正文已保留" : "识别未完成 · 可手动录入", statusKind: "error" };
  if (annotated) return { status: "识别与注音已完成", statusKind: "done" };
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
  const end = ["ready", "needs_attention", "paused", "cancelled"].includes(task?.state) ? Date.parse(task.completedAt || task.updatedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(end) ? end : now) - start) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export const taskImageUrl = (item) => item.imageId ? `/api/images/${encodeURIComponent(item.imageId)}/raw` : null;

export function pendingLocalEntries(entries, task) {
  return [...entries].filter((entry) => !(task?.items || []).some((item) => item.id === entry.id && item.imageId));
}
