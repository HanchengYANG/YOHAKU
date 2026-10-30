// Persistent task integration tests use real accounts, SQLite, image files and
// article routes. AI output is an explicit test double, never a live request.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { OCR_BODY_SCHEMA } from "../shared/ocr.mjs";
import { ANNOTATION_SCHEMA } from "../shared/ocr-correction.mjs";
import { SENTENCE_SCHEMA } from "../shared/sentences.mjs";
import { blocksToHtml, bodyRanges, bodyText, appendImageBodyHtml, hasCompleteSentenceBoundaries } from "../shared/article-html.mjs";
import { parseText, serializeBlocks } from "../shared/document.mjs";
import { cookieFromResponse, ensureSession } from "./helpers/session.mjs";

function fakeServices() {
  const state = { connected: true, calls: [], onRun: null, stop: null };
  const auth = {
    status: async () => ({ connected: state.connected, activeAccountId: "fixture-account", id: "fixture-account", subject: "fixture-subject" }),
    accounts: async () => ({ accounts: [], activeId: "fixture-account" }),
  };
  const runtime = {
    status: () => ({ busy: false, model: "task-fixture-model" }),
    stop: () => state.stop?.(),
    run: async (input) => {
      const phase = input.schema === OCR_BODY_SCHEMA ? "recognize" : input.schema === ANNOTATION_SCHEMA ? "annotate" : input.schema === SENTENCE_SCHEMA ? "segment" : "other";
      state.calls.push({ phase, input });
      await state.onRun?.(phase, input);
      let output = { text: "日本" };
      if (phase === "annotate") {
        const targets = JSON.parse(input.prompt.split("\n输入目标：\n").at(-1));
        output = { blocks: targets.map(({ text }) => ({ words: [{ t: text, r: "にほん" }] })) };
      }
      if (phase === "segment") output = { sentences: [JSON.parse(input.prompt.split("\n输入正文：\n").at(-1))] };
      return { completed: true, text: JSON.stringify(output), model: "task-fixture-model", reasoningEffort: "medium" };
    },
  };
  return { auth, runtime, state };
}

async function fixture(t, { runnerOptions = {} } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-image-tasks-")), injected = fakeServices();
  const clock = { value: Date.now() };
  let app, server, url, cookie;
  async function start() {
    app = createApp({ dataDir: directory, aiServices: injected,
      imageTaskOptions: { runnerOptions: { enabled: false, maxAutomaticRetries: 0, retryDelayMs: 1,
        blockedRetryMs: 10, now: () => clock.value, ...runnerOptions } } });
    server = app.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
    cookie = (await ensureSession(url)).cookie;
  }
  async function stop() {
    if (!app) return;
    app.close();
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    app = null;
  }
  await start();
  t.after(async () => { injected.state.stop?.(); await stop(); await rm(directory, { recursive: true, force: true }); });
  const pixels = await sharp({ create: { width: 4, height: 6, channels: 3, background: "white" } }).png().toBuffer();
  async function request(path, method = "GET", body, selectedCookie = cookie) {
    const response = await fetch(`${url}/api${path}`, { method,
      headers: { Cookie: selectedCookie, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    return { status: response.status, data: response.status === 204 ? null : await response.json(), response };
  }
  async function create(input = {}) {
    const result = await request("/image-tasks", "POST", { idempotencyKey: randomUUID(), title: "任务文章", ...input });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data;
  }
  async function add(task, names = ["one.png"]) {
    const result = await request(`/image-tasks/${task.id}/items`, "POST", {
      version: task.version, items: names.map((name) => ({ id: randomUUID(), name })),
    });
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  }
  async function upload(task, item = task.items[0], selectedCookie = cookie, data = pixels) {
    const body = new FormData(); body.append("image", new Blob([data], { type: "image/png" }), item.name);
    const response = await fetch(`${url}/api/image-tasks/${task.id}/items/${item.id}/image`, {
      method: "POST", headers: { Cookie: selectedCookie }, body, signal: AbortSignal.timeout(10000),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    return result;
  }
  async function prepared(count = 1, input) {
    let task = await add(await create(input), Array.from({ length: count }, (_, i) => `${i + 1}.png`));
    for (const item of task.items) task = await upload(task, item);
    return task;
  }
  async function get(id) { const result = await request(`/image-tasks/${id}`); assert.equal(result.status, 200); return result.data; }
  async function submit(task) {
    const result = await request(`/image-tasks/${task.id}/submit`, "POST", { version: task.version });
    assert.equal(result.status, 202, JSON.stringify(result.data)); return result.data;
  }
  async function freeze(task) {
    if (task.state === "draft") task = await submit(task);
    if (task.state === "queued") {
      // Enter manual fixtures through a real authorization error, never through
      // a public pause endpoint. This adds no fake model inference calls.
      const connected = injected.state.connected;
      injected.state.connected = false;
      try { task = await runUntil(task.id, "blocked"); }
      finally { injected.state.connected = connected; }
    }
    return request(`/image-tasks/${task.id}/cancel`, "POST", { version: task.version, freezeResult: true });
  }
  async function legacyPause(task, state = "paused") {
    // Compatibility fixtures seed tasks created by the previous release. New
    // clients cannot create these manual stop states through the API.
    const db = new DatabaseSync(join(directory, "yohaku.sqlite"));
    try { db.prepare("UPDATE image_tasks SET state=?,version=version+1,completed_at=coalesce(completed_at,?) WHERE id=?")
      .run(state, new Date(clock.value).toISOString(), task.id); }
    finally { db.close(); }
    return get(task.id);
  }
  async function runUntil(id, state, maximum = 30) {
    for (let i = 0; i < maximum; i++) {
      const current = await get(id);
      if (current.state === state) return current;
      clock.value += 20;
      await app.imageTasks.runNext();
    }
    assert.fail(`task did not reach ${state}: ${JSON.stringify(await get(id))}`);
  }
  return { get app() { return app; }, get url() { return url; }, get cookie() { return cookie; },
    directory, state: injected.state, clock, request, create, add, upload, prepared, get, submit, freeze, legacyPause, runUntil,
    restart: async () => { await stop(); await start(); },
    inspect: (work) => { const db = new DatabaseSync(join(directory, "yohaku.sqlite")); try { return work(db); } finally { db.close(); } } };
}

test("未提交草稿跨设备继续上传，保留目标与顺序并拒绝过期覆盖", async (t) => {
  const f = await fixture(t);
  let task = await f.prepared();
  const login = await f.request("/session/login", "POST", { username: "test_owner", password: "fixture-only-password" }, "");
  const deviceB = cookieFromResponse(login.response);
  const reopened = await f.request(`/image-tasks/${task.id}`, "GET", undefined, deviceB);
  assert.equal(reopened.data.items[0].imageId, task.items[0].imageId);
  const oldVersion = task.version;
  task = await f.add(task, ["device-b.png"]);
  task = await f.upload(task, task.items[1], deviceB);
  const changed = await f.request(`/image-tasks/${task.id}`, "PATCH", { version: task.version, itemOrder: [...task.items].reverse().map((item) => item.id) });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.items[0].name, "device-b.png");
  assert.equal((await f.request(`/image-tasks/${task.id}`, "PATCH", { version: oldVersion, title: "旧设备覆盖" })).status, 409);
  const id = task.id;
  await f.restart();
  task = await f.get(id);
  assert.equal(task.state, "draft");
  assert.equal(task.items.length, 2);
  assert.equal(task.items[0].name, "device-b.png");
  assert.equal(f.state.calls.length, 0);
});

test("提交与上传响应丢失可幂等重试，后台无需页面推进并保存独立结果", async (t) => {
  const f = await fixture(t);
  const key = randomUUID();
  const task = await f.create({ idempotencyKey: key });
  assert.equal((await f.request("/image-tasks", "POST", { idempotencyKey: key, title: "任务文章" })).data.id, task.id);
  assert.equal((await f.request("/image-tasks", "POST", { idempotencyKey: key, title: "其他输入" })).status, 409);
  let prepared = await f.add(task, ["first.png", "second.png"]);
  const firstItem = prepared.items[0];
  prepared = await f.upload(prepared, firstItem);
  const firstImage = prepared.items[0].imageId;
  prepared = await f.upload(prepared, firstItem);
  assert.equal(prepared.items[0].imageId, firstImage);
  assert.equal((await f.request(`/image-tasks/${task.id}/submit`, "POST", { version: prepared.version })).status, 400);
  prepared = await f.upload(prepared, prepared.items[1]);
  const submitted = await f.submit(prepared);
  assert.equal((await f.request(`/image-tasks/${task.id}/submit`, "POST", { version: prepared.version })).data.id, submitted.id);
  assert.equal((await f.request(`/images/${firstImage}/rotate`, "POST", { quarterTurns: 1, revision: 1 })).status, 409);
  const ready = await f.runUntil(task.id, "ready");
  assert.equal(ready.counts.completed, 2);
  assert.equal(f.state.calls.filter((item) => item.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((item) => item.phase === "annotate").length, 2);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM image_drafts").get().count), 0);
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(bodyText(result.bodyHtml), "日本日本");
  assert.deepEqual(result.sourceImages.map((image) => image.id), ready.items.map((item) => item.imageId));
  assert.ok(result.sourceImages[0].taskItemId);
  assert.equal(result.sourceImages[0].recognition.annotation.readingPolicy, "image_reference");
  const reloaded = await f.get(task.id);
  assert.equal(reloaded.resultVersion, ready.resultVersion);
});

test("单图注音失败继续后续图片，重试只补失败注音", async (t) => {
  const f = await fixture(t);
  let failFirst = true;
  f.state.onRun = async (phase) => { if (phase === "annotate" && failFirst) { failFirst = false; throw Object.assign(new Error("fixture annotation error"), { status: 502, expose: true }); } };
  let task = await f.submit(await f.prepared(3));
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(task.counts.recognized, 3);
  assert.equal(task.counts.completed, 2);
  assert.equal(task.counts.failed, 1);
  const callsBefore = f.state.calls.length;
  const retry = await f.request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version });
  assert.equal(retry.status, 202);
  task = await f.runUntil(task.id, "ready");
  assert.equal(f.state.calls.filter((call) => call.phase !== "segment").length - callsBefore, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase !== "segment").at(-1).phase, "annotate");
  assert.equal(task.counts.completed, 3);
});

test("识别全失败后可逐图手输并原子保存，重复并发采用只写一篇文章", async (t) => {
  const f = await fixture(t);
  f.state.onRun = async () => { throw Object.assign(new Error("fixture OCR failure"), { status: 502, expose: true }); };
  let task = await f.submit(await f.prepared(2));
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(task.counts.recognized, 0);
  const freeze = await f.freeze(task);
  assert.equal(freeze.status, 200);
  task = freeze.data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(result.sourceImages.length, 2);
  assert.equal(bodyText(result.bodyHtml), "");
  assert.ok(result.sourceImages.every((image) => image.recognition === null && image.manualRequired));
  const bodyHtml = result.sourceImages.map((image, index) => blocksToHtml(parseText(index ? "東京" : "{日本|にほん}"), { sourceImageId: image.id })).join("");
  const document = { ...result, bodyHtml, content: "{日本|にほん}\n東京" };
  const payload = { version: task.version, resultVersion: task.resultVersion, document };
  const saved = await Promise.all([f.request(`/image-tasks/${task.id}/apply`, "POST", payload), f.request(`/image-tasks/${task.id}/apply`, "POST", payload)]);
  assert.equal(saved[0].status, 200, JSON.stringify(saved[0].data));
  assert.equal(saved[1].status, 200, JSON.stringify(saved[1].data));
  assert.equal(saved[0].data.id, saved[1].data.id);
  assert.equal(saved[0].data.bodyHtml, saved[1].data.bodyHtml);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM documents").get().count), 1);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM image_drafts").get().count), 0);
  assert.deepEqual(bodyRanges(saved[0].data.bodyHtml).sources.map((source) => source.id), result.sourceImages.map((image) => image.id));
  assert.equal(saved[0].data.blocks[0].segments[0].origin, "manual");
  assert.equal((await f.get(task.id)).appliedDocumentId, saved[0].data.id);
});

