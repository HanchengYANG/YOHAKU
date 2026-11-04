import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { ensureSession, cookieFromResponse } from "./helpers/session.mjs";
import { requiredCapabilities, roleReport } from "../shared/ai-roles.mjs";
import { bodyRanges, bodyText } from "../shared/article-html.mjs";

async function harness(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-roles-"));
  const states = new Map(["openai", "api_base"].map((id) => [id, { connected: true, credential: "grant-1", reports: [], calls: [], tests: [], wait: null }]));
  let running;
  function service(_owner, id) {
    const state = states.get(id);
    const account = () => ({ connected: state.connected, credentialId: state.credential, activeAccountId: state.credential, subject: id + state.credential });
    const models = [{ id: "vision" }, { id: "text" }, { id: "chat-2" }];
    return { auth: { status: async () => account(), accounts: async () => ({ accounts: [], activeId: state.credential }) },
      credentialStatus: async () => account(), knownModels: async () => { if (state.catalogWait) { const wait = state.catalogWait; state.catalogWait = null; await wait; } return models; }, models: async () => ({ models }),
      testReports: async () => state.reports.filter((r) => r.credential === state.credential),
      testModel: async (model, { role, referenceImage }) => {
        state.tests.push({ model, role, referenceImage });
        const checks = {};
        for (const capability of requiredCapabilities(role, referenceImage)) checks[capability] = { state: model === "text" && capability === "image" ? "unsupported" : "supported", checkedAt: new Date().toISOString() };
        const report = { model, credential: state.credential, checkedAt: new Date().toISOString(), checks: { ...state.reports.find((r) => r.model === model && r.credential === state.credential)?.checks, ...checks } };
        state.reports = [...state.reports.filter((r) => !(r.model === model && r.credential === state.credential)), report];
        return roleReport(state.reports, model, role, referenceImage);
      },
      runtime: { status: () => ({ busy: false, model: "vision" }), stop() {}, async run(input) {
        state.calls.push(input);
        if (state.wait) { const wait = state.wait; state.wait = null; await wait; }
        let output = "解释完成";
        if (input.schema?.properties?.text) output = JSON.stringify({ text: "日本語。" });
        else if (input.prompt.includes("输入目标：")) {
          const blocks = JSON.parse(input.prompt.split("输入目标：\n")[1]);
          output = JSON.stringify({ blocks: blocks.map((block) => ({ words: /日本語/.test(block.text) ? [{ t: "日本語", r: "にほんご" }] : [] })) });
        } else if (input.prompt.includes("输入正文：")) output = JSON.stringify({ sentences: [JSON.parse(input.prompt.split("输入正文：\n")[1])] });
        await input.onEvent?.({ type: "delta", delta: output });
        return { text: output, completed: true, model: input.model || "vision", threadId: input.threadId || `thread-${state.calls.length}`, webSearch: { enabled: id === "openai", performed: false } };
      } },
    };
  }
  async function start() {
    const { app, close } = createApp({ dataDir, aiServices: service, imageTaskOptions: { enabled: false } });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    running = { server, close, url: `http://127.0.0.1:${server.address().port}` };
  }
  async function stop() { if (!running) return; const old = running; running = null; old.server.closeAllConnections(); await new Promise((r) => old.server.close(r)); old.close(); }
  await start(); let owner = await ensureSession(running.url);
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  const request = async (path, method = "GET", body, cookie = owner.cookie) => {
    const res = await fetch(running.url + path, { method, headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json(), cookie: res.headers.getSetCookie().find((value) => value.startsWith("yohaku_session="))?.split(";")[0] };
  };
  const roles = { ocr: { providerId: "openai", model: "vision" }, annotation: { providerId: "api_base", model: "text" }, segmentation: { providerId: "api_base", model: "text" }, chat: { providerId: "openai", model: "vision" } };
  const testRole = (role, referenceImage = false) => request("/api/ai/models/test", "POST", { ...roles[role], role, referenceImage });
  const save = (version = 0, extra = {}) => request("/api/ai/roles", "PUT", { version, roles, annotationReferenceImage: false, ...extra });
  const upload = async () => { const data = new FormData(); data.set("image", new Blob([await sharp({ create: { width: 20, height: 20, channels: 3, background: "white" } }).png().toBuffer()], { type: "image/png" }), "roles.png"); return (await fetch(running.url + "/api/images", { method: "POST", headers: { Cookie: owner.cookie }, body: data })).json(); };
  return { states, request, roles, testRole, save, upload, owner, async restart() { await stop(); await start(); owner = await ensureSession(running.url); } };
}

test("角色配置：四项全就绪才原子启用，兼容能力复用、版本冲突、权限和凭据失效", async (t) => {
  const h = await harness(t), { request, save, testRole, states } = h;
  assert.equal((await request("/api/ai/roles")).data.enabled, false);
  assert.equal((await save()).status, 409);
  for (const role of ["ocr", "annotation", "chat"]) assert.equal((await testRole(role)).data.passed, true);
  assert.equal((await save()).status, 200, "分句可复用同模型 JSON 测试，无须图片能力");
  assert.deepEqual(states.get("api_base").tests, [{ model: "text", role: "annotation", referenceImage: false }]);
  assert.equal((await save()).status, 409, "过期版本不得覆盖");
  assert.equal((await save(1, { annotationReferenceImage: true })).status, 409);
  assert.equal((await request("/api/ai/roles")).data.version, 1);
  assert.equal((await request("/api/providers/active", "POST", { providerId: "api_base" })).status, 409);
  assert.equal((await request("/api/ai/model", "POST", { model: "text" })).status, 409);
  const invitation = await request("/api/invitations", "POST", {});
  const friend = await request("/api/accounts/register", "POST", {
    username: "role_friend", password: "fixture-friend-password", inviteToken: invitation.data.token,
  }, "");
  assert.equal(friend.status, 201);
  for (const [path, method, body] of [["/api/ai/roles", "GET"], ["/api/ai/roles", "PUT", { version: 1, roles: h.roles, annotationReferenceImage: false }],
    ["/api/ai/models?providerId=openai", "GET"], ["/api/ai/models/test", "POST", { providerId: "openai", model: "vision", role: "ocr" }]])
    assert.equal((await request(path, method, body, friend.cookie)).status, 403);
  const shared = (await request("/api/ai/status", "GET", undefined, friend.cookie)).data;
  for (const key of ["configuration", "accounts", "subject", "activeAccountId"]) assert.equal(shared[key], undefined);
  assert.equal(shared.roles.annotation.ready, true);
  assert.equal((await request("/api/ai/roles", "GET", null, "")).status, 401);
  states.get("api_base").credential = "grant-2";
  assert.equal((await save(1)).status, 409);
  const state = (await request("/api/ai/roles")).data;
  assert.equal(state.version, 1);
  assert.equal(state.readiness.annotation.ready, false);
  assert.equal(state.readiness.ocr.ready, true);
  const callsBefore = [...states.values()].reduce((n, s) => n + s.calls.length, 0);
  assert.equal(callsBefore, 0, "读取和保存配置不执行推理");
  await h.restart(); assert.equal((await request("/api/ai/roles")).data.version, 1);
});

test("混合路由与纯文字注音：正文和标记保留、图片可选、问答模型切换保留历史", async (t) => {
  const h = await harness(t), { request, testRole, save, states, roles } = h;
  for (const role of ["ocr", "annotation", "chat"]) await testRole(role);
  assert.equal((await save()).status, 200);
  const image = await h.upload();
  const ocr = await request(`/api/images/${image.id}/recognize`, "POST", {});
  assert.equal(ocr.status, 200); assert.equal(ocr.data.execution.providerId, "openai");
  const html = `<p data-paragraph-id="p"><span data-source-image-id="${image.id}"><span data-sentence-id="s"><mark data-qa-group-ids="q">日本語。</mark></span></span></p>`;
  const annotated = await request("/api/ai/annotate", "POST", { bodyHtml: html, sourceImageId: image.id });
  assert.equal(annotated.status, 200, JSON.stringify(annotated.data));
  assert.equal(bodyText(annotated.data.bodyHtml), "日本語。");
  assert.deepEqual(bodyRanges(annotated.data.bodyHtml), bodyRanges(html));
  assert.equal(annotated.data.annotation.imageReference, null);
  assert.equal(states.get("api_base").calls.at(-1).image, undefined);
  assert.equal(annotated.data.execution.model, "text");
  const created = await request("/api/documents", "POST", { title: "角色测试", kind: "article", orientation: "horizontal", content: "日本語。" });
  const segmented = await request(`/api/documents/${created.data.id}/sentences`, "POST", { revision: created.data.revision, bodyHash: created.data.bodyHash });
  assert.equal(segmented.status, 200);
  assert.equal(states.get("api_base").calls.at(-1).model, "text");
  const current = (await request(`/api/documents/${created.data.id}`)).data;
  const selection = { start: 0, end: 3, text: "日本語", bodyHash: current.bodyHash, sentenceIds: bodyRanges(current.bodyHtml).sentences.map((s) => s.id) };
  const first = await request(`/api/documents/${current.id}/conversations`, "POST", { selection, question: "解释" });
  assert.equal(first.status, 201);
  const conversation = first.data.conversation || first.data;
  roles.chat.model = "chat-2"; await testRole("chat"); assert.equal((await save(1)).status, 200);
  const follow = await request(`/api/conversations/${conversation.id}/messages`, "POST", { groupId: conversation.groups[0].id, question: "继续" });
  assert.equal(follow.status, 200, JSON.stringify(follow.data));
  const call = states.get("openai").calls.at(-1);
  assert.equal(call.threadId, null); assert.equal(call.model, "chat-2"); assert.match(call.prompt, /previousMessages/);
  assert.equal((follow.data.conversation || follow.data).messages.length, 4);
});

test("排队步骤在开始时读取最新提供方与模型，已开始调用固定配置", async (t) => {
  const h = await harness(t), { request, testRole, save, states, roles } = h;
  for (const role of ["ocr", "annotation", "chat"]) await testRole(role);
  await save(); const image = await h.upload();
  let release; states.get("openai").wait = new Promise((r) => release = r);
  const first = request(`/api/images/${image.id}/recognize`, "POST", {});
  while (!states.get("openai").calls.length) await new Promise((r) => setTimeout(r, 5));
  const second = request(`/api/images/${image.id}/recognize`, "POST", {});
  await new Promise((r) => setTimeout(r, 25));
  roles.ocr = { providerId: "api_base", model: "vision" }; await testRole("ocr");
  assert.equal((await save(1)).status, 200);
  release();
  assert.equal((await first).data.execution.configurationVersion, 1);
  const latest = await second;
  assert.equal(latest.status, 200); assert.equal(latest.data.execution.providerId, "api_base");
  assert.equal(latest.data.execution.configurationVersion, 2);
});


test("可选原图只在实际传图时标注，开启参考图后无图文章仍走文字", async (t) => {
  const h = await harness(t), { request, testRole, save, roles, states } = h;
  roles.annotation = { providerId: "api_base", model: "vision" };
  for (const role of ["ocr", "annotation", "segmentation", "chat"]) await testRole(role);
  assert.equal((await testRole("annotation", true)).data.passed, true);
  assert.equal((await save(0, { annotationReferenceImage: true })).status, 200);
  const image = await h.upload();
  const body = { bodyHtml: "<p>日本語。</p>" };
  const text = await request("/api/ai/annotate", "POST", body);
  assert.equal(text.status, 200); assert.equal(text.data.annotation.imageReference, null);
  assert.equal(states.get("api_base").calls.at(-1).image, undefined);
  const withImage = await request("/api/ai/annotate", "POST", { ...body, sourceImageId: image.id });
  assert.equal(withImage.status, 200);
  assert.equal(withImage.data.annotation.imageReference.imageId, image.id);
  assert.match(states.get("api_base").calls.at(-1).image, /^data:image/);
});


test("保存期间并发管理操作导致冲突，角色状态独立于旧全局连接", async (t) => {
  const h = await harness(t), { request, testRole, save, states, roles } = h;
  for (const role of Object.keys(roles)) roles[role] = { providerId: "api_base", model: "vision" };
  for (const role of Object.keys(roles)) await testRole(role);
  await save();
  states.get("openai").connected = false;
  const status = (await request("/api/ai/status")).data;
  assert.equal(status.connected, true); assert.equal(status.ready, true); assert.equal(status.requiresLogin, false);
  assert.equal(status.lastError, null); assert.equal(status.roles.ocr.providerId, "api_base");
  assert.equal((await request("/api/ai/status?providerId=openai")).data.connected, false);
  let release; states.get("api_base").catalogWait = new Promise((r) => release = r);
  const saving = save(1);
  await new Promise((r) => setTimeout(r, 30));
  await testRole("annotation");
  release();
  assert.equal((await saving).status, 409);
  assert.equal((await request("/api/ai/roles")).data.version, 1);
});
