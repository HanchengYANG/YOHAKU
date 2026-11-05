// Durable task routing with real SQLite/images and explicit model doubles.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { ensureSession } from "./helpers/session.mjs";
import { OCR_BODY_SCHEMA } from "../shared/ocr.mjs";
import { ANNOTATION_SCHEMA } from "../shared/ocr-correction.mjs";
import { SENTENCE_SCHEMA } from "../shared/sentences.mjs";

test("图片任务重试和重启使用新角色配置，已完成 OCR 不重做且来源持久化", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-role-recovery-"));
  const calls = [], models = ["vision", "text", "text-new"].map((id) => ({ id }));
  const checkedAt = new Date().toISOString();
  const reports = models.map(({ id }) => ({ model: id, checkedAt, passed: true,
    checks: Object.fromEntries(["json", "image", "streaming"].map((name) => [name, { state: "supported", checkedAt }])) }));
  let clock = Date.now(), active;
  function service(_owner, providerId) {
    const account = { connected: true, activeAccountId: `${providerId}-fixture-account`, subject: `${providerId}-fixture-subject` };
    return {
      auth: { status: async () => account, accounts: async () => ({ accounts: [], activeId: account.activeAccountId }) },
      credentialStatus: async () => account,
      knownModels: () => models, models: async () => ({ models }), testReports: async () => reports,
      runtime: { status: () => ({ busy: false, model: "vision" }), stop() {}, async run(input) {
        const phase = input.schema === OCR_BODY_SCHEMA ? "ocr" : input.schema === ANNOTATION_SCHEMA ? "annotation" : input.schema === SENTENCE_SCHEMA ? "segmentation" : "chat";
        calls.push({ phase, providerId, model: input.model, hasImage: !!input.image });
        if (phase === "annotation" && input.model === "text")
          throw Object.assign(new Error("fixture: 原注音模型暂时失败"), { status: 502, expose: true });
        let output = { text: "日本" };
        if (phase === "annotation") {
          const targets = JSON.parse(input.prompt.split("输入目标：\n").at(-1));
          output = { blocks: targets.map(({ text }) => ({ words: [{ t: text, r: "にほん" }] })) };
        }
        if (phase === "segmentation") output = { sentences: [JSON.parse(input.prompt.split("输入正文：\n").at(-1))] };
        return { completed: true, text: JSON.stringify(output), model: input.model, threadId: null };
      } },
    };
  }
  async function start() {
    const instance = createApp({ dataDir, aiServices: service,
      imageTaskOptions: { runnerOptions: { enabled: false, maxAutomaticRetries: 0, retryDelayMs: 1, now: () => clock } } });
    const server = instance.app.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    active = { instance, server, url, cookie: (await ensureSession(url)).cookie };
  }
  async function stop() {
    if (!active) return;
    const previous = active; active = null;
    previous.instance.close();
    await new Promise((resolve) => { previous.server.close(resolve); previous.server.closeAllConnections(); });
  }
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, method = "GET", body, expected = 200) {
    const response = await fetch(active.url + "/api" + path, { method,
      headers: { Cookie: active.cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(10000) });
    const value = await response.json();
    assert.equal(response.status, expected, JSON.stringify(value));
    return value;
  }
  const roles = { ocr: { providerId: "openai", model: "vision" },
    annotation: { providerId: "api_base", model: "text" },
    segmentation: { providerId: "api_base", model: "text" },
    chat: { providerId: "openai", model: "vision" } };
  await request("/ai/roles", "PUT", { version: 0, roles, annotationReferenceImage: false });
  let task = await request("/image-tasks", "POST", { idempotencyKey: randomUUID(), title: "角色恢复测试" }, 201);
  task = await request(`/image-tasks/${task.id}/items`, "POST", { version: task.version, items: [{ id: randomUUID(), name: "role.png" }] });
  const pixels = await sharp({ create: { width: 4, height: 6, channels: 3, background: "white" } }).png().toBuffer();
  const form = new FormData(); form.set("image", new Blob([pixels], { type: "image/png" }), "role.png");
  const upload = await fetch(`${active.url}/api/image-tasks/${task.id}/items/${task.items[0].id}/image`, {
    method: "POST", headers: { Cookie: active.cookie }, body: form,
  });
  assert.equal(upload.status, 200); task = await upload.json();
  task = await request(`/image-tasks/${task.id}/submit`, "POST", { version: task.version }, 202);
  async function advance(id, target) {
    for (let index = 0; index < 12; index++) {
      const current = await request(`/image-tasks/${id}`);
      if (current.state === target) return current;
      clock += 20; await active.instance.imageTasks.runNext();
    }
    assert.fail(`task did not reach ${target}`);
  }
  task = await advance(task.id, "needs_attention");
  assert.equal(task.items[0].steps.recognize.state, "succeeded");
  assert.equal(task.items[0].steps.recognize.execution.configurationVersion, 1);
  assert.equal(task.items[0].steps.annotate.state, "failed");
  const failedExecution=task.items[0].steps.annotate.execution;
  assert.deepEqual(Object.fromEntries(['role','providerId','model','configurationVersion'].map(key=>[key,failedExecution[key]])), {
    role: "annotation", providerId: "api_base", model: "text", configurationVersion: 1,
  });
  assert.ok(Number.isFinite(Date.parse(failedExecution.queuedAt)));
  assert.ok(Number.isFinite(Date.parse(failedExecution.startedAt)));
  assert.ok(Number.isFinite(failedExecution.queueMs)&&failedExecution.queueMs>=0);
  assert.ok(Number.isFinite(failedExecution.elapsedMs)&&failedExecution.elapsedMs>=0);
  assert.deepEqual(calls.map(({ phase }) => phase), ["ocr", "annotation"]);
  await stop(); await start();
  task = await request(`/image-tasks/${task.id}`);
  assert.equal(task.state, "needs_attention");
  roles.annotation.model = "text-new";
  roles.segmentation = { providerId: "openai", model: "text-new" };
  await request("/ai/roles", "PUT", { version: 1, roles, annotationReferenceImage: false });
  task = await request(`/image-tasks/${task.id}/retry`, "POST", { version: task.version }, 202);
  await stop(); await start();
  task = await advance(task.id, "ready");
  assert.deepEqual(calls, [
    { phase: "ocr", providerId: "openai", model: "vision", hasImage: true },
    { phase: "annotation", providerId: "api_base", model: "text", hasImage: false },
    { phase: "annotation", providerId: "api_base", model: "text-new", hasImage: false },
    { phase: "segmentation", providerId: "openai", model: "text-new", hasImage: false },
  ]);
  assert.equal(task.items[0].steps.recognize.execution.model, "vision");
  assert.equal(task.items[0].steps.annotate.execution.model, "text-new");
  assert.equal(task.items[0].steps.annotate.execution.configurationVersion, 2);
  assert.equal(task.segmentation.execution.providerId, "openai");
  assert.equal(task.segmentation.execution.model, "text-new");
  await stop(); await start();
  const restored = await request(`/image-tasks/${task.id}`);
  assert.deepEqual(restored.items[0].steps, task.items[0].steps);
  assert.deepEqual(restored.segmentation, task.segmentation);
  assert.equal(calls.filter(({ phase }) => phase === "ocr").length, 1);
});
