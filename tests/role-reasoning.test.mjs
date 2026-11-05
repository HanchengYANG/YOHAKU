import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../server/app.mjs";
import { ensureSession } from "./helpers/session.mjs";
import { normalizeReasoning, reasoningKey, roleReport, requiredCapabilities } from "../shared/ai-roles.mjs";
import { bodyRanges } from "../shared/article-html.mjs";

const fail = (message) => Object.assign(new Error(message), { status: 400, expose: true });

test("推理设置标准化兼容默认、排序固定，并拒绝无效格式与预算", () => {
  for (const value of [undefined, null, {}, { effort: "" }, { effort: "default" }]) {
    assert.equal(normalizeReasoning(value), undefined);
    assert.equal(reasoningKey(value), "{}");
  }
  const settings = { effort: "high", enabled: true, budgetTokens: 2048 };
  assert.deepEqual(normalizeReasoning({ budgetTokens: 2048, enabled: true, effort: "high" }), settings);
  assert.equal(reasoningKey({ budgetTokens: 2048, effort: "high", enabled: true }), reasoningKey(settings));
  assert.deepEqual(normalizeReasoning({ enabled: false }), { enabled: false });
  for (const input of ["high", [], true, { thinking: true }, { enabled: "true" }, { enabled: null },
    { effort: 1 }, { effort: "HIGH" }, { effort: "a b" }, { budgetTokens: 0 }, { budgetTokens: -1 },
    { budgetTokens: 1.5 }, { budgetTokens: 1000001 }, { budgetTokens: Infinity }, { enabled: false, budgetTokens: 1024 }])
    assert.throws(() => normalizeReasoning(input), { status: 400 });
  assert.deepEqual(normalizeReasoning({ budgetTokens: 1 }), { budgetTokens: 1 });
  assert.deepEqual(normalizeReasoning({ budgetTokens: 1000000 }), { budgetTokens: 1000000 });
});

