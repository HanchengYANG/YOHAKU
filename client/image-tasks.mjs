const labels = {
  draft: "待提交", queued: "排队中", running: "处理中", blocked: "等待恢复",
  needs_attention: "有图片待处理", ready: "待校对", paused: "已暂停", cancelled: "已停止",
};
const unifiedLabels = {draft:"待确认导入",dependency_wait:"等待依赖",retry_wait:"等待自动重试",resource_wait:"资源排队中",waiting:"等待依赖",queued:"资源排队中",running:"执行中",requires_review:"待人工核对",needs_attention:"待人工处理",failed:"失败",timeout:"已超时",completed:"已完成",succeeded:"已完成",done:"已完成",ready:"待人工核对",interrupted:"执行已中断",cancelled:"已停止",blocked:"等待恢复"};
export const taskStatus = (task) => task?.status || task?.state;
export const isImageTask = (task) => !task?.type || task.type === "image";
export const taskManualAnnotationStep = (task) => task?.steps?.find(step=>String(step.id || "").startsWith("manual:") && ["queued","running"].includes(taskStatus(step)));
export function taskTypeLabel(task) {
  return {image:"图片导入",import:"文件与文字导入",preparation:"正文准备"}[task?.type] || "图片导入";
}
export function taskActions(task) {
  const executing = ["queued","running","dependency_wait","waiting","retry_wait"].includes(taskStatus(task));
  const finished = task?.archived || task?.appliedDocumentId || ["completed","succeeded"].includes(taskStatus(task));
  return {retry:!!task?.canRetry && !executing && !finished,delete:!!task?.canDelete && !executing && !finished};
}
export function taskStepState(step) {
  const state = taskStatus(step);
  return {status:unifiedLabels[state] || labels[state] || "等待处理",statusKind:["failed","timeout","interrupted"].includes(state) ? "error" : ["completed","succeeded","done"].includes(state) ? "done" : ["running","queued","retry_wait","resource_wait"].includes(state) ? "working" : ["requires_review","ready"].includes(state) ? "review" : "pending"};
}
export function taskSummary(task) {
  if (!isImageTask(task)) {
    const {completed = 0,total = 0,unit}=task?.progress || {};
    return total ? `已完成 ${completed} / ${total} ${unit === "page" ? "页" : "个步骤"}` : task?.message || "原始资料与成功结果已保存";
  }
  const counts=taskCounts(task);
  return task.state === "draft" ? `已上传 ${counts.uploaded} / ${counts.total} 张` : `共 ${counts.total} 张 · 识别与注音完成 ${counts.completed} 张${counts.failed ? ` · ${counts.failed} 张待处理` : ""}`;
}

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
  if (!isImageTask(task)) {
    const label = unifiedLabels[taskStatus(task)] || "等待处理";
    return task?.archived ? `${label} · 已归档` : label;
  }
  if (task?.appliedDocumentId) return "已保存";
  const manual=taskManualAnnotationStep(task);
  if(manual)return taskStatus(manual)==="queued" ? "手动注音排队中" : "手动注音中";
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
  const end = task?.archived || ["ready", "needs_attention", "paused", "cancelled", "failed", "timeout", "completed", "succeeded", "requires_review", "interrupted"].includes(taskStatus(task)) ? Date.parse(task.completedAt || task.updatedAt) : now;
  const seconds = Math.max(0, Math.floor(((Number.isFinite(end) ? end : now) - start) / 1000));
  return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export const taskImageUrl = (item) => item.imageId ? `/api/images/${encodeURIComponent(item.imageId)}/raw` : null;

export function pendingLocalEntries(entries, task) {
  return [...entries].filter((entry) => !(task?.items || []).some((item) => item.id === entry.id && item.imageId));
}

// Task list rows (§5.1): the task's own title, one sentence and one action.
export function taskTitle(task) {
  const names = [...new Set([task?.bookTitle || task?.newBookTitle, task?.targetTitle, task?.title].map((value) => String(value || "").trim()).filter(Boolean))];
  if (!names.length && task?.items?.length) names.push(`${task.items[0].name} · ${taskCounts(task).total} 张`);
  return names.join(" · ") || "未命名任务";
}
// The article or book an archived task produced, when it can be opened.
export function taskResult(task) {
  const bookId = task?.type === "import" && task.archived && task.resultKind === "book" ? task.bookId : null;
  const documentId = task?.appliedDocumentId || (task?.archived && task.canOpenResult ? task.documentId : null);
  return bookId ? { bookId } : documentId ? { documentId } : null;
}
export function taskRowStatus(task) {
  const status = taskStatus(task);
  // An archived import whose result was deleted says so instead of "已完成".
  if (task?.archived && !taskResult(task) && task.message) return task.message;
  if (task?.archived || task?.appliedDocumentId || ["completed", "succeeded", "done"].includes(status)) return "已完成";
  if (status === "draft") return isImageTask(task) ? "上传未完成" : "导入未完成";
  if (["failed", "timeout", "interrupted", "needs_attention", "blocked"].includes(status)) return "出错了";
  if (["requires_review", "ready"].includes(status)) return "需要核对";
  if (status === "running") {
    const { completed = 0, total = 0, unit } = task?.progress || {};
    return total ? `正在处理 · ${completed} / ${total} ${unit === "page" ? "页" : "步"}` : "正在处理";
  }
  return "等待处理";
}
export function taskRowAction(task) {
  if (taskStatus(task) === "draft") return { kind: "continue", label: "继续" };
  if (taskActions(task).retry && ["failed", "timeout", "interrupted", "needs_attention", "blocked"].includes(taskStatus(task))) return { kind: "retry", label: "重试" };
  if (taskResult(task)) return { kind: "open", label: "打开" };
  return { kind: "view", label: "查看" };
}