test("服务重启保留识别checkpoint，旧注音尝试不能写回或触碰已关闭数据库", async (t) => {
  const f = await fixture(t);
  const task = await f.submit(await f.prepared());
  await f.app.imageTasks.runNext(); // prepare
  await f.app.imageTasks.runNext(); // OCR checkpoint
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.state.stop = release;
  f.state.onRun = async (phase) => { if (phase === "annotate") { entered(); await gate; } };
  const oldRun = f.app.imageTasks.runNext();
  await started;
  assert.equal((await f.get(task.id)).state, "running");
  await f.restart();
  f.state.onRun = null;
  release();
  await oldRun;
  const restored = await f.get(task.id);
  assert.equal(restored.items[0].hasRecognition, true);
  assert.equal(restored.items[0].hasAnnotation, false);
  const ready = await f.runUntil(task.id, "ready");
  assert.equal(ready.counts.completed, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 2);
});

test("方向已落盘但checkpoint中断时恢复不会重复旋转", async (t) => {
  const f = await fixture(t);
  let task = await f.prepared();
  task = (await f.request(`/image-tasks/${task.id}`, "PATCH", { version: task.version, itemDirections: { [task.items[0].id]: 1 } })).data;
  const rotate = f.app.ai.rotateImage;
  let rotations = 0;
  f.app.ai.rotateImage = async (...args) => { rotations++; await rotate(...args); throw Object.assign(new Error("fixture lost rotate reply"), { status: 502, expose: true }); };
  task = await f.submit(task);
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(rotations, 1);
  f.app.ai.rotateImage = rotate;
  const retry = await f.request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version });
  assert.equal(retry.status, 202);
  task = await f.runUntil(task.id, "ready");
  assert.equal(task.items[0].sourceImage.revision, 2);
  assert.equal(task.items[0].sourceImage.width, 6);
  assert.equal(rotations, 1);
});

test("共享授权失效进入blocked，恢复后只执行未完成步骤", async (t) => {
  const f = await fixture(t);
  f.state.connected = false;
  const task = await f.submit(await f.prepared());
  await f.app.imageTasks.runNext();
  await f.app.imageTasks.runNext();
  assert.equal((await f.get(task.id)).state, "blocked");
  assert.equal(f.state.calls.length, 0);
  f.state.connected = true;
  f.clock.value += 100;
  const ready = await f.runUntil(task.id, "ready");
  assert.equal(ready.counts.completed, 1);
  assert.equal(f.state.calls.filter((call) => call.phase !== "segment").length, 2);
});

test("任务列表、原图、结果与操作遵守网站账号隔离", async (t) => {
  const f = await fixture(t);
  const task = await f.prepared();
  const invitation = await f.request("/invitations", "POST", {});
  const registration = await f.request("/accounts/register", "POST", { username: "task_friend", password: "fixture-friend-password", inviteToken: invitation.data.token });
  assert.equal(registration.status, 201);
  const friend = cookieFromResponse(registration.response);
  assert.equal((await f.request("/image-tasks", "GET", undefined, friend)).data.total, 0);
  for (const [path, method, body] of [
    [`/image-tasks/${task.id}`, "GET"], [`/image-tasks/${task.id}/result`, "GET"],
    [`/image-tasks/${task.id}/submit`, "POST", { version: task.version }],
    [`/image-tasks/${task.id}/cancel`, "POST", { version: task.version, freezeResult: true }],
    [`/images/${task.items[0].imageId}/raw`, "GET"],
  ]) assert.equal((await f.request(path, method, body, friend)).status, 404);
});

test("任务批次逐步骤轮转，自动重试有上限且不重复成功结果", async (t) => {
  const f = await fixture(t, { runnerOptions: { maxAutomaticRetries: 2 } });
  const first = await f.submit(await f.prepared());
  const second = await f.submit(await f.prepared());
  f.state.onRun = async (phase) => { if (phase === "annotate") throw Object.assign(new Error("fixture temporary failure"), { status: 502, expose: true }); };
  await f.app.imageTasks.runNext();
  await f.app.imageTasks.runNext();
  assert.equal((await f.get(first.id)).items[0].steps.prepare.state, "succeeded");
  assert.equal((await f.get(second.id)).items[0].steps.prepare.state, "succeeded");
  await f.runUntil(first.id, "needs_attention", 40);
  await f.runUntil(second.id, "needs_attention", 40);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 6);
});

test("自主runner在提交设备退出登录后仍执行整批，另一登录会话能读取结果", async (t) => {
  const f = await fixture(t, { runnerOptions: { enabled: true, pollIntervalMs: 5 } });
  const task = await f.submit(await f.prepared(3));
  assert.equal((await f.request("/session/logout", "POST", {})).status, 204);
  // Read SQLite only: no browser status call or runNext() can advance the job.
  for (let i = 0; i < 150; i++) {
    if (f.inspect((db) => db.prepare("SELECT state FROM image_tasks WHERE id=?").get(task.id).state) === "ready") break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(f.inspect((db) => db.prepare("SELECT state FROM image_tasks WHERE id=?").get(task.id).state), "ready");
  const login = await f.request("/session/login", "POST", { username: "test_owner", password: "fixture-only-password" }, "");
  const deviceB = cookieFromResponse(login.response);
  const result = await f.request(`/image-tasks/${task.id}/result`, "GET", undefined, deviceB);
  assert.equal(result.status, 200);
  assert.equal(result.data.sourceImages.length, 3);
  assert.equal(f.state.calls.filter((call) => call.phase !== "segment").length, 6);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 1);
});

test("追加目标被其他设备修改时拒绝覆盖，刷新合并后采用只追加一次", async (t) => {
  const f = await fixture(t);
  const original = await f.request("/documents", "POST", { title: "已有文章", kind: "article", orientation: "horizontal", content: "原文" });
  assert.equal(original.status, 201);
  let task = await f.submit(await f.prepared(1, { targetId: original.data.id }));
  const changed = await f.request(`/documents/${original.data.id}`, "PUT", { ...original.data, content: "其他设备修改" });
  assert.equal(changed.status, 200);
  task = await f.runUntil(task.id, "ready");
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const stale = { ...original.data, bodyHtml: appendImageBodyHtml(original.data.bodyHtml, result.bodyHtml),
    sourceImages: result.sourceImages };
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", { version: task.version, resultVersion: task.resultVersion, document: stale })).status, 409);
  assert.equal((await f.get(task.id)).appliedDocumentId, null);
  const document = { ...changed.data, bodyHtml: appendImageBodyHtml(changed.data.bodyHtml, result.bodyHtml), sourceImages: result.sourceImages };
  const payload = { version: task.version, resultVersion: task.resultVersion, document };
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", payload);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(bodyText(saved.data.bodyHtml), "其他设备修改日本");
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", payload)).data.revision, saved.data.revision);
  assert.equal(saved.data.sourceImages.length, 1);
});

