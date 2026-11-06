// tests/task-attention.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { taskAttention } from "../shared/task-attention.mjs";

test("失败、待确认和未完成草稿需要处理，排队与运行中算准备中", () => {
  for (const status of ["failed", "timeout", "timed_out", "needs_attention", "blocked", "error", "interrupted", "requires_review", "needs_review", "draft"])
    assert.equal(taskAttention({ status }), "attention", status);
  for (const status of ["queued", "running", "retrying", "retry_wait", "resource_wait", "waiting_resource"])
    assert.equal(taskAttention({ status }), "working", status);
  for (const status of ["completed", "dependency_wait", "paused", "cancelled", undefined])
    assert.equal(taskAttention({ status }), null, String(status));
});

test("已归档的任务不算，只有 state 时按 state 判断", () => {
  assert.equal(taskAttention({ status: "failed", archived: true }), null);
  assert.equal(taskAttention({ state: "draft" }), "attention");
  assert.equal(taskAttention(null), null);
});
