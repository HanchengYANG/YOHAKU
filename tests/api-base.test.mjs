// Real AI SDK with an explicit HTTP transport double; no real key or inference.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProviderConnection } from "../server/providers/index.mjs";
import { API_BASE_DEFAULTS, CODIX_MODELS } from "../server/providers/api-base/index.mjs";

const key = "fixture-only-codix-private-key";
const complete = (text = "测试答案", finishReason = "stop") => Response.json({
  id: "chatcmpl-test", created: 1, model: "fixture-model",
  choices: [{ message: { role: "assistant", content: text }, finish_reason: finishReason }],
});
const stream = (frames) => new Response(frames.map((frame) =>
  `data: ${typeof frame === "string" ? frame : JSON.stringify(frame)}\n\n`).join(""),
  { headers: { "Content-Type": "text/event-stream" } });
const chunk = (text, finishReason = null) => ({ model: "fixture-model", choices: [{
  delta: { content: text }, finish_reason: finishReason,
}] });

async function setup(t, options = {}) {
  const storageDir = await mkdtemp(join(tmpdir(), "yohaku-api-base-"));
  const requests = [];
  let reply = () => complete();
  const connection = createProviderConnection({ providerId: "api_base", storageDir,
    apiBaseOptions: { ...options, fetchImpl: async (url, init) => {
      requests.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined });
      return reply(url, init);
    } } });
  t.after(async () => { connection.close(); await rm(storageDir, { recursive: true, force: true }); });
  return { connection, storageDir, requests, reply: (handler) => { reply = handler; },
    configure: (settings = {}) => connection.configure({ ...API_BASE_DEFAULTS, apiKey: key, ...settings }),
    enable: async (model = "codiX-agent") => {
      const previous = reply;
      reply = (_url, init) => {
        const body = JSON.parse(init.body);
        return body.stream ? stream([chunk("OK", "stop"), "[DONE]"])
          : complete(body.response_format ? '{"ok":true}' : "42");
      };
      try {
        assert.equal((await connection.testModel(model)).passed, true);
        await connection.selectModel(model);
      } finally { reply = previous; requests.length = 0; }
    },
  };
}

test("iliad codix未配置时不发送请求，状态给出固定地址与七个模型且不创建密钥文件", async (t) => {
  const { connection, requests, storageDir } = await setup(t);
  const status = await connection.status();
  assert.equal(status.connected, false);
  assert.equal(status.label, "iliad codix");
  assert.equal(status.configuration.baseURL, API_BASE_DEFAULTS.baseURL);
  assert.equal(status.configuration.models.length, 7);
  assert.equal(status.configuration.models[6].id, "Qwen/Qwen3-235B-A22B-Instruct-2507");
  await assert.rejects(connection.runtime.run({ prompt: "不能发出" }), /保存 API key/);
  await assert.rejects(connection.models(), /先保存 API key/);
  assert.equal(requests.length, 0);
  assert.deepEqual(await readdir(storageDir), []);
});

test("服务端模型列表使用已保存密钥，去重过滤其他用途模型，不改变当前选择或泄漏密钥", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  fixture.reply(() => Response.json({ data: [
    { id: "Qwen/Qwen3.6-35B" }, { id: "Zai/GLM-5.2" }, { id: "Qwen/Qwen3.6-35B" },
    { id: "Qwen/Qwen3-Embedding-8B" }, { id: "codiX-embedding" }, { id: "codiX-autocomplete" },
    { id: "bad model" }, { id: key }, {},
  ] }));
  const catalog = await fixture.connection.models();
  assert.equal(catalog.total, 5);
  assert.equal(catalog.excluded, 3);
  assert.deepEqual(catalog.models.map((model) => model.id), ["Qwen/Qwen3.6-35B", "Zai/GLM-5.2"]);
  assert.equal(fixture.requests[0].url, `${API_BASE_DEFAULTS.baseURL}/models`);
  assert.equal(new Headers(fixture.requests[0].headers).get("authorization"), `Bearer ${key}`);
  assert.equal(fixture.requests[0].redirect, "error");
  const configuration = await fixture.connection.configuration();
  assert.equal(configuration.modelsSource, "server");
  assert.equal(configuration.model, "codiX-agent");
  assert.doesNotMatch(JSON.stringify(catalog), new RegExp(key));
  await fixture.configure({ model: "Zai/GLM-5.2", apiKey: "" });
  assert.equal((await fixture.connection.configuration()).modelsSource, "server");
  await fixture.configure({ apiKey: "fixture-another-key" });
  assert.equal((await fixture.connection.configuration()).modelsSource, "preset");
});