test("全局单图草稿被覆盖不影响任务快照及采用后的识别记录", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared());
  task = await f.runUntil(task.id, "ready");
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const imageId = result.sourceImages[0].id;
  f.inspect((db) => {
    const owner = db.prepare("SELECT user_id FROM image_owners WHERE image_id=?").get(imageId).user_id;
    db.prepare("INSERT INTO image_drafts(image_id,user_id,draft_json) VALUES(?,?,?)")
      .run(imageId, owner, JSON.stringify({ content: "错误覆盖", blocks: parseText("错误覆盖") }));
  });
  const restored = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(bodyText(restored.bodyHtml), "日本");
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion, document: restored,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.recognition.content, "日本");
});

test("手动录入正文可单独请求注音，不需要OCR草稿且不会改写固定结果", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const result = await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本", manualReadings: [],
  });
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.blocks[0].segments[0].reading, "にほん");
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM image_drafts").get().count), 0);
  const unchanged = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(bodyText(unchanged.bodyHtml), "");
  assert.equal((await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion + 1, content: "日本",
  })).status, 409);
});

test("新建书籍选中但尚未填名的草稿跨设备保留，提交前校验书名", async (t) => {
  const f = await fixture(t);
  let task = await f.prepared(1, { createNewBook: true, newBookTitle: "" });
  const id = task.id;
  await f.restart();
  task = await f.get(id);
  assert.equal(task.createNewBook, true);
  assert.equal(task.newBookTitle, "");
  assert.equal((await f.request(`/image-tasks/${id}/submit`, "POST", { version: task.version })).status, 400);
  task = (await f.request(`/image-tasks/${id}`, "PATCH", { version: task.version, newBookTitle: "新书" })).data;
  task = await f.submit(task);
  assert.equal(task.createNewBook, true);
  assert.equal(task.newBookTitle, "新书");
});

test("任务上传保留中文与日文文件名，不采用multipart解码后的乱码名", async (t) => {
  const f = await fixture(t);
  let task = await f.add(await f.create(), ["手动录入・日本語.png"]);
  task = await f.upload(task);
  assert.equal(task.items[0].name, "手动录入・日本語.png");
  assert.equal(task.items[0].sourceImage.originalName, "手动录入・日本語.png");
  task = (await f.freeze(task)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(result.sourceImages[0].sourceImage.originalName, "手动录入・日本語.png");
});

test("同一图片条目并发上传不同文件只接纳一个，晚到上传不能混入已提交批次", async (t) => {
  const f = await fixture(t);
  let task = await f.add(await f.create(), ["collision.png"]);
  const item = task.items[0], originalSave = f.app.ai.saveImage;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.app.ai.saveImage = async (...args) => { entered(); await gate; return originalSave(...args); };
  const red = await sharp({ create: { width: 4, height: 6, channels: 3, background: "red" } }).png().toBuffer();
  const blue = await sharp({ create: { width: 4, height: 6, channels: 3, background: "blue" } }).png().toBuffer();
  const send = (selectedTask, selectedItem, bytes) => {
    const body = new FormData(); body.append("image", new Blob([bytes], { type: "image/png" }), selectedItem.name);
    return fetch(`${f.url}/api/image-tasks/${selectedTask.id}/items/${selectedItem.id}/image`, {
      method: "POST", headers: { Cookie: f.cookie }, body, signal: AbortSignal.timeout(10000),
    });
  };
  const first = send(task, item, red);
  await started;
  const second = send(task, item, blue);
  release();
  const responses = await Promise.all([first, second]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  task = await f.get(task.id);
  assert.equal(task.counts.uploaded, 1);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM image_owners").get().count), 1);

  // Reserve another item, then let A remove it while B's bytes are in flight.
  task = await f.add(task, ["late.png"]);
  const lateItem = task.items[1];
  let releaseLate, enteredLate;
  const lateGate = new Promise((resolve) => { releaseLate = resolve; });
  const lateStarted = new Promise((resolve) => { enteredLate = resolve; });
  f.app.ai.saveImage = async (...args) => { enteredLate(); await lateGate; return originalSave(...args); };
  const late = send(task, lateItem, blue);
  await lateStarted;
  task = (await f.request(`/image-tasks/${task.id}`, "PATCH", { version: task.version, removeItemIds: [lateItem.id] })).data;
  task = await f.submit(task);
  releaseLate();
  assert.equal((await late).status, 409);
  const frozen = await f.get(task.id);
  assert.equal(frozen.items.length, 1);
  assert.equal(frozen.items[0].imageId, task.items[0].imageId);
  assert.equal((await f.request(`/image-tasks/${task.id}/items`, "POST", { version: task.version, items: [{ id: randomUUID(), name: "too-late.png" }] })).status, 409);
});

test("旧暂停任务转人工时作废旧AI尝试，迟到识别不覆盖人工草稿", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared());
  await f.app.imageTasks.runNext();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async () => { entered(); await gate; };
  f.state.stop = release;
  const currentRun = f.app.imageTasks.runNext();
  await started;
  task = await f.legacyPause(await f.get(task.id));
  const frozen = await f.freeze(task);
  assert.equal(frozen.status, 200);
  const before = (await f.request(`/image-tasks/${task.id}/result`)).data;
  release(); await currentRun;
  const after = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(after.taskResultVersion, before.taskResultVersion);
  assert.equal(bodyText(after.bodyHtml), "");
  assert.equal(after.sourceImages[0].recognition, null);
  assert.equal((await f.get(task.id)).state, "paused");
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 0);
});

test("图片方向写入与任务提交竞争时不能同时接纳两种输入版本", async (t) => {
  const f = await fixture(t);
  const task = await f.prepared();
  const ownerId = f.inspect((db) => db.prepare("SELECT user_id FROM image_tasks WHERE id=?").get(task.id).user_id);
  const rotation = f.app.ai.rotateImage(ownerId, task.items[0].imageId, { quarterTurns: 1, revision: 1 });
  const submission = f.request(`/image-tasks/${task.id}/submit`, "POST", { version: task.version });
  const [rotated, submitted] = await Promise.allSettled([rotation, submission]);
  assert.ok(rotated.status === "rejected" || submitted.value?.status === 409);
  if (rotated.status === "fulfilled") {
    assert.equal(rotated.value.revision, 2);
    assert.equal(submitted.value.status, 409);
    assert.equal((await f.get(task.id)).state, "draft");
  } else assert.equal(submitted.value.status, 202);
  assert.equal(f.state.calls.length, 0);
});

test("人工触发注音缓存最近三份服务器结果，去重且不改固定正文与任务版本", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const annotate = (content) => f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content, manualReadings: [],
  });
  for (const content of ["日本一", "日本一", "日本二", "日本三", "日本四"]) {
    const result = await annotate(content);
    assert.equal(result.status, 200, JSON.stringify(result.data));
  }
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(result.sourceImages[0].taskId, task.id);
  assert.equal(result.sourceImages[0].reviewAnnotations.length, 3);
  assert.deepEqual(result.sourceImages[0].reviewAnnotations.map((review) => bodyText(blocksToHtml(review.blocks))), ["日本二", "日本三", "日本四"]);
  assert.ok(result.sourceImages[0].reviewAnnotations.every((review) => review.annotation.model === "task-fixture-model" && Number.isFinite(review.annotation.elapsedMs)));
  assert.equal(bodyText(result.bodyHtml), "");
  assert.equal(result.sourceImages[0].recognition, null);
  assert.equal(result.taskResultVersion, task.resultVersion);
  assert.equal(result.taskVersion, task.version);
  const detail = await f.get(task.id);
  assert.equal(detail.items[0].reviewAnnotations, undefined);
  assert.equal(JSON.stringify(detail).includes("にほん"), false);
  const invitation = await f.request("/invitations", "POST", {});
  const registration = await f.request("/accounts/register", "POST", { username: "review_friend", password: "fixture-friend-password", inviteToken: invitation.data.token });
  const friend = cookieFromResponse(registration.response);
  assert.equal((await f.request(`/image-tasks/${task.id}/result`, "GET", undefined, friend)).status, 404);
  assert.equal((await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本",
  }, friend)).status, 404);
});

test("旧任务表迁移补充人工注音缓存，既有草稿与图片继续可读", async (t) => {
  const f = await fixture(t);
  const task = await f.prepared();
  f.inspect((db) => db.exec("ALTER TABLE image_task_items DROP COLUMN review_annotations_json"));
  await f.restart();
  assert.equal((await f.get(task.id)).items[0].imageId, task.items[0].imageId);
  assert.equal(f.inspect((db) => db.prepare("SELECT review_annotations_json FROM image_task_items WHERE task_id=?").get(task.id).review_annotations_json), "[]");
});

test("人工注音进行时已采用结果，迟到回复不能再写缓存或改变文章", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async () => { entered(); await gate; };
  f.state.stop = release;
  const pending = f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本", manualReadings: [],
  });
  await started;
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion,
    document: { ...result, bodyHtml: blocksToHtml(parseText("日本"), { sourceImageId: result.sourceImages[0].id }) },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  release();
  assert.equal((await pending).status, 409);
  const stored = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.deepEqual(stored.sourceImages[0].reviewAnnotations, []);
  assert.equal((await f.request(`/documents/${saved.data.id}`)).data.bodyHtml, saved.data.bodyHtml);
  assert.equal((await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本",
  })).status, 409);
});

