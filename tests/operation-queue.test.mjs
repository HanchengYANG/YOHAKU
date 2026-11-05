import test from "node:test";
import assert from "node:assert/strict";
import { createOperationQueue } from "../server/ai/operation-queue.mjs";

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

test('当前阅读页与问答优先于预取，仍只占一个执行位', async () => {
  const queue = createOperationQueue(), started = deferred(), release = deferred(), order = [];
  const first = queue.run(async () => { started.resolve(); await release.promise; });
  await started.promise;
  const prefetch = queue.run(() => order.push('prefetch'), { priority: 'background' });
  const reading = queue.run(() => order.push('reading'), { priority: 'foreground' });
  const chat = queue.run(() => order.push('chat'), { priority: 'foreground' });
  release.resolve();
  await Promise.all([first, prefetch, reading, chat]);
  assert.deepEqual(order, ['reading', 'chat', 'prefetch']);
});

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

test('有界并发让其他文章越过慢任务，且单篇最多占两个名额', async () => {
  const queue = createOperationQueue({ concurrency: 4, maxPerGroup: 2 });
  const release = deferred(), calls = [];
  const jobs = ['a','a','a','b','c'].map((group, index) => queue.run(async () => {
    calls.push(index); await release.promise;
  }, { groupKey: group }));
  await new Promise(setImmediate);
  assert.deepEqual(calls, [0,3,4,1]);
  assert.equal(queue.status().activeCount, 4);
  release.resolve(); await Promise.all(jobs);
});

test('等待中的优先级跟随当前章节变化，连续三个前台后运行后台', async () => {
  const queue = createOperationQueue(), release = deferred(), started = deferred(), order = [];
  const first = queue.run(async () => { started.resolve(); await release.promise; }, { priority:'background' });
  await started.promise;
  let current = 'b';
  const jobs = ['a','b','b','b','b'].map((group,index) => queue.run(() => order.push(index), {
    groupKey:group, getPriority: () => group === current ? 'foreground' : 'background',
  }));
  current = 'b'; release.resolve(); await Promise.all([first,...jobs]);
  assert.deepEqual(order, [1,2,3,0,4]);
});

test('同优先级按文章轮转，执行超时释放名额且丢弃迟到结果', async () => {
  const queue = createOperationQueue(), release = deferred(), started = deferred(), order = [];
  const first = queue.run(async () => { started.resolve(); await release.promise; });
  await started.promise;
  const jobs = ['a','a','b','b'].map((group,index) => queue.run(() => order.push(index), { groupKey:group }));
  release.resolve(); await Promise.all([first,...jobs]);
  assert.deepEqual(order, [0,2,1,3]);
  const late = deferred(); let signal;
  const timeout = queue.run((execution) => { signal = execution.signal; return late.promise; }, { timeoutMs:20 });
  const rejected = assert.rejects(timeout, error => error.code === 'AI_TIMEOUT');
  const next = queue.run(() => 'next');
  await rejected;
  assert.equal(signal.aborted, true);
  assert.equal(await next, 'next');
  late.resolve('stale'); await queue.whenIdle();
});

test('等待特定资源不占执行名额，资源就绪后才开始超时',async()=>{
  const queue=createOperationQueue({concurrency:2}),calls=[];
  let available=false,reservations=0;
  const waiting=queue.run(()=>calls.push('owned-worker'),{canStart:()=>available,acquire:()=>{reservations++;return()=>reservations--;},timeoutMs:20});
  await queue.run(()=>calls.push('independent'));
  assert.deepEqual(calls,['independent']);
  assert.equal(queue.status().activeCount,0);
  await new Promise(resolve=>setTimeout(resolve,30));
  available=true;queue.refresh();await waiting;
  assert.deepEqual(calls,['independent','owned-worker']);
  assert.equal(reservations,0);
});


test('交互队列不会抢走连续三个前台后应给后台的机会',async()=>{
  const q=createOperationQueue(),release=deferred(),started=deferred(),order=[];
  const active=q.run(async()=>{started.resolve();await release.promise;},{priority:'background'});await started.promise;
  const jobs=[...Array.from({length:6},(_,i)=>q.run(()=>order.push(`f${i}`),{priority:'foreground'})),q.run(()=>order.push('interactive')),q.run(()=>order.push('background'),{priority:'background'})];
  release.resolve();await Promise.all([active,...jobs]);assert.deepEqual(order.slice(0,4),['f0','f1','f2','background']);
});
