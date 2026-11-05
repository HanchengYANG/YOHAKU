import test from "node:test";
import assert from "node:assert/strict";
import * as presentation from "../client/image-tasks.mjs";
const {pendingLocalEntries,newerTask,taskActions,taskCounts,taskDisplayName,taskDuration,taskImageUrl,taskItemState,taskSegmentationState,taskStateLabel,taskStepState,taskSummary,taskTypeLabel}=presentation;

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

test("任务名包含本地创建时间、书籍目标和用户标题，标题重复只显示一次", () => {
  const task = { id: "abc12345-1234-4321-8765-abcdef012345", createdAt: new Date(2026, 9, 30, 21, 35, 7).toISOString(), bookTitle: "日本語", targetTitle: "第一章", title: "第一章" };
  assert.equal(taskDisplayName(task), "2026-10-30 21:35:07 · 日本語 · 第一章 · #abc12345");
  assert.equal(task.title, "第一章");
});

test("无标题任务回退到首张文件名和张数，空草稿只显示时间与短编号", () => {
  const task = { id: "87654321-aaaa-bbbb-cccc-ddddeeeeffff", createdAt: new Date(2026, 9, 30, 21, 35, 7).toISOString(), items: [{ name: "page-1.png" }, { name: "page-2.png" }] };
  assert.equal(taskDisplayName(task), "2026-10-30 21:35:07 · page-1.png · 2 张 · #87654321");
  assert.equal(taskDisplayName({ ...task, items: [] }), "2026-10-30 21:35:07 · #87654321");
  assert.match(taskDisplayName({ ...task, newBookTitle: "新书" }), /新书/);
  assert.doesNotMatch(taskDisplayName({ ...task, newBookTitle: "新书" }), /page-1/);
});

test("暂停任务显示可恢复状态且计时停止增长", () => {
  const task = { state: "paused", startedAt: "2026-10-30T10:00:00Z", updatedAt: "2026-10-30T10:01:10Z" };
  assert.equal(taskStateLabel(task), "已暂停");
  assert.equal(taskDuration(task, Date.parse("2026-10-30T12:00:00Z")), "1 分 10 秒");
});

test("全部图片完成后整批分句仍属于处理中，不显示待校对", () => {
  const task = { state: "running", phase: "segment", counts: { total: 2, completed: 2 }, segmentation: { state: "running" } };
  assert.equal(taskCounts(task).completed, 2);
  assert.equal(taskStateLabel(task), "整批分句中");
  assert.deepEqual(taskSegmentationState(task), { status: "正在整批分句，请稍候", statusKind: "working" });
  assert.match(taskItemState({ hasAnnotation: true }).status, /识别与注音已完成/);
  assert.equal(taskStateLabel({ ...task, state: "ready", phase: null, segmentation: { state: "succeeded" } }), "待校对");
});

test("整批分句失败单独提示结果保留，保存后的归档任务不再显示分句进度", () => {
  const task = { state: "needs_attention", phase: "segment", segmentation: { state: "failed", error: "超时" } };
  assert.equal(taskStateLabel(task), "分句待处理");
  assert.deepEqual(taskSegmentationState(task), { status: "整批分句未完成，识别与注音结果已保留", statusKind: "error" });
  assert.equal(taskStateLabel({ ...task, appliedDocumentId: "saved" }), "已保存");
  assert.equal(taskSegmentationState({ ...task, appliedDocumentId: "saved" }), null);
});

test("统一任务区分依赖等待、资源排队、超时与完成", () => {
  assert.equal(taskStateLabel({type:"preparation",status:"dependency_wait"}), "等待依赖");
  assert.equal(taskStateLabel({type:"preparation",status:"queued"}), "资源排队中");
  assert.equal(taskStateLabel({type:"preparation",status:"timeout"}), "已超时");
  assert.equal(taskStateLabel({type:"import",status:"completed",archived:true}), "已完成 · 已归档");
  assert.equal(taskTypeLabel({type:"import"}), "文件与文字导入");
  assert.equal(taskTypeLabel({type:"preparation"}), "正文准备");
  assert.deepEqual(taskStepState({status:"requires_review"}), {status:"待人工核对",statusKind:"review"});
  assert.deepEqual(taskStepState({status:"timeout"}), {status:"已超时",statusKind:"error"});
  assert.equal(taskSummary({type:"preparation",progress:{completed:2,total:4}}), "已完成 2 / 4 个步骤");
  assert.equal(taskSummary({type:"import",progress:{completed:15,total:126,unit:"page"}}), "已完成 15 / 126 页");
  assert.equal(taskStateLabel({type:"image",state:"needs_attention",status:"running",steps:[{id:"manual:image",status:"running"}]}),"手动注音中");
});

test("任务操作服从服务端能力，运行中与已归档任务始终隐藏删除", () => {
  assert.deepEqual(taskActions({status:"failed",canRetry:true,canDelete:true}), {retry:true,delete:true});
  assert.deepEqual(taskActions({status:"running",canRetry:true,canDelete:true}), {retry:false,delete:false});
  assert.deepEqual(taskActions({status:"queued",canDelete:true}), {retry:false,delete:false});
  assert.deepEqual(taskActions({status:"completed",archived:true,canDelete:true}), {retry:false,delete:false});
  assert.deepEqual(taskActions({status:"timeout"}), {retry:false,delete:false});
});

test("超时与完成任务的耗时不会随轮询继续增长", () => {
  const task = {type:"preparation",status:"timeout",createdAt:"2026-11-04T10:00:00Z",startedAt:"2026-11-04T10:01:00Z",updatedAt:"2026-11-04T10:04:00Z"};
  assert.equal(taskDuration(task,Date.parse("2026-11-04T12:00:00Z")),"3 分 0 秒");
  assert.equal(taskDuration({...task,status:"completed",completedAt:"2026-11-04T10:02:30Z"},Date.parse("2026-11-04T12:00:00Z")),"1 分 30 秒");
});