test("手输正文成功注音采用时保存服务器记录，拒绝客户端伪造且不伪造OCR", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const annotated = await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本", manualReadings: [],
  });
  assert.equal(annotated.status, 200);
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const modelRecord = annotated.data.annotation;
  const bodyHtml = blocksToHtml(annotated.data.blocks, { sourceImageId: result.sourceImages[0].id });
  const forged = { ...annotated.data, annotation: { ...modelRecord, model: "CLIENT-FORGED-MODEL", elapsedMs: -1 } };
  const document = { ...result, bodyHtml, content: serializeBlocks(annotated.data.blocks),
    sourceImages: result.sourceImages.map((image) => ({ ...image, annotation: forged.annotation, reviewAnnotations: [forged] })) };
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion, document,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.sourceImages[0].recognition, null);
  assert.equal(saved.data.sourceImages[0].origin, "manual");
  assert.equal(saved.data.sourceImages[0].annotation.model, modelRecord.model);
  assert.equal(saved.data.sourceImages[0].annotation.elapsedMs, modelRecord.elapsedMs);
  assert.equal(saved.data.sourceImages[0].annotation.createdAt, modelRecord.createdAt);
  assert.equal(saved.data.sourceImages[0].reviewAnnotations, undefined);
  assert.equal(saved.data.sourceImages[0].manualRequired, false);
  const reopened = (await f.request(`/documents/${saved.data.id}`)).data;
  assert.equal(reopened.sourceImages[0].annotation.model, "task-fixture-model");
});

test("识别成功但自动注音失败后，人工重试成功的记录按实际正文采用", async (t) => {
  const f = await fixture(t);
  let fail = true;
  f.state.onRun = async (phase) => { if (phase === "annotate" && fail) throw Object.assign(new Error("fixture failed annotation"), { status: 502, expose: true }); };
  let task = await f.submit(await f.prepared());
  task = await f.runUntil(task.id, "needs_attention");
  task = (await f.freeze(task)).data;
  const before = (await f.request(`/image-tasks/${task.id}/result`)).data;
  fail = false;
  const reviewed = await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本", manualReadings: [],
  });
  assert.equal(reviewed.status, 200);
  const cached = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(cached.bodyHtml, before.bodyHtml);
  assert.equal(cached.sourceImages[0].recognition.annotation, undefined);
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion,
    document: { ...cached, bodyHtml: blocksToHtml(reviewed.data.blocks, { sourceImageId: cached.sourceImages[0].id }), content: reviewed.data.content },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.recognition.content, "日本");
  assert.equal(saved.data.recognition.annotation.model, reviewed.data.annotation.model);
  assert.equal(saved.data.recognition.annotation.createdAt, reviewed.data.annotation.createdAt);
  assert.equal(saved.data.recognition.blocks[0].segments[0].reading, null);
});

test("人工注音后又修改正文不采用不匹配的旧AI记录", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const reviewed = await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本", manualReadings: [],
  });
  assert.equal(reviewed.status, 200);
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion,
    document: { ...result, bodyHtml: blocksToHtml(parseText("日本語"), { sourceImageId: result.sourceImages[0].id }) },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.sourceImages[0].recognition, null);
  assert.equal(saved.data.sourceImages[0].annotation, undefined);
});

test("全失败只手输第一张时第二张保留待录入，重开普通编辑补齐后更新状态", async (t) => {
  const f = await fixture(t);
  f.state.onRun = async () => { throw Object.assign(new Error("fixture OCR failed"), { status: 502, expose: true }); };
  let task = await f.submit(await f.prepared(2));
  task = await f.runUntil(task.id, "needs_attention");
  task = (await f.freeze(task)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const firstBody = blocksToHtml(parseText("第一张手输正文"), { sourceImageId: result.sourceImages[0].id });
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion, document: { ...result, bodyHtml: firstBody },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.sourceImages[0].manualRequired, false);
  assert.equal(saved.data.sourceImages[1].manualRequired, true);
  assert.ok(saved.data.sourceImages.every((image) => image.recognition === null));
  const reopened = (await f.request(`/documents/${saved.data.id}`)).data;
  assert.equal(reopened.sourceImages[1].manualRequired, true);
  const completed = await f.request(`/documents/${reopened.id}`, "PUT", { ...reopened,
    bodyHtml: appendImageBodyHtml(reopened.bodyHtml, blocksToHtml(parseText("第二张补录正文"), { sourceImageId: reopened.sourceImages[1].id })),
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.data));
  assert.ok(completed.data.sourceImages.every((image) => image.manualRequired === false && image.origin === "manual"));
  assert.deepEqual(bodyRanges(completed.data.bodyHtml).sources.map((source) => source.id), result.sourceImages.map((image) => image.id));
});

test("失败任务禁止手动停止，稍后转人工保留实际处理结束时间", async (t) => {
  const f = await fixture(t);
  f.state.onRun = async () => { throw Object.assign(new Error("fixture invalid image text"), { status:400 }); };
  const task = await f.submit(await f.prepared());
  const failed = await f.runUntil(task.id, "needs_attention");
  assert.ok(failed.completedAt);
  f.clock.value += 60 * 60 * 1000;
  assert.equal((await f.request(`/image-tasks/${task.id}/cancel`, "POST", { version:failed.version })).status, 409);
  assert.equal((await f.get(task.id)).version, failed.version);
  const stopped = await f.freeze(failed);
  assert.equal(stopped.status, 200);
  assert.equal(stopped.data.completedAt, failed.completedAt);
  assert.notEqual(stopped.data.updatedAt, failed.updatedAt);
});

test("多图提交读完A等待B期间禁止旋转，重叠失败提交不会提前解除输入锁", async (t) => {
  const f = await fixture(t);
  let task = await f.prepared(2);
  task = (await f.request(`/image-tasks/${task.id}`, "PATCH", {
    version: task.version, itemDirections: { [task.items[0].id]: 2 },
  })).data;
  const firstImage = task.items[0].imageId, secondImage = task.items[1].imageId;
  const getImage = f.app.ai.getImage;
  let release, firstRead, secondRead, secondCalls = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const readA = new Promise((resolve) => { firstRead = resolve; });
  const readB = new Promise((resolve) => { secondRead = resolve; });
  f.app.ai.getImage = async (userId, imageId) => {
    const image = await getImage(userId, imageId);
    if (imageId === firstImage) firstRead();
    if (imageId === secondImage && ++secondCalls === 1) { secondRead(); await gate; }
    return image;
  };
  const submitting = f.request(`/image-tasks/${task.id}/submit`, "POST", { version: task.version });
  await Promise.all([readA, readB]);
  try {
    // This second request acquires the same image locks, but fails validation.
    // It must decrement reference counts rather than release the first request.
    const stale = await f.request(`/image-tasks/${task.id}/submit`, "POST", { version: task.version - 1 });
    assert.equal(stale.status, 409);
    const rotated = await f.request(`/images/${firstImage}/rotate`, "POST", { quarterTurns: 1, revision: 1 });
    assert.equal(rotated.status, 409);
    assert.equal((await getImage(f.inspect((db) => db.prepare("SELECT user_id FROM image_tasks WHERE id=?").get(task.id).user_id), firstImage)).revision, 1);
  } finally { release(); }
  const submitted = await submitting;
  assert.equal(submitted.status, 202, JSON.stringify(submitted.data));
  f.app.ai.getImage = getImage;
  const ready = await f.runUntil(task.id, "ready");
  assert.equal(ready.items[0].sourceImage.revision, 2);
  assert.equal(ready.items[0].sourceImage.width, 4);
  assert.equal(ready.items[0].sourceImage.height, 6);
});

test("两设备不同校对不能当作同一重试，显式另存副本保留手改且不重复追加", async (t) => {
  const f = await fixture(t);
  const login = await f.request("/session/login", "POST", { username: "test_owner", password: "fixture-only-password" }, "");
  const deviceB = cookieFromResponse(login.response);
  const original = (await f.request("/documents", "POST", {
    title: "原文章", kind: "article", orientation: "horizontal", content: "已有原文。",
  })).data;
  const prepared = await f.prepared(1, { targetId: original.id });
  const task = (await f.freeze(prepared)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const sourceId = result.sourceImages[0].id;
  const documents = ["设备A校对正文", "设备B不同校对正文"].map((text) => ({ ...original, ...result,
    bodyHtml: appendImageBodyHtml(original.bodyHtml, blocksToHtml(parseText(text), { sourceImageId: sourceId })),
  }));
  const payloads = documents.map((document) => ({ version: task.version, resultVersion: task.resultVersion, document }));
  const responses = await Promise.all([
    f.request(`/image-tasks/${task.id}/apply`, "POST", payloads[0]),
    f.request(`/image-tasks/${task.id}/apply`, "POST", payloads[1], deviceB),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  const winner = responses.findIndex((response) => response.status === 200), loser = 1 - winner;
  const primary = responses[winner].data;
  assert.equal(primary.id, original.id);
  assert.equal((await f.get(task.id)).appliedDocumentId, primary.id);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM documents").get().count), 1);
  const reverseKeys = (value) => Array.isArray(value) ? value.map(reverseKeys)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).reverse().map((key) => [key, reverseKeys(value[key])])) : value;
  const retry = await f.request(`/image-tasks/${task.id}/apply`, "POST", { ...reverseKeys(payloads[winner]), version: 0 });
  assert.equal(retry.status, 200);
  assert.equal(retry.data.id, primary.id);
  assert.equal(retry.data.revision, primary.revision);

  const { id, revision, bookId, newBookTitle, ...unsaved } = documents[loser];
  const copyPayload = { version: task.version, resultVersion: task.resultVersion,
    document: { ...unsaved, saveAsNew: true, title: "保留另一设备校对" } };
  const copy = await f.request(`/image-tasks/${task.id}/apply`, "POST", copyPayload, deviceB);
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.notEqual(copy.data.id, primary.id);
  assert.equal(bodyText(copy.data.bodyHtml), bodyText(documents[loser].bodyHtml));
  assert.equal(copy.data.sourceImages[0].id, sourceId);
  const copyAgain = await f.request(`/image-tasks/${task.id}/apply`, "POST", reverseKeys(copyPayload), deviceB);
  assert.equal(copyAgain.status, 200);
  assert.equal(copyAgain.data.id, copy.data.id);
  assert.equal((await f.get(task.id)).appliedDocumentId, primary.id);
  const originalAfter = (await f.request(`/documents/${primary.id}`)).data;
  assert.equal(originalAfter.bodyHtml, primary.bodyHtml);
  assert.equal(originalAfter.revision, primary.revision);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM documents").get().count), 2);
  assert.equal((await f.request(`/documents/${copy.data.id}`, "DELETE", { revision: copy.data.revision })).status, 204);
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", copyPayload, deviceB)).status, 404);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS count FROM documents").get().count), 1);
});

