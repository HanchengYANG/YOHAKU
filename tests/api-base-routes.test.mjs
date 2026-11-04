// HTTP/database integration against a local fake upstream and the real AI SDK.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { createProviderConnection } from "../server/providers/index.mjs";
import { API_BASE_DEFAULTS } from "../server/providers/api-base/index.mjs";
import { ensureSession, cookieFromResponse } from "./helpers/session.mjs";
import { bodyRanges } from "../shared/article-html.mjs";
import { readEventStream } from "../shared/event-stream.mjs";

test("iliad codix真实路由：固定地址、仅拥有者保存密钥，全站共享，模型验证与重启保持配置", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-api-base-http-"));
  const key = "fixture-only-private-api-key", calls = [], modelCalls = [];
  let incomplete = false;
  const upstream = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      modelCalls.push(req.headers.authorization);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "codiX-agent" }, { id: "Qwen/Qwen3.6-35B" }, { id: "codiX-embedding" }] }));
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    calls.push({ url: req.url, authorization: req.headers.authorization, body });
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      for (const text of ["这是一段", "测试解释。"])
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
      if (!incomplete) res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    const prompt = body.messages.at(-1).content;
    const text = typeof prompt === "string" ? prompt : prompt[0].text;
    let output = { text: "日本語。" };
    if (text.includes('{"ok":true}')) output = { ok: true };
    if (text.includes("输入目标：")) output = { blocks: [{ words: [{ t: "日本語", r: "にほんご" }] }] };
    if (text.includes("输入正文：")) output = { sentences: [JSON.parse(text.split("\n输入正文：\n").at(-1))] };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "http-fixture", choices: [{
      message: { role: "assistant", content: text.includes("读取图片中的数字") ? "42" : JSON.stringify(output) }, finish_reason: "stop",
    }] }));
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  let running;
  async function stop() {
    if (!running) return;
    const previous = running;
    running = null;
    const done = new Promise((resolve) => previous.server.close(resolve));
    previous.server.closeAllConnections();
    await done;
    previous.close();
  }
  t.after(async () => {
    await stop();
    const done = new Promise((resolve) => upstream.close(resolve));
    upstream.closeAllConnections();
    await done;
    await rm(dataDir, { recursive: true, force: true });
  });
  async function start() {
    const { app, close } = createApp({ dataDir,
      aiServices: (ownerId, providerId) => providerId === "api_base" ? createProviderConnection({
        providerId, storageDir: join(dataDir, "users", ownerId, "providers"),
        apiBaseOptions: { fetchImpl: (url, init) => {
          assert.equal(new URL(url).origin, new URL(API_BASE_DEFAULTS.baseURL).origin);
          return fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init);
        } },
      }) : undefined,
    });
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    running = { close, server, url: `http://127.0.0.1:${server.address().port}` };
    return ensureSession(running.url);
  }
  let owner = await start();
  async function request(path, method = "GET", body, cookie = owner.cookie) {
    const response = await fetch(running.url + path, { method,
      headers: { Cookie: cookie, ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
    const data = await response.json();
    assert.ok(!JSON.stringify(data).includes(key), "HTTP响应不能回显密钥");
    return { status: response.status, data };
  }
  assert.equal((await request("/api/ai/configuration", "PUT", {})).status, 405);
  assert.equal((await request("/api/ai/models")).status, 405);
  const initial = await request("/api/ai/status?providerId=api_base");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.connected, false);
  assert.equal(initial.data.configuration.models.length, 7);
  assert.equal(initial.data.activeProviderId, "openai");
  assert.equal((await request("/api/ai/models?providerId=api_base")).status, 503);
  assert.equal((await request("/api/ai/login", "POST", { providerId: "api_base" })).status, 405);
  const saved = await request("/api/ai/configuration", "PUT", { providerId: "api_base", model: "codiX-agent", apiKey: key });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.configuration.baseURL, API_BASE_DEFAULTS.baseURL);
  const redirected = await request("/api/ai/configuration", "PUT", { providerId: "api_base", baseURL: "https://other.test/v1", apiKey: "fixture-wrong-key" });
  assert.equal(redirected.status, 400);
  assert.equal(saved.data.connected, false);
  assert.equal(saved.data.configuration.hasKey, true);
  assert.equal(saved.data.configuration.activeModel, null);
  assert.equal((await request("/api/providers/active", "POST", { providerId: "api_base", model: "codiX-agent" })).status, 409);
  assert.equal((await request("/api/providers")).data.activeProviderId, "openai");
  assert.equal(calls.length, 0, "保存配置不应发起真实推理");
  const catalog = await request("/api/ai/models?providerId=api_base");
  assert.equal(catalog.status, 200);
  assert.deepEqual(catalog.data.models.map((model) => model.id), ["codiX-agent", "Qwen/Qwen3.6-35B"]);
  assert.equal(catalog.data.excluded, 1);
  assert.deepEqual(modelCalls, [`Bearer ${key}`]);
  const tested = await request("/api/ai/models/test", "POST", { providerId: "api_base", model: "codiX-agent" });
  assert.equal(tested.status, 200);
  assert.equal(tested.data.passed, true);
  assert.equal(calls.length, 3);
  assert.equal((await request("/api/ai/status")).data.connected, false);
  const activated = await request("/api/providers/active", "POST", { providerId: "api_base", model: "codiX-agent" });
  assert.equal(activated.status, 200);
  assert.equal(activated.data.connected, true);
  const identity = activated.data.subject;
  calls.length = 0;
  const invitation = await request("/api/invitations", "POST", {});
  const registered = await fetch(running.url + "/api/accounts/register", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({
      username: "api_friend", password: "fixture-friend-password", inviteToken: invitation.data.token,
    }) });
  assert.equal(registered.status, 201);
  const friend = cookieFromResponse(registered);
  const shared = (await request("/api/ai/status", "GET", null, friend)).data;
  assert.equal(shared.connected, true);
  assert.equal(shared.providerId, "api_base");
  assert.equal((await request("/api/ai/models", "GET", null, friend)).status, 403);
  assert.equal((await request("/api/ai/status?providerId=openai", "GET", null, friend)).status, 403);
  assert.equal(modelCalls.length, 1);
  for (const name of ["configuration", "subject", "activeAccountId", "accounts"]) assert.equal(shared[name], undefined);
  for (const [path, method, body] of [["/api/ai/configuration", "PUT", { model: "other", apiKey: key }],
    ["/api/ai/models/test", "POST", { model: "codiX-agent" }],
    ["/api/ai/model", "POST", { model: "codiX-agent" }],
    ["/api/ai/logout", "POST", {}], ["/api/providers/active", "POST", { providerId: "openai" }]])
    assert.equal((await request(path, method, body, friend)).status, 403);
  const pixels = await sharp({ create: { width: 20, height: 30, channels: 3, background: "white" } }).png().toBuffer();
  const form = new FormData();
  form.set("image", new Blob([pixels], { type: "image/png" }), "fixture.png");
  const uploaded = await fetch(running.url + "/api/images", { method: "POST", headers: { Cookie: friend }, body: form });
  assert.equal(uploaded.status, 201);
  const image = await uploaded.json();
  const recognized = await request(`/api/images/${image.id}/recognize`, "POST", {}, friend);
  assert.equal(recognized.status, 200);
  assert.equal(recognized.data.content, "日本語。");
  assert.equal(recognized.data.providerId, "api_base");
  const annotated = await request(`/api/images/${image.id}/annotate`, "POST", { content: recognized.data.content }, friend);
  assert.equal(annotated.status, 200);
  assert.match(annotated.data.content, /にほんご/);
  const created = await request("/api/documents", "POST", { title: "API测试文章", kind: "article",
    orientation: "horizontal", content: annotated.data.content }, friend);
  assert.equal(created.status, 201);
  const document = created.data;
  const segmented = await request(`/api/documents/${document.id}/sentences`, "POST", {
    revision: document.revision, bodyHash: document.bodyHash,
  }, friend);
  assert.equal(segmented.status, 200);
  const current = (await request(`/api/documents/${document.id}`, "GET", null, friend)).data;
  const selection = { start: 0, end: 3, text: "日本語", bodyHash: current.bodyHash,
    sentenceIds: bodyRanges(current.bodyHtml).sentences.map((sentence) => sentence.id) };
  const discussionPath = `/api/documents/${document.id}/conversations`;
  async function ask() {
    const response = await fetch(running.url + discussionPath, { method: "POST",
      headers: { Cookie: friend, "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify({ selection, question: "解释这个词" }) });
    return (await Array.fromAsync(readEventStream(response.body))).map((frame) => JSON.parse(frame.data));
  }
  const events = await ask();
  assert.equal(events.filter((event) => event.type === "delta").map((event) => event.delta).join(""), "这是一段测试解释。");
  assert.equal(events.at(-1).type, "done");
  const conversation = events.at(-1).conversation;
  assert.deepEqual(conversation.messages.at(-1).webSearch, { enabled: false, performed: false });
  assert.equal(calls.length, 4);
  assert.ok(calls.every((call) => call.authorization === `Bearer ${key}` && call.url === "/v1/chat/completions"));
  assert.equal(calls.filter((call) => Array.isArray(call.body.messages.at(-1).content)).length, 2);
  incomplete = true;
  const failed = await ask();
  assert.equal(failed.at(-1).type, "error");
  assert.equal(failed.some((event) => event.type === "done"), false);
  const restored = (await request(discussionPath, "GET", null, friend)).data.conversations[0];
  assert.deepEqual(restored.messages, conversation.messages);
  await stop();
  owner = await start();
  const reopened = (await request("/api/ai/status")).data;
  assert.equal(reopened.providerId, "api_base");
  assert.equal(reopened.connected, true);
  assert.equal(reopened.subject, identity);
  assert.equal((await request("/api/ai/logout", "POST", {})).status, 200);
  assert.equal((await request("/api/ai/status")).data.connected, false);
});