test("模型列表拒绝无效格式，鉴权和上游错误不回显密钥；失败保留现有配置", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  for (const payload of [{ secret: key }, null, { data: "not a list" }]) {
    fixture.reply(() => Response.json(payload));
    await assert.rejects(fixture.connection.models(), (error) => error.status === 502 && !error.message.includes(key));
  }
  for (const status of [401, 403, 404, 405, 500]) {
    fixture.reply(() => Response.json({ error: { message: key } }, { status }));
    await assert.rejects(fixture.connection.models(), (error) =>
      error.status === ([401, 403].includes(status) ? status : 502) && !error.message.includes(key));
  }
  assert.equal((await fixture.connection.configuration()).model, "codiX-agent");
  assert.equal((await fixture.connection.configuration()).hasKey, true);
  assert.equal((await fixture.connection.auth.status()).connected, false);
});

test("密钥以600权限保存、不回显，重启保持身份；空白保留密钥、更新密钥轮换身份、移除后可重开", async (t) => {
  const { connection, storageDir, requests, configure, enable } = await setup(t);
  await configure();
  assert.equal(requests.length, 0);
  assert.equal((await connection.auth.status()).connected, false);
  await enable();
  const first = await connection.status();
  assert.equal(first.connected, true);
  assert.equal(first.configuration.hasKey, true);
  assert.doesNotMatch(JSON.stringify(first), new RegExp(key));
  const filename = join(storageDir, "api_base", "connection.json");
  assert.equal((await stat(filename)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).apiKey, key);
  const reopened = createProviderConnection({ providerId: "api_base", storageDir });
  t.after(() => reopened.close());
  assert.equal((await reopened.status()).authentication.subject, first.authentication.subject);
  await configure({ model: CODIX_MODELS[2].id, apiKey: "" });
  assert.equal((await connection.auth.status()).subject, first.authentication.subject);
  assert.equal(JSON.parse(await readFile(filename, "utf8")).apiKey, key);
  await configure({ apiKey: "fixture-replacement-key" });
  assert.notEqual((await connection.auth.status()).subject, first.authentication.subject);
  await connection.auth.disconnect();
  assert.equal((await connection.status()).connected, false);
  const disconnected = createProviderConnection({ providerId: "api_base", storageDir });
  t.after(() => disconnected.close());
  assert.equal((await disconnected.status()).connected, false);
  assert.doesNotMatch(await readFile(filename, "utf8"), /fixture-replacement-key/);
  assert.equal(requests.length, 0);
});

test("拒绝修改固定地址或无效密钥，只保存key也保持原地址与模型", async (t) => {
  const { connection, configure } = await setup(t);
  await configure();
  for (const patch of [{ baseURL: "file:///tmp/key" }, { baseURL: "http://external.test/v1" },
    { baseURL: "https://user:password@host.test/v1" }, { baseURL: "https://host.test/v1?key=private" },
    { baseURL: "https://host.test/v1#private" }, { apiKey: "YOUR_API_KEY" }, { apiKey: "line\nbreak" },
    { apiKey: 7 }])
    await assert.rejects(configure(patch), (error) => error.status === 400);
  await assert.rejects(configure({ baseURL: "https://another.test/v1", apiKey: "" }), /服务地址固定/);
  assert.equal((await connection.configuration()).baseURL, API_BASE_DEFAULTS.baseURL);
  assert.equal((await connection.configuration()).hasKey, true);
  assert.equal((await connection.auth.status()).connected, false);
  await assert.rejects(configure({ baseURL: "http://127.0.0.1:1234/v1" }), /服务地址固定/);
  await connection.configure({ apiKey: "", model: "custom-model" });
  assert.equal((await connection.configuration()).baseURL, API_BASE_DEFAULTS.baseURL);
  assert.equal((await connection.configuration()).model, "codiX-agent", "保存 API 配置不能切换模型");
  for (const model of ["", "not a model", null])
    await assert.rejects(connection.testModel(model), (error) => error.status === 400);
});