test("历史已采用任务迁移后未知请求拒绝当作成功，仍可显式另存副本", async (t) => {
  const f = await fixture(t);
  const prepared = await f.prepared();
  const task = (await f.freeze(prepared)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const document = { ...result, bodyHtml: blocksToHtml(parseText("原手动正文"), { sourceImageId: result.sourceImages[0].id }) };
  const payload = { version: task.version, resultVersion: task.resultVersion, document };
  const primary = await f.request(`/image-tasks/${task.id}/apply`, "POST", payload);
  assert.equal(primary.status, 200);
  f.inspect((db) => {
    db.exec("ALTER TABLE image_tasks DROP COLUMN applied_input_hash");
    db.exec("ALTER TABLE image_tasks DROP COLUMN applied_copies_json");
  });
  await f.restart();
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", payload)).status, 409);
  assert.equal(f.inspect((db) => db.prepare("SELECT applied_input_hash FROM image_tasks WHERE id=?").get(task.id).applied_input_hash), null);
  const copyPayload = { ...payload, document: { ...document, saveAsNew: true, title: "历史任务另存" } };
  const copy = await f.request(`/image-tasks/${task.id}/apply`, "POST", copyPayload);
  assert.equal(copy.status, 200, JSON.stringify(copy.data));
  assert.notEqual(copy.data.id, primary.data.id);
  const copyAgain = await f.request(`/image-tasks/${task.id}/apply`, "POST", copyPayload);
  assert.equal(copyAgain.status, 200);
  assert.equal(copyAgain.data.id, copy.data.id);
  assert.equal((await f.get(task.id)).appliedDocumentId, primary.data.id);
});

test("任务书名与目标标题来自服务端，草稿更新及提交刷新快照，提交后保持不变", async (t) => {
  const f = await fixture(t);
  const book = (await f.request("/books", "POST", { title: "最初书名" })).data;
  const target = (await f.request("/documents", "POST", {
    title: "目标文章", kind: "book", bookId: book.id, orientation: "horizontal", content: "原文",
  })).data;
  let task = await f.prepared(1, { bookId: book.id, targetId: target.id, title: "用户标题", bookTitle: "伪造书名", targetTitle: "伪造目标" });
  assert.equal(task.bookTitle, "最初书名");
  assert.equal(task.targetTitle, "目标文章");
  assert.equal(task.title, "用户标题");
  let currentBook = (await f.request(`/books/${book.id}`)).data;
  assert.equal((await f.request(`/books/${book.id}`, "PUT", { title: "更新书名", revision: currentBook.revision })).status, 200);
  task = (await f.request(`/image-tasks/${task.id}`, "PATCH", { version: task.version, title: "用户新标题", bookTitle: "伪造" })).data;
  assert.equal(task.bookTitle, "更新书名");
  const changedTarget = (await f.request(`/documents/${target.id}`, "PUT", { ...target, title: "更新目标文章" })).data;
  task = await f.submit(task);
  assert.equal(task.targetTitle, "更新目标文章");
  assert.equal(task.targetRevision, changedTarget.revision);
  currentBook = (await f.request(`/books/${book.id}`)).data;
  assert.equal((await f.request(`/books/${book.id}`, "DELETE", { revision: currentBook.revision })).status, 204);
  const reopened = await f.get(task.id);
  assert.equal(reopened.bookTitle, "更新书名");
  assert.equal(reopened.targetTitle, "更新目标文章");
  assert.equal(reopened.title, "用户新标题");
  assert.equal((await f.create({ createNewBook: true, newBookTitle: "新书" })).bookTitle, "新书");
});

test("任务列表只在采用后归档，范围内分页与计数一致，已归档任务不能删除", async (t) => {
  const f = await fixture(t);
  const draft = await f.create();
  let savedTask = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  const ready = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  let active = (await f.request("/image-tasks")).data;
  assert.equal(active.total, 3);
  assert.equal(active.activeCount, 3);
  assert.equal(active.counts.ready, 2);
  const result = (await f.request(`/image-tasks/${savedTask.id}/result`)).data;
  const payload = { version: savedTask.version, resultVersion: savedTask.resultVersion, document: result };
  const saved = await f.request(`/image-tasks/${savedTask.id}/apply`, "POST", payload);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal((await f.request(`/image-tasks/${savedTask.id}/apply`, "POST", payload)).data.id, saved.data.id);
  active = (await f.request("/image-tasks?scope=active&limit=1")).data;
  assert.equal(active.total, 2);
  assert.equal(active.activeCount, 2);
  assert.equal(active.tasks.length, 1);
  assert.equal(Object.values(active.counts).reduce((sum, value) => sum + value, 0), active.total);
  const archive = (await f.request("/image-tasks?scope=archived")).data;
  assert.equal(archive.total, 1);
  assert.equal(archive.activeCount, 2);
  assert.deepEqual(archive.tasks.map((task) => task.id), [savedTask.id]);
  assert.equal(archive.counts.ready, 1);
  assert.deepEqual(new Set((await f.request("/image-tasks")).data.tasks.map((task) => task.id)), new Set([draft.id, ready.id]));
  assert.equal((await f.request("/image-tasks?scope=invalid")).status, 400);
  savedTask = await f.get(savedTask.id);
  assert.equal(savedTask.canDelete, false);
  assert.equal((await f.request(`/image-tasks/${savedTask.id}`, "DELETE", { version: savedTask.version })).status, 409);
  assert.equal((await f.request("/image-tasks?scope=archived")).data.total, 1);
  assert.equal((await f.request(`/documents/${saved.data.id}`)).status, 200);
  assert.equal((await f.request(`/images/${savedTask.items[0].imageId}`)).status, 200);
});

test("出错任务固定人工稿后跨重启保留checkpoint，恢复后旧编辑保存与注音明确冲突", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared(2));
  await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.counts.completed, 1);
  f.state.connected = false;
  task = await f.runUntil(task.id, "blocked");
  f.state.connected = true;
  assert.equal(task.canDelete, true);
  assert.equal(task.canPause, false);
  assert.equal(task.resultVersion, null);
  assert.equal((await f.request(`/images/${task.items[0].imageId}/rotate`, "POST", { quarterTurns: 1, revision: 1 })).status, 409);
  task = (await f.freeze(task)).data;
  assert.equal(task.state, "needs_attention");
  assert.ok(task.blockedReason);
  await f.restart();
  assert.equal((await f.get(task.id)).state, "needs_attention");
  const before = f.state.calls.length;
  await f.app.imageTasks.runNext();
  assert.equal(f.state.calls.length, before);
  task = (await f.freeze(await f.get(task.id))).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal((await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version - 1 })).status, 409);
  const resumed = await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version });
  assert.equal(resumed.status, 202);
  assert.equal(resumed.data.state, "queued");
  assert.equal(resumed.data.resultVersion, null);
  const oldPayload = { version: task.version, resultVersion: task.resultVersion, document: result };
  const stale = await f.request(`/image-tasks/${task.id}/apply`, "POST", oldPayload);
  assert.equal(stale.status, 409);
  assert.equal(stale.data.code, "TASK_RESULT_STALE");
  const oldAnnotation = await f.request(`/image-tasks/${task.id}/items/${task.items[0].id}/annotate`, "POST", {
    resultVersion: task.resultVersion, content: "日本",
  });
  assert.equal(oldAnnotation.status, 409);
  assert.equal(oldAnnotation.data.code, "TASK_RESULT_STALE");
  task = await f.runUntil(task.id, "ready");
  assert.equal(task.counts.completed, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 2);
  const currentResult = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const currentPayload = { version: task.version, resultVersion: task.resultVersion, document: currentResult };
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", currentPayload);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  const replay = await f.request(`/image-tasks/${task.id}/apply`, "POST", currentPayload);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, saved.data.id);
  const staleAfterAdoption = await f.request(`/image-tasks/${task.id}/apply`, "POST", oldPayload);
  assert.equal(staleAfterAdoption.status, 409);
  assert.equal(staleAfterAdoption.data.code, "TASK_RESULT_STALE");
  const staleCopy = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    ...oldPayload, document: { ...oldPayload.document, saveAsNew: true },
  });
  assert.equal(staleCopy.status, 409);
  assert.equal(staleCopy.data.code, "TASK_RESULT_STALE");
});

