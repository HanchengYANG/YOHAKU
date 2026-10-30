import test from "node:test";
import assert from "node:assert/strict";
import { createOperationQueue } from "../server/ai/operation-queue.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test("共享执行名额按步骤轮换后台和交互请求，连续提问不会饿死后台", async () => {
  const queue = createOperationQueue(), started = deferred(), release = deferred();
  const calls = [];
  const first = queue.run(async () => {
    calls.push("background-1"); started.resolve(); await release.promise;
  }, { priority: "background" });
  await started.promise;
  const background2 = queue.run(() => calls.push("background-2"), { priority: "background" });
  const background3 = queue.run(() => calls.push("background-3"), { priority: "background" });
  const foreground1 = queue.run(() => calls.push("foreground-1"));
  const foreground2 = queue.run(() => calls.push("foreground-2"));
  assert.deepEqual(calls, ["background-1"]);
  release.resolve();
  await Promise.all([first, background2, background3, foreground1, foreground2]);
  assert.deepEqual(calls, ["background-1", "foreground-1", "background-2", "foreground-2", "background-3"]);
});

test("排队中的页面请求断开后移除，当前后台步骤继续且失败释放名额", async () => {
  const queue = createOperationQueue(), started = deferred(), release = deferred();
  const first = queue.run(async () => { started.resolve(); await release.promise; throw new Error("上游失败"); });
  const firstRejected = assert.rejects(first, /上游失败/);
  await started.promise;
  const controller = new AbortController();
  let cancelledRan = false;
  const cancelled = queue.run(() => { cancelledRan = true; }, { signal: controller.signal });
  const cancellation = assert.rejects(cancelled, { name: "AbortError" });
  controller.abort();
  const second = queue.run(() => "continued", { priority: "background" });
  release.resolve();
  await Promise.all([firstRejected, cancellation]);
  assert.equal(await second, "continued");
  assert.equal(cancelledRan, false);
});

test("停服拒绝等待项并等待当前步骤收束；非等待的授权操作忙时拒绝", async () => {
  const queue = createOperationQueue(), started = deferred(), release = deferred();
  const active = queue.run(async () => { started.resolve(); await release.promise; });
  await started.promise;
  await assert.rejects(queue.run(() => {}, { wait: false }), (error) => error.code === "AI_BUSY");
  const pending = queue.run(() => assert.fail("停服后不应执行等待项"));
  const rejected = assert.rejects(pending, (error) => error.code === "AI_STOPPED");
  queue.close();
  await rejected;
  await assert.rejects(queue.run(() => {}), (error) => error.code === "AI_STOPPED");
  let idle = false;
  const settled = queue.whenIdle().then(() => { idle = true; });
  await Promise.resolve();
  assert.equal(idle, false);
  release.resolve();
  await Promise.all([active, settled]);
  assert.equal(idle, true);
});