test("真实SDK发送Bearer、原始模型ID、图片消息和JSON模式，返回结果适配余白且标记未联网", async (t) => {
  const fixture = await setup(t);
  await fixture.configure({ model: CODIX_MODELS[2].id });
  await fixture.enable(CODIX_MODELS[2].id);
  fixture.reply(() => complete('{"text":"日本語。"}'));
  const account = await fixture.connection.auth.status();
  const result = await fixture.connection.runtime.run({ prompt: "识别原图", image: "data:image/png;base64,AA==",
    schema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
    expectedAccountId: account.activeAccountId, expectedSubject: account.subject });
  assert.equal(fixture.requests.length, 1);
  const request = fixture.requests[0];
  assert.equal(request.url, `${API_BASE_DEFAULTS.baseURL}/chat/completions`);
  assert.equal(new Headers(request.headers).get("authorization"), `Bearer ${key}`);
  assert.equal(request.body.model, CODIX_MODELS[2].id);
  assert.equal(request.body.max_tokens, CODIX_MODELS[2].limit.output);
  assert.deepEqual(request.body.response_format, { type: "json_object" });
  assert.match(request.body.messages[0].content, /JSON Schema/);
  assert.deepEqual(request.body.messages[1].content[1], { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } });
  assert.equal(result.completed, true);
  assert.deepEqual(JSON.parse(result.text), { text: "日本語。" });
  assert.equal(result.threadId, null);
  assert.equal(result.model, "fixture-model");
  assert.deepEqual(result.webSearch, { enabled: false, performed: false });
});

test("真实SDK流式增量可以显示，只有完整结束才能成功；问答明确无搜索工具", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  await fixture.enable();
  fixture.reply(() => stream([chunk("测试"), chunk("答案🙂", "stop"), "[DONE]"]));
  const events = [];
  const result = await fixture.connection.runtime.run({ prompt: "翻译", webSearch: true,
    onEvent: async (event) => events.push(event) });
  assert.equal(result.text, "测试答案🙂");
  assert.equal(events.map((event) => event.delta).join(""), result.text);
  assert.equal(fixture.requests[0].body.stream, true);
  assert.match(fixture.requests[0].body.messages[0].content, /没有网页搜索工具/);
  fixture.reply(() => stream([chunk("不能保存的部分输出"), "[DONE]"]));
  await assert.rejects(fixture.connection.runtime.run({ prompt: "会中断", onEvent: async () => {} }),
    (error) => error.status === 502);
  fixture.reply(() => stream([chunk("部分输出"), { error: { message: key, type: "server_error" } }, "[DONE]"]));
  await assert.rejects(fixture.connection.runtime.run({ prompt: "上游出错", onEvent: async () => {} }),
    (error) => error.status === 502 && !error.message.includes(key));
});

test("截断、空输出、非法JSON及上游鉴权或配额错误不泄漏密钥，不自动重复请求", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  await fixture.enable();
  for (const response of [complete("部分", "length"), complete(""), complete("not JSON")]) {
    fixture.reply(() => response);
    await assert.rejects(fixture.connection.runtime.run({ prompt: "校验", schema: { type: "object" } }),
      (error) => error.status === 502 && !error.message.includes(key));
  }
  for (const status of [401, 403, 404, 400, 429, 500]) {
    const before = fixture.requests.length;
    fixture.reply(() => Response.json({ error: { message: key } }, { status }));
    await assert.rejects(fixture.connection.runtime.run({ prompt: "错误" }),
      (error) => error.status === ([401, 403, 429].includes(status) ? status : 502) && !error.message.includes(key));
    assert.equal(fixture.requests.length, before + 1);
    assert.doesNotMatch(JSON.stringify(await fixture.connection.status()), new RegExp(key));
  }
});

test("请求取消或停止能释放运行时，忙碌时拒绝改密钥，过期身份不调用API", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  await fixture.enable();
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  fixture.reply((_url, init) => new Promise((_resolve, reject) => {
    started();
    init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
  }));
  const running = fixture.connection.runtime.run({ prompt: "会取消" });
  const rejection = assert.rejects(running, /取消或超时/);
  await ready;
  assert.equal(fixture.connection.runtime.status().busy, true);
  await assert.rejects(fixture.configure(), (error) => error.status === 409);
  await assert.rejects(fixture.connection.runtime.run({ prompt: "同时请求" }), (error) => error.status === 409);
  fixture.connection.runtime.stop();
  await rejection;
  assert.equal(fixture.connection.runtime.status().busy, false);
  await assert.rejects(fixture.connection.runtime.run({ prompt: "过期身份", expectedSubject: "old-subject" }), /配置已变化/);
  assert.equal(fixture.requests.length, 1);
});