test("旧停止任务及失败后已固定的任务仍能恢复，只重试未成功步骤", async (t) => {
  const f = await fixture(t);
  let draft = await f.prepared();
  draft = await f.legacyPause(draft, "cancelled");
  assert.equal(draft.state, "cancelled");
  draft = (await f.request(`/image-tasks/${draft.id}/resume`, "POST", { version: draft.version })).data;
  assert.equal(draft.state, "draft");
  let task = await f.submit(draft);
  task = await f.legacyPause(task, "cancelled");
  task = (await f.freeze(task)).data;
  assert.equal(task.state, "cancelled");
  assert.equal((await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version })).status, 202);
  f.state.onRun = async (phase) => { if (phase === "annotate") throw Object.assign(new Error("fixture retry"), { status: 400 }); };
  task = await f.runUntil(task.id, "needs_attention");
  task = (await f.freeze(task)).data;
  assert.ok(task.resultVersion);
  assert.equal(task.state, "needs_attention");
  f.state.onRun = null;
  assert.equal((await f.request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version })).status, 202);
  await f.runUntil(task.id, "ready");
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 1);
});

test("草稿及正常处理中不能转人工，授权出错后可固定结果且旧注音不能竞争", async (t) => {
  const f = await fixture(t);
  let task = await f.prepared();
  const freeze = () => f.request(`/image-tasks/${task.id}/cancel`, "POST", { version: task.version, freezeResult: true });
  assert.equal((await freeze()).status, 409);
  task = await f.submit(task);
  assert.equal((await freeze()).status, 409);
  assert.equal((await f.request(`/images/${task.items[0].imageId}/annotate`, "POST", { content: "日本" })).status, 409);
  f.state.connected = false;
  await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.state, "blocked");
  assert.equal((await f.request(`/images/${task.items[0].imageId}/annotate`, "POST", { content: "日本" })).status, 409);
  assert.equal(f.state.calls.length, 0);
  const reason = task.blockedReason;
  const fixed = await freeze();
  assert.equal(fixed.status, 200);
  task = fixed.data;
  assert.equal(task.state, "needs_attention");
  assert.equal(task.blockedReason, reason);
  assert.equal(task.canDelete, true);
  assert.equal(task.canReview, true);
  assert.ok(task.resultVersion);
  f.state.connected = true;
  assert.equal((await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version })).status, 202);
  assert.equal((await f.runUntil(task.id, "ready")).counts.completed, 1);
});

test("人工注音执行中恢复或删除任务，迟到回复不会写入任何校对缓存", async (t) => {
  for (const operation of ["resume", "delete"]) {
    for (const legacy of [false, true]) {
      await t.test(`${operation} ${legacy ? "旧单图接口" : "任务接口"}`, async (t) => {
        const f = await fixture(t);
        const task = (await f.freeze(await f.prepared())).data, item = task.items[0];
        const draft = { title: "测试草稿", kind: "article", orientation: "horizontal", blocks: parseText("日本"), content: "日本" };
        f.inspect((db) => db.prepare("INSERT INTO image_drafts(image_id,user_id,draft_json) SELECT ?,user_id,? FROM image_tasks WHERE id=?")
          .run(item.imageId, JSON.stringify(draft), task.id));
        let release, entered;
        const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
        f.state.onRun = async () => { entered(); await gate; }; f.state.stop = release;
        const pending = f.request(legacy ? `/images/${item.imageId}/annotate` : `/image-tasks/${task.id}/items/${item.id}/annotate`, "POST", {
          resultVersion: task.resultVersion, content: "日本",
        });
        await started;
        const changed = await f.request(operation === "resume" ? `/image-tasks/${task.id}/resume` : `/image-tasks/${task.id}`,
          operation === "resume" ? "POST" : "DELETE", { version: task.version });
        assert.equal(changed.status, operation === "resume" ? 202 : 204);
        release();
        assert.equal((await pending).status, operation === "resume" ? 409 : 404);
        assert.equal(f.inspect((db) => db.prepare("SELECT review_annotations_json FROM image_task_items WHERE task_id=?").get(task.id).review_annotations_json), "[]");
        assert.equal(f.inspect((db) => db.prepare("SELECT draft_json FROM image_drafts WHERE image_id=?").get(item.imageId).draft_json), JSON.stringify(draft));
      });
    }
  }
});

test("运行中任务禁止删除，出错后可删除且重启及相同创建请求不能复活", async (t) => {
  const f = await fixture(t), key = randomUUID();
  let task = await f.submit(await f.prepared(1, { idempotencyKey: key }));
  await f.app.imageTasks.runNext();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async () => { entered(); await gate; throw Object.assign(new Error("fixture failed OCR"), { status: 400 }); }; f.state.stop = release;
  const running = f.app.imageTasks.runNext(); await started;
  task = await f.get(task.id);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version - 1 })).status, 409);
  assert.equal(task.canDelete, false);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 409);
  release(); await running;
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(task.canDelete, true);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version - 1 })).status, 409);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  assert.equal(f.inspect((db) => db.prepare("SELECT recognition_json FROM image_task_items WHERE task_id=?").get(task.id).recognition_json), null);
  assert.equal((await f.request(`/image-tasks/${task.id}`)).status, 404);
  const deletedApply = await f.request(`/image-tasks/${task.id}/apply`, "POST", { version: task.version, resultVersion: 1, document: {} });
  assert.equal(deletedApply.status, 404);
  assert.equal(deletedApply.data.code, "TASK_UNAVAILABLE");
  assert.equal((await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version })).status, 404);
  assert.equal((await f.request("/image-tasks", "POST", { idempotencyKey: key, title: "任务文章" })).status, 410);
  assert.equal((await f.request("/image-tasks")).data.activeCount, 0);
  await f.restart(); await f.app.imageTasks.runNext();
  assert.equal((await f.request("/image-tasks")).data.total, 0);
  assert.equal(f.state.calls.length, 1);
});

test("上传中的草稿禁止删除，原上传正常完成并保留草稿", async (t) => {
  const f = await fixture(t), task = await f.add(await f.create()), item = task.items[0];
  const originalSave = f.app.ai.saveImage;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.app.ai.saveImage = async (...args) => { const image = await originalSave(...args); entered(); await gate; return image; };
  const pixels = await sharp({ create: { width: 3, height: 4, channels: 3, background: "white" } }).png().toBuffer();
  const form = new FormData(); form.append("image", new Blob([pixels], { type: "image/png" }), item.name);
  const pending = fetch(`${f.url}/api/image-tasks/${task.id}/items/${item.id}/image`, { method: "POST", headers: { Cookie: f.cookie }, body: form });
  await started;
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 409);
  release();
  assert.equal((await pending).status, 200);
  assert.ok(f.inspect((db) => db.prepare("SELECT image_id FROM image_task_items WHERE task_id=?").get(task.id).image_id));
  assert.equal((await f.request("/image-tasks")).data.total, 1);
});

test("旧任务迁移持久保存书名快照及删除字段，幂等创建保持兼容", async (t) => {
  const f = await fixture(t), key = randomUUID();
  const book = (await f.request("/books", "POST", { title: "旧书名" })).data;
  const task = await f.create({ idempotencyKey: key, bookId: book.id });
  const newBookTask = await f.create({ createNewBook: true, newBookTitle: "旧新建书名" });
  f.inspect((db) => {
    for (const id of [task.id, newBookTask.id]) {
      const input = JSON.parse(db.prepare("SELECT input_json FROM image_tasks WHERE id=?").get(id).input_json);
      delete input.bookTitle; delete input.targetTitle;
      db.prepare("UPDATE image_tasks SET input_json=? WHERE id=?").run(JSON.stringify(input), id);
    }
    db.exec("ALTER TABLE image_tasks DROP COLUMN deleted_at");
  });
  await f.restart();
  assert.equal((await f.get(task.id)).bookTitle, "旧书名");
  assert.equal((await f.get(newBookTask.id)).bookTitle, "旧新建书名");
  assert.equal((await f.request(`/books/${book.id}`, "PUT", { title: "后改书名", revision: book.revision })).status, 200);
  assert.equal((await f.get(task.id)).bookTitle, "旧书名");
  assert.equal(f.inspect((db) => JSON.parse(db.prepare("SELECT input_json FROM image_tasks WHERE id=?").get(task.id).input_json).bookTitle), "旧书名");
  assert.equal((await f.request("/image-tasks", "POST", { idempotencyKey: key, title: "任务文章", bookId: book.id })).data.id, task.id);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 409);
});

test("恢复旧停止任务前校验所有原图版本，包括无需再执行的成功图片", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared(2));
  await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  task = await f.legacyPause(task, "cancelled");
  const ownerId = f.inspect((db) => db.prepare("SELECT user_id FROM image_tasks WHERE id=?").get(task.id).user_id);
  // Reproduce a pixel update made while stopped under the previous version's guard.
  await f.app.ai.rotateImage(ownerId, task.items[0].imageId, { quarterTurns: 1, revision: 1 }, { internal: true });
  const resumed = await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version });
  assert.equal(resumed.status, 409);
  assert.match(resumed.data.error, /方向已变化/);
  assert.equal((await f.get(task.id)).state, "cancelled");
  assert.equal((await f.get(task.id)).counts.completed, 1);
  assert.equal(f.state.calls.length, 2);
});