test("测试结果仅复用同一推理设置，旧无设置记录仍作为模型默认", () => {
  const checkedAt = "2026-11-04T10:00:00.000Z";
  const legacy = { model: "reasoner", checkedAt, checks: { json: { state: "supported" }, image: { state: "unsupported" } } };
  const high = { model: "reasoner", reasoning: { effort: "high" }, checkedAt, checks: { json: { state: "failed" }, streaming: { state: "supported" } } };
  const low = { model: "reasoner", reasoning: { effort: "low" }, checkedAt, checks: { json: { state: "supported" } } };
  assert.equal(roleReport([legacy, high, low], "reasoner", "segmentation", false).passed, true);
  assert.equal(roleReport([legacy, high, low], "reasoner", "annotation", false, {}).passed, true);
  assert.equal(roleReport([legacy, high, low], "reasoner", "segmentation", false, { effort: "high" }).passed, false);
  assert.equal(roleReport([legacy, high, low], "reasoner", "annotation", false, { effort: "low" }).passed, true);
  assert.equal(roleReport([legacy, high, low], "reasoner", "chat", false, { effort: "high" }).passed, true);
  assert.equal(roleReport([legacy, high, low], "reasoner", "segmentation", false, { effort: "medium" }), null);
  assert.equal(roleReport([low], "reasoner", "annotation", true, { effort: "low" }).passed, false);
});

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-role-reasoning-"));
  const records = [], tests = [], calls = [];
  let running, owner;
  const models = [{ id: "reasoner", reasoningOptions: { efforts: ["low", "medium", "high"], toggle: true, budget: { min: 1024, max: 8192 } } }, { id: "plain" }];
  function validateReasoning(model, input) {
    const reasoning = normalizeReasoning(input);
    if (!reasoning) return;
    const options = models.find((entry) => entry.id === model)?.reasoningOptions;
    if (!options || reasoning.effort && !options.efforts.includes(reasoning.effort) ||
        reasoning.enabled !== undefined && !options.toggle ||
        reasoning.budgetTokens !== undefined && (!options.budget || reasoning.budgetTokens < options.budget.min || reasoning.budgetTokens > options.budget.max))
      throw fail("模型不支持此推理设置。");
    return reasoning;
  }
  function service(_owner, providerId) {
    const account = { connected: true, activeAccountId: `${providerId}-account`, subject: `${providerId}-subject` };
    return { auth: { status: async () => account, accounts: async () => ({ accounts: [], activeId: account.activeAccountId }) },
      credentialStatus: async () => account, knownModels: async () => models, models: async () => ({ models }), validateReasoning,
      testReports: async () => records.filter((record) => record.providerId === providerId),
      testModel: async (model, { role, referenceImage, reasoning: raw }) => {
        const reasoning = validateReasoning(model, raw), key = reasoningKey(reasoning);
        tests.push({ providerId, model, role, reasoning });
        const previous = records.find((record) => record.providerId === providerId && record.model === model && reasoningKey(record.reasoning) === key);
        const checkedAt = new Date().toISOString(), checks = { ...previous?.checks };
        for (const capability of requiredCapabilities(role, referenceImage)) checks[capability] = { state: "supported", checkedAt };
        if (previous) records.splice(records.indexOf(previous), 1);
        const record = { providerId, model, ...(reasoning ? { reasoning } : {}), checkedAt, checks };
        records.push(record);
        return roleReport([record], model, role, referenceImage, reasoning);
      },
      runtime: { status: () => ({ busy: false, model: "reasoner" }), stop() {}, async run(input) {
        calls.push({ providerId, ...input });
        let text = "日语解释。";
        if (input.prompt.includes("输入目标：")) text = JSON.stringify({ blocks: [{ words: [{ t: "日本語", r: "にほんご" }] }] });
        if (input.prompt.includes("输入正文：")) text = JSON.stringify({ sentences: [JSON.parse(input.prompt.split("输入正文：\n")[1])] });
        return { text, completed: true, model: input.model || "reasoner", threadId: input.threadId || `thread-${calls.length}`, webSearch: { enabled: providerId === "openai", performed: false } };
      } },
    };
  }
  async function start() {
    const instance = createApp({ dataDir, aiServices: service });
    const server = instance.app.listen(0, "127.0.0.1"); await once(server, "listening");
    running = { ...instance, server, url: `http://127.0.0.1:${server.address().port}` };
    owner = await ensureSession(running.url);
  }
  async function stop() { if (!running) return; const previous = running; running = null; previous.server.closeAllConnections(); await new Promise((resolve) => previous.server.close(resolve)); previous.close(); }
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, method = "GET", body) {
    const response = await fetch(running.url + path, { method, headers: { Cookie: owner.cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const roles = Object.fromEntries(["ocr", "annotation", "segmentation", "chat"].map((role) => [role, { providerId: "openai", model: "reasoner" }]));
  const check = (role) => request("/api/ai/models/test", "POST", { ...roles[role], role });
  const save = (version) => request("/api/ai/roles", "PUT", { version, roles, annotationReferenceImage: false });
  return { request, roles, check, save, tests, calls, async restart() { await stop(); await start(); } };
}

test("角色推理设置精确校验、原子保存、版本冲突及重启保留，默认记录保持兼容", async (t) => {
  const h = await harness(t), { roles, request, check, save } = h;
  for (const role of ["ocr", "annotation"]) roles[role].reasoning = { effort: "low" };
  for (const role of ["segmentation", "chat"]) roles[role].reasoning = { effort: "high" };
  await check("ocr"); await check("chat");
  assert.equal((await save(0)).status, 409, "高强度分句不能复用低强度 JSON 测试");
  assert.equal((await request("/api/ai/roles")).data.version, 0);
  await check("segmentation");
  const saved = await save(0); assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.deepEqual(saved.data.roles.annotation.reasoning, { effort: "low" });
  assert.deepEqual(saved.data.roles.segmentation.reasoning, { effort: "high" });
  assert.equal((await save(0)).status, 409);
  roles.annotation.reasoning = { effort: "ultra" };
  assert.equal((await save(1)).status, 409);
  assert.deepEqual((await request("/api/ai/roles")).data.roles.annotation.reasoning, { effort: "low" });
  const invalidTest = await check("annotation"); assert.equal(invalidTest.status, 400);
  for (const role of Object.keys(roles)) { delete roles[role].reasoning; roles[role].model = "plain"; }
  await check("ocr"); await check("chat");
  const defaults = await save(1); assert.equal(defaults.status, 200);
  for (const role of Object.keys(roles)) assert.equal(defaults.data.roles[role].reasoning, undefined);
  assert.deepEqual(defaults.data.roles.correction.reasoning, { effort: "low" }, "旧客户端不覆盖已经独立保存的正文校正角色");
  await h.restart();
  const reopened = (await request("/api/ai/roles")).data;
  assert.equal(reopened.version, 2); assert.deepEqual(reopened.roles, defaults.data.roles);
  assert.ok(Object.values(reopened.readiness).every((role) => role.ready));
});

test("实际调用与记录使用角色推理设置，改变问答强度更换远端会话并保留网站历史", async (t) => {
  const h = await harness(t), { roles, request, check, save, calls } = h;
  roles.annotation.reasoning = { effort: "low", enabled: true, budgetTokens: 2048 };
  roles.segmentation.reasoning = { effort: "high" };
  roles.chat.reasoning = { effort: "low" };
  for (const role of Object.keys(roles)) assert.equal((await check(role)).status, 200);
  assert.equal((await save(0)).status, 200);
  const annotated = await request("/api/ai/annotate", "POST", { bodyHtml: "<p>日本語。</p>" });
  assert.equal(annotated.status, 200, JSON.stringify(annotated.data));
  assert.deepEqual(calls.at(-1).reasoning, roles.annotation.reasoning);
  assert.deepEqual(annotated.data.execution.reasoning, roles.annotation.reasoning);
  const created = await request("/api/documents", "POST", { title: "推理配置测试", kind: "article", orientation: "horizontal", content: "日本語。" });
  const segmented = await request(`/api/documents/${created.data.id}/sentences`, "POST", { revision: created.data.revision, bodyHash: created.data.bodyHash });
  assert.equal(segmented.status, 200); assert.deepEqual(calls.at(-1).reasoning, { effort: "high" });
  const current = (await request(`/api/documents/${created.data.id}`)).data;
  const selection = { start: 0, end: 3, text: "日本語", bodyHash: current.bodyHash, sentenceIds: bodyRanges(current.bodyHtml).sentences.map((sentence) => sentence.id) };
  const first = await request(`/api/documents/${current.id}/conversations`, "POST", { selection, question: "解释" });
  assert.equal(first.status, 201);
  const conversation = first.data.conversation || first.data;
  assert.deepEqual(conversation.messages.at(-1).execution.reasoning, { effort: "low" });
  roles.chat.reasoning = { effort: "high" };
  await check("chat"); assert.equal((await save(1)).status, 200);
  const follow = await request(`/api/conversations/${conversation.id}/messages`, "POST", { groupId: conversation.groups[0].id, question: "继续" });
  assert.equal(follow.status, 200, JSON.stringify(follow.data));
  assert.equal(calls.at(-1).threadId, null); assert.deepEqual(calls.at(-1).reasoning, { effort: "high" });
  assert.match(calls.at(-1).prompt, /previousMessages/);
  const messages = (follow.data.conversation || follow.data).messages;
  assert.equal(messages.length, 4); assert.deepEqual(messages.at(-1).execution.reasoning, { effort: "high" });
});