test("保存key不启用模型，测试通过后仍需明确选用；服务端拦截未通过模型且绑定地址和key", async (t) => {
  const fixture = await setup(t);
  await fixture.configure({ model: "unverified-model", modelSelected: true });
  assert.equal((await fixture.connection.configuration()).activeModel, null);
  await assert.rejects(fixture.connection.selectModel("unverified-model"), (error) => error.status === 409);
  await assert.rejects(fixture.connection.runtime.run({ prompt: "不能绕过测试" }), /测试并启用/);
  assert.equal(fixture.requests.length, 0);
  fixture.reply((_url, init) => {
    const body = JSON.parse(init.body);
    return body.stream ? stream([chunk("OK", "stop"), "[DONE]"])
      : complete(body.response_format ? '{"ok":true}' : "42");
  });
  const report = await fixture.connection.testModel("Qwen/Qwen3.6-35B");
  assert.equal(report.passed, true);
  assert.ok(report.checkedAt);
  assert.equal(fixture.requests.length, 3);
  assert.deepEqual(Object.values(report.checks).map((check) => check.state), ["supported", "supported", "supported"]);
  assert.equal((await fixture.connection.auth.status()).connected, false);
  assert.doesNotMatch(JSON.stringify(report), new RegExp(key));
  const path = join(fixture.storageDir, "api_base", "model-checks.json");
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.doesNotMatch(await readFile(path, "utf8"), new RegExp(key));
  await fixture.connection.selectModel("Qwen/Qwen3.6-35B");
  assert.equal((await fixture.connection.configuration()).activeModel, "Qwen/Qwen3.6-35B");
  const reopened = createProviderConnection({ providerId: "api_base", storageDir: fixture.storageDir });
  t.after(() => reopened.close());
  assert.equal((await reopened.auth.status()).connected, true);
  await fixture.configure({ apiKey: "fixture-new-service-key" });
  assert.equal((await fixture.connection.auth.status()).connected, false);
  await assert.rejects(fixture.connection.selectModel("Qwen/Qwen3.6-35B"), /尚未通过/);
  assert.equal((await fixture.connection.configuration()).modelChecks.length, 0);
});

test("不支持图片和暂时出错分别显示，重新测试失败撤销当前模型资格，不自动改用其他模型", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  await fixture.enable();
  fixture.reply((_url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream) return stream([chunk("OK", "stop"), "[DONE]"]);
    if (body.response_format) return complete('{"ok":true}');
    return Response.json({ error: { message: "This is not a multimodal model" } }, { status: 400 });
  });
  const unsupported = await fixture.connection.testModel("codiX-agent");
  assert.equal(unsupported.passed, false);
  assert.equal(unsupported.checks.image.state, "unsupported");
  assert.equal((await fixture.connection.auth.status()).connected, false);
  await assert.rejects(fixture.connection.selectModel("codiX-agent"), /尚未通过/);
  fixture.reply((_url, init) => {
    const body = JSON.parse(init.body);
    return body.stream ? stream([chunk("OK", "stop"), "[DONE]"])
      : complete(body.response_format ? '{"ok":true}' : "42");
  });
  assert.equal((await fixture.connection.testModel("codiX-agent")).passed, true);
  assert.equal((await fixture.connection.auth.status()).connected, false, "重新通过后仍需明确启用");
  await fixture.connection.selectModel("codiX-agent");
  assert.equal((await fixture.connection.auth.status()).connected, true);
  fixture.reply(() => Response.json({ error: { message: key } }, { status: 401 }));
  const before = fixture.requests.length;
  const denied = await fixture.connection.testModel("codiX-agent");
  assert.equal(fixture.requests.length, before + 1, "鉴权失败不继续发送测试请求");
  assert.equal(denied.checks.image.state, "failed");
  assert.doesNotMatch(JSON.stringify(denied), new RegExp(key));
  const reports = (await fixture.connection.configuration()).modelChecks;
  assert.equal(reports.length, 1, "重测更新同一模型的记录");
  assert.equal(reports[0].passed, false);
});