test("恢复任务读取多张图片期间锁住全部输入，避免已读取原图被并发旋转", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared(2));
  task = await f.legacyPause(task, "cancelled");
  const originalGet = f.app.ai.getImage;
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.app.ai.getImage = async (...args) => {
    const image = await originalGet(...args);
    if (args[1] === task.items[1].imageId) { entered(); await gate; }
    return image;
  };
  const pending = f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version });
  await started;
  assert.equal((await f.request(`/images/${task.items[0].imageId}/rotate`, "POST", { quarterTurns: 1, revision: 1 })).status, 409);
  release();
  assert.equal((await pending).status, 202);
  assert.equal((await f.get(task.id)).state, "queued");
});

test("出错后先固定人工稿才允许旋转并保存，旋转后恢复拒绝旧checkpoint", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared());
  await f.app.imageTasks.runNext(); await f.app.imageTasks.runNext();
  f.state.onRun = async (phase) => { if (phase === "annotate") throw Object.assign(new Error("fixture annotation failure"), { status: 400 }); };
  task = await f.runUntil(task.id, "needs_attention");
  f.state.onRun = null;
  const imageId = task.items[0].imageId;
  assert.equal((await f.request(`/images/${imageId}/rotate`, "POST", { quarterTurns: 1, revision: 1 })).status, 409);
  task = (await f.freeze(task)).data;
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const checkpoint = f.inspect((db) => db.prepare("SELECT recognition_json FROM image_task_items WHERE task_id=?").get(task.id).recognition_json);
  const rotated = await f.request(`/images/${imageId}/rotate`, "POST", { quarterTurns: 1, revision: 1 });
  assert.equal(rotated.status, 200, JSON.stringify(rotated.data));
  assert.equal(rotated.data.revision, 2);
  const resumed = await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version });
  assert.equal(resumed.status, 409);
  assert.match(resumed.data.error, /方向已变化/);
  assert.equal((await f.get(task.id)).resultVersion, task.resultVersion);
  assert.equal(f.inspect((db) => db.prepare("SELECT recognition_json FROM image_task_items WHERE task_id=?").get(task.id).recognition_json), checkpoint);
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    version: task.version, resultVersion: task.resultVersion,
    document: { ...result, bodyHtml: blocksToHtml(parseText("{手動|しゅどう}"), { sourceImageId: imageId }) },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(bodyText(saved.data.bodyHtml), "手動");
  assert.deepEqual(bodyRanges(saved.data.bodyHtml).sources.map((source) => source.id), [imageId]);
  assert.equal(saved.data.sourceImages[0].id, imageId);
  assert.equal((await f.request(`/images/${imageId}`)).data.revision, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 1);
});

test("正常任务、旧手动暂停及已归档任务均不能手动暂停或删除，权限不接受客户端自报", async (t) => {
  const f = await fixture(t);
  const assertProtected = async (task) => {
    assert.equal(task.canPause, false);
    assert.equal(task.canDelete, false);
    for (const operation of ["pause", "cancel"]) {
      const denied = await f.request(`/image-tasks/${task.id}/${operation}`, "POST", { version: task.version, canPause: true });
      assert.equal(denied.status, 409);
      assert.match(denied.data.error, /不支持手动暂停/);
    }
    const deleted = await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version, canDelete: true, state: "needs_attention" });
    assert.equal(deleted.status, 409);
    assert.match(deleted.data.error, /只有出错/);
    assert.equal((await f.get(task.id)).version, task.version);
  };
  let task = await f.prepared();
  await assertProtected(task);
  task = await f.submit(task);
  await assertProtected(task);
  await f.app.imageTasks.runNext();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async () => { entered(); await gate; }; f.state.stop = release;
  const pending = f.app.imageTasks.runNext(); await started;
  await assertProtected(await f.get(task.id));
  release(); await pending; f.state.onRun = null;
  task = await f.runUntil(task.id, "ready");
  await assertProtected(task);
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", { version: task.version, resultVersion: task.resultVersion, document: result })).status, 200);
  await assertProtected(await f.get(task.id));
  for (const state of ["paused", "cancelled"]) await assertProtected(await f.legacyPause(await f.prepared(), state));
});

test("授权出错允许按版本删除，恢复后即使使用最新版本也不再允许删除", async (t) => {
  const f = await fixture(t);
  f.state.connected = false;
  let task = await f.runUntil((await f.submit(await f.prepared())).id, "blocked");
  assert.equal(task.canDelete, true);
  assert.equal(task.canPause, false);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version - 1 })).status, 409);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  task = await f.runUntil((await f.submit(await f.prepared())).id, "blocked");
  const failedVersion = task.version;
  f.state.connected = true;
  task = (await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: task.version })).data;
  assert.equal(task.state, "queued");
  assert.equal(task.canDelete, false);
  for (const version of [failedVersion, task.version])
    assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version })).status, 409);
  assert.equal((await f.get(task.id)).version, task.version);
  await f.runUntil(task.id, "ready");
});

test("任务校对可移除最后来源图并保存无图正文，拒绝遗留来源标记且归档重试幂等", async (t) => {
  const f = await fixture(t);
  const task = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  const version = { version: task.version, resultVersion: task.resultVersion };
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    ...version, document: { ...result, sourceImages: [], sourceImageId: null },
  })).status, 400);
  const payload = { ...version, document: { ...result, sourceImages: [], sourceImageId: null,
    bodyHtml: blocksToHtml(parseText("保留的手动正文")),
  } };
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", payload);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.sourceImages, []);
  assert.equal(saved.data.sourceImageId, null);
  assert.equal(saved.data.recognition, null);
  assert.equal(bodyText(saved.data.bodyHtml), "保留的手动正文");
  assert.deepEqual(bodyRanges(saved.data.bodyHtml).sources, []);
  const replay = await f.request(`/image-tasks/${task.id}/apply`, "POST", payload);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, saved.data.id);
  assert.equal(replay.data.revision, saved.data.revision);
  assert.equal((await f.request("/image-tasks")).data.total, 0);
  assert.deepEqual((await f.request("/image-tasks?scope=archived")).data.tasks.map((value) => value.id), [task.id]);
  assert.equal((await f.request(`/images/${task.items[0].imageId}`)).status, 200);
});

test("追加任务可移除全部本批图片而保留目标旧图，只采用可信旧图记录", async (t) => {
  const f = await fixture(t);
  const first = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  const firstResult = (await f.request(`/image-tasks/${first.id}/result`)).data;
  const original = (await f.request(`/image-tasks/${first.id}/apply`, "POST", {
    version: first.version, resultVersion: first.resultVersion, document: firstResult,
  })).data;
  const task = await f.runUntil((await f.submit(await f.prepared(1, { targetId: original.id }))).id, "ready");
  const unrelated = await f.prepared();
  const version = { version: task.version, resultVersion: task.resultVersion };
  const onlyOldDocument = { ...original, sourceImages: original.sourceImages.map(({ id }) => ({ id, recognition: { content: "伪造记录" } })) };
  assert.equal((await f.request(`/image-tasks/${task.id}/apply`, "POST", {
    ...version, document: { ...onlyOldDocument, sourceImages: [{ id: unrelated.items[0].imageId }] },
  })).status, 400);
  const saved = await f.request(`/image-tasks/${task.id}/apply`, "POST", { ...version, document: onlyOldDocument });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.id, original.id);
  assert.equal(saved.data.bodyHtml, original.bodyHtml);
  assert.equal(saved.data.revision, original.revision + 1);
  assert.deepEqual(saved.data.sourceImages, original.sourceImages);
  assert.equal((await f.get(task.id)).appliedDocumentId, original.id);
});

test("整批图片注音完成后仍等待跨图分句，最终分句落盘后才就绪且重启不重跑", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared(2));
  for (let index = 0; index < 6; index++) await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.state, "queued");
  assert.equal(task.counts.completed, 2);
  assert.equal(task.phase, "segment");
  assert.equal(task.segmentation.state, "pending");
  assert.equal(task.resultVersion, null);
  assert.equal(task.completedAt, null);
  assert.equal((await f.request(`/image-tasks/${task.id}/result`)).status, 409);
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async (phase) => { if (phase === "segment") { entered(); await gate; } }; f.state.stop = release;
  const pending = f.app.imageTasks.runNext(); await started;
  task = await f.get(task.id);
  assert.equal(task.state, "running");
  assert.equal(task.phase, "segment");
  assert.equal(task.segmentation.state, "running");
  assert.equal(task.segmentation.hasResult, false);
  assert.equal(task.counts.completed, 2);
  assert.equal(task.canReview, false);
  assert.equal(task.canDelete, false);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 409);
  const inference = f.state.calls.find((call) => call.phase === "segment");
  assert.equal(JSON.parse(inference.input.prompt.split("\n输入正文：\n").at(-1)), "日本日本");
  release(); await pending;
  task = await f.get(task.id);
  assert.equal(task.state, "ready");
  assert.equal(task.segmentation.state, "succeeded");
  assert.equal(task.segmentation.hasResult, true);
  assert.equal(task.phase, null);
  const result = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(result.segmentationCompleted, true);
  assert.equal(result.initializeSentences, false);
  assert.ok(hasCompleteSentenceBoundaries(result.bodyHtml));
  assert.equal(bodyRanges(result.bodyHtml).sentences.length, 1);
  assert.equal(bodyRanges(result.bodyHtml).sentences[0].text, "日本日本");
  assert.deepEqual(bodyRanges(result.bodyHtml).sources.map(({ id }) => id), task.items.map(({ imageId }) => imageId));
  const persisted = f.inspect((db) => JSON.parse(db.prepare("SELECT segmentation_json FROM image_tasks WHERE id=?").get(task.id).segmentation_json));
  assert.equal(persisted.result.bodyHtml, result.bodyHtml);
  await f.restart(); await f.app.imageTasks.runNext();
  const restored = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(restored.bodyHtml, result.bodyHtml);
  assert.equal(restored.taskResultVersion, result.taskResultVersion);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 1);
});

