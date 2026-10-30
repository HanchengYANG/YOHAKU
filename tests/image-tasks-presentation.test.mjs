import test from "node:test";
import assert from "node:assert/strict";
import { pendingLocalEntries, newerTask, taskCounts, taskDuration, taskImageUrl, taskItemState, taskStateLabel } from "../client/image-tasks.mjs";

test("任务视图忽略迟到的旧版本，同账号新任务仍可切换", () => {
  const current = { id: "same", version: 5, state: "ready" };
  assert.equal(newerTask(current, { id: "same", version: 4, state: "running" }), current);
  assert.deepEqual(newerTask(current, { id: "other", version: 1 }), { id: "other", version: 1 });
  assert.equal(taskStateLabel({ ...current, appliedDocumentId: "document" }), "已保存");
  assert.equal(taskStateLabel({ state: "needs_attention" }), "有图片待处理");
});

test("识别失败与注音失败分别保留人工处理入口的状态含义", () => {
  assert.match(taskItemState({ status: "failed", error: "OCR失败" }).status, /手动录入/);
  const retained = taskItemState({ status: "failed", error: "注音失败", hasRecognition: true });
  assert.match(retained.status, /正文已保留/);
  assert.equal(retained.statusKind, "error");
  assert.equal(taskItemState({ hasAnnotation: true }).statusKind, "done");
  assert.equal(taskItemState({ status: "running", phase: "annotate" }).status, "生成注音");
});

test("无正文的列表摘要使用服务端计数，时间止于计算完成", () => {
  const task = { state: "ready", createdAt: "2026-10-30T10:00:00Z", completedAt: "2026-10-30T10:01:10Z", updatedAt: "2026-10-30T12:00:00Z", counts: { total: 3, uploaded: 3, completed: 2, failed: 1 } };
  assert.deepEqual(taskCounts(task), task.counts);
  assert.equal(taskDuration(task, Date.parse("2026-10-30T12:00:00Z")), "1 分 10 秒");
  assert.equal(taskImageUrl({ id: "pending" }), null);
  assert.equal(taskImageUrl({ imageId: "image id" }), "/api/images/image%20id/raw");
});

test("其他设备提交后只接续本机尚未获确认的新文件，不重新上传成功图片", () => {
  const uploaded = { id: "already", file: { name: "a.png" } }, pending = { id: "local", file: { name: "b.png" } };
  const task = { state: "queued", items: [{ id: "already", imageId: "server-image" }] };
  assert.deepEqual(pendingLocalEntries([uploaded, pending], task), [pending]);
  assert.deepEqual(pendingLocalEntries([uploaded, pending], null), [uploaded, pending]);
});