test("最终分句自动重试预算跨重启持久，用尽后只重试分句并保留图片checkpoint", async (t) => {
  const f = await fixture(t, { runnerOptions: { maxAutomaticRetries: 2 } });
  let fail = true;
  f.state.onRun = async (phase) => { if (phase === "segment" && fail) throw Object.assign(new Error("fixture segmentation failure"), { status: 502 }); };
  let task = await f.submit(await f.prepared(2));
  for (let index = 0; index < 7; index++) await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.state, "queued");
  assert.equal(task.segmentation.attempts, 1);
  assert.equal(task.segmentation.state, "pending");
  await f.restart();
  assert.equal((await f.get(task.id)).segmentation.attempts, 1);
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(task.phase, "segment");
  assert.equal(task.segmentation.state, "failed");
  assert.equal(task.segmentation.attempts, 3);
  assert.equal(task.counts.completed, 2);
  assert.equal(task.counts.failed, 0);
  assert.equal(task.canDelete, true);
  assert.match(task.lastError, /segmentation failure/);
  assert.equal(task.resultVersion, null);
  const checkpoints = f.inspect((db) => db.prepare("SELECT recognition_json,annotation_json,steps_json FROM image_task_items WHERE task_id=? ORDER BY position").all(task.id));
  fail = false;
  const retry = await f.request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version });
  assert.equal(retry.status, 202);
  assert.equal(retry.data.segmentation.state, "pending");
  assert.equal(retry.data.canDelete, false);
  task = await f.runUntil(task.id, "ready");
  assert.equal(task.segmentation.state, "succeeded");
  assert.deepEqual(f.inspect((db) => db.prepare("SELECT recognition_json,annotation_json,steps_json FROM image_task_items WHERE task_id=? ORDER BY position").all(task.id)), checkpoints);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 4);
});

test("分句执行中服务重启使旧attempt失效，只恢复最后一步且不写关闭的数据库", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared(2));
  for (let index = 0; index < 6; index++) await f.app.imageTasks.runNext();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async (phase) => { if (phase === "segment") { entered(); await gate; } }; f.state.stop = release;
  const old = f.app.imageTasks.runNext(); await started;
  assert.equal((await f.get(task.id)).segmentation.state, "running");
  await f.restart(); f.state.onRun = null; release(); await old;
  task = await f.get(task.id);
  assert.equal(task.state, "queued");
  assert.equal(task.phase, "segment");
  assert.equal(task.segmentation.state, "pending");
  assert.equal(task.segmentation.attempts, 0);
  assert.equal(task.counts.completed, 2);
  assert.equal(task.resultVersion, null);
  assert.equal(f.inspect((db) => db.prepare("SELECT segmentation_token FROM image_tasks WHERE id=?").get(task.id).segmentation_token), null);
  task = await f.runUntil(task.id, "ready");
  assert.equal(task.segmentation.state, "succeeded");
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 2);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 2);
});

test("分句授权出错可继续或删除，删除后的最后步骤不能重启复活", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared());
  for (let index = 0; index < 3; index++) await f.app.imageTasks.runNext();
  f.state.connected = false;
  await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.state, "blocked");
  assert.equal(task.phase, "segment");
  assert.equal(task.segmentation.state, "pending");
  assert.equal(task.segmentation.attempts, 0);
  assert.equal(task.counts.completed, 1);
  assert.equal(task.canDelete, true);
  assert.match(task.lastError, /授权/);
  const fixed = (await f.freeze(task)).data;
  assert.equal(fixed.state, "needs_attention");
  const partial = (await f.request(`/image-tasks/${task.id}/result`)).data;
  assert.equal(partial.initializeSentences, true);
  assert.equal(partial.segmentationCompleted, false);
  assert.match(partial.segmentationError, /授权/);
  f.state.connected = true;
  assert.equal((await f.request(`/image-tasks/${task.id}/resume`, "POST", { version: fixed.version })).status, 202);
  task = await f.runUntil(task.id, "ready");
  assert.equal(task.counts.completed, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 1);
  // A distinct body avoids the successful task's sentence cache.
  task = await f.submit(await f.prepared(2));
  for (let index = 0; index < 6; index++) await f.app.imageTasks.runNext();
  f.state.connected = false; await f.app.imageTasks.runNext();
  task = await f.get(task.id);
  assert.equal(task.phase, "segment");
  assert.equal(task.canDelete, true);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  const calls = f.state.calls.length;
  await f.restart(); f.state.connected = true; await f.app.imageTasks.runNext();
  assert.equal((await f.request(`/image-tasks/${task.id}`)).status, 404);
  assert.equal((await f.request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version })).status, 404);
  assert.equal(f.state.calls.length, calls);
});

test("旧ready仅未采用任务迁移补最后分句，已采用及旧人工暂停不会被自动执行", async (t) => {
  const f = await fixture(t);
  const ready = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  const adopted = await f.runUntil((await f.submit(await f.prepared())).id, "ready");
  const adoptedResult = (await f.request(`/image-tasks/${adopted.id}/result`)).data;
  const applied = { version: adopted.version, resultVersion: adopted.resultVersion, document: adoptedResult };
  const saved = (await f.request(`/image-tasks/${adopted.id}/apply`, "POST", applied)).data;
  const paused = await f.legacyPause(await f.runUntil((await f.submit(await f.prepared())).id, "ready"));
  f.inspect((db) => {
    db.exec("DELETE FROM sentence_cache");
    db.exec("ALTER TABLE image_tasks DROP COLUMN segmentation_token");
    db.exec("ALTER TABLE image_tasks DROP COLUMN segmentation_json");
  });
  const calls = f.state.calls.length;
  await f.restart();
  let migrated = await f.get(ready.id);
  assert.equal(migrated.state, "queued");
  assert.equal(migrated.phase, "segment");
  assert.equal(migrated.resultVersion, null);
  assert.equal(migrated.counts.completed, 1);
  assert.equal((await f.get(adopted.id)).state, "ready");
  assert.equal((await f.get(adopted.id)).appliedDocumentId, saved.id);
  assert.equal((await f.get(paused.id)).state, "paused");
  migrated = await f.runUntil(ready.id, "ready");
  assert.equal(migrated.segmentation.state, "succeeded");
  assert.deepEqual(f.state.calls.slice(calls).map((call) => call.phase), ["segment"]);
  const replay = await f.request(`/image-tasks/${adopted.id}/apply`, "POST", applied);
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, saved.id);
  const legacy = await f.get(paused.id);
  assert.equal((await f.request(`/image-tasks/${paused.id}/resume`, "POST", { version: legacy.version })).status, 202);
  assert.equal((await f.runUntil(paused.id, "ready")).segmentation.state, "succeeded");
  assert.deepEqual(f.state.calls.slice(calls).map((call) => call.phase), ["segment"]);
});

test("重启后分句出错被删除，旧进程迟到的分句结果不能写回或复活任务", async (t) => {
  const f = await fixture(t);
  let task = await f.submit(await f.prepared());
  for (let index = 0; index < 3; index++) await f.app.imageTasks.runNext();
  let release, entered;
  const gate = new Promise((resolve) => { release = resolve; }), started = new Promise((resolve) => { entered = resolve; });
  f.state.onRun = async (phase) => { if (phase === "segment") { entered(); await gate; } };
  f.state.stop = () => {};
  t.after(() => release());
  const old = f.app.imageTasks.runNext(); await started;
  await f.restart();
  f.state.onRun = async (phase) => { if (phase === "segment") throw Object.assign(new Error("fixture current final step failed"), { status: 400 }); };
  task = await f.runUntil(task.id, "needs_attention");
  assert.equal(task.phase, "segment");
  assert.equal(task.canDelete, true);
  assert.equal((await f.request(`/image-tasks/${task.id}`, "DELETE", { version: task.version })).status, 204);
  release(); await old;
  const tombstone = f.inspect((db) => db.prepare("SELECT deleted_at,segmentation_token,segmentation_json FROM image_tasks WHERE id=?").get(task.id));
  assert.ok(tombstone.deleted_at);
  assert.equal(tombstone.segmentation_token, null);
  assert.equal(JSON.parse(tombstone.segmentation_json).state, "failed");
  assert.equal(JSON.parse(tombstone.segmentation_json).result, undefined);
  assert.equal((await f.request(`/image-tasks/${task.id}/result`)).status, 404);
  assert.equal(f.state.calls.filter((call) => call.phase === "recognize").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "annotate").length, 1);
  assert.equal(f.state.calls.filter((call) => call.phase === "segment").length, 2);
});
