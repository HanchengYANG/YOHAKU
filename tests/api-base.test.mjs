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

test('API execution diagnostics retain only reported token counts and actual request parameters',async t=>{
  const f=await setup(t),model='Deepseek/deepseek-v4-flash-0731';await f.configure({model});
  f.reply(()=>Response.json({model,choices:[{message:{role:'assistant',content:'{"text":"synthetic"}'},finish_reason:'stop'}],
    usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,prompt_tokens_details:{cached_tokens:25},completion_tokens_details:{reasoning_tokens:30},authorization:'private-usage-field'}}));
  const input={model,prompt:'Synthetic JSON',schema:{type:'object'}};
  const result=await f.connection.runtime.run(input);
  assert.deepEqual(result.usage,{inputTokens:100,outputTokens:40,totalTokens:140,reasoningTokens:30,cachedInputTokens:25});
  assert.equal(result.maxOutputTokens,32768);assert.equal(result.reasoningParameterSent,false);
  assert.equal(Object.hasOwn(f.requests.at(-1).body,'reasoning_effort'),false);
  assert.doesNotMatch(JSON.stringify(result.usage),/authorization|private-usage-field|raw/);
  const explicit=await f.connection.runtime.run({...input,reasoning:{effort:'none'}});
  assert.equal(explicit.reasoningParameterSent,true);assert.equal(explicit.reasoningEffort,'none');
  assert.equal(f.requests.at(-1).body.reasoning_effort,'none');
});

test('length and invalid JSON failures preserve safe token usage and output budget without raw responses',async t=>{
  const f=await setup(t),model='Deepseek/deepseek-v4-flash-0731';await f.configure({model});
  for(const [finish,content,category] of [['length','{"text":"partial"}','incomplete_output'],['stop','private-invalid-json','invalid_json']]){
    f.reply(()=>Response.json({choices:[{message:{role:'assistant',content},finish_reason:finish}],usage:{prompt_tokens:12,completion_tokens:32768,total_tokens:32780,completion_tokens_details:{reasoning_tokens:32760}},privateResponse:'never-persist-response'}));
    await assert.rejects(f.connection.runtime.run({model,prompt:'Synthetic JSON',schema:{type:'object'}}),error=>{
      assert.equal(error.diagnostic.category,category);
      assert.deepEqual(error.execution?.usage,{inputTokens:12,outputTokens:32768,totalTokens:32780,reasoningTokens:32760});
      assert.equal(error.execution.maxOutputTokens,32768);assert.equal(error.execution.reasoningParameterSent,false);
      assert.doesNotMatch(JSON.stringify(error),/private-invalid-json|never-persist-response|fixture-only-codix-private-key/);return true;
    });
  }
});

test('missing or partially reported provider usage is not presented as zero token counts',async t=>{
  const f=await setup(t);await f.configure();
  for(const usage of [undefined,{prompt_tokens:7}]){
    f.reply(()=>Response.json({choices:[{message:{role:'assistant',content:'{"ok":true}'},finish_reason:'stop'}],...(usage?{usage}:{})}));
    const result=await f.connection.runtime.run({model:'codiX-agent',prompt:'Synthetic JSON',schema:{type:'object'}});
    assert.deepEqual(result.usage,usage?{inputTokens:7}:undefined);
  }
});

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
  const concurrent = fixture.connection.runtime.run({ prompt: "同时请求" });
  const concurrentRejected = assert.rejects(concurrent, /取消或超时/);
  await new Promise(setImmediate);
  assert.equal(fixture.requests.length, 2);
  fixture.connection.runtime.stop();
  await Promise.all([rejection, concurrentRejected]);
  assert.equal(fixture.connection.runtime.status().busy, false);
  await assert.rejects(fixture.connection.runtime.run({ prompt: "过期身份", expectedSubject: "old-subject" }), /配置已变化/);
  assert.equal(fixture.requests.length, 2);
});

test("处理诊断区分上游HTTP、网络与JSON错误，只保存安全字段", async (t) => {
  const f = await setup(t); await f.configure(); await f.enable();
  for (const [status, category, code] of [[503, 'upstream_http', 'AI_UPSTREAM_HTTP'], [429, 'rate_limit', 'AI_RATE_LIMIT'], [401, 'auth', 'AI_AUTH_ERROR']]) {
    f.reply(() => Response.json({error:{message:key}}, {status,headers:{Authorization:key,'x-request-id':key}}));
    await assert.rejects(f.connection.runtime.run({prompt:'正文校正'}), error => {
      assert.equal(error.diagnostic?.category,category); assert.equal(error.diagnostic?.code,code);
      assert.equal(error.diagnostic.httpStatus,status); assert.doesNotMatch(JSON.stringify(error.diagnostic),new RegExp(key)); return true;
    });
  }
  f.reply(() => { throw new TypeError(key,{cause:Object.assign(new Error(key),{code:'ECONNRESET',headers:{Authorization:key}})}); });
  await assert.rejects(f.connection.runtime.run({prompt:'正文校正'}), error => {
    assert.equal(error.diagnostic?.code,'AI_NETWORK_ERROR');assert.equal(error.diagnostic?.networkCode,'ECONNRESET');
    assert.doesNotMatch(JSON.stringify(error.diagnostic),new RegExp(key));return true;
  });
  f.reply(() => complete('not JSON'));
  await assert.rejects(f.connection.runtime.run({prompt:'正文校正',schema:{type:'object'}}), error => {
    assert.equal(error.diagnostic?.category,'invalid_json');assert.equal(error.diagnostic?.code,'AI_INVALID_JSON');return true;
  });
  f.reply(() => Response.json({choices:[{invalid:key}]}));
  await assert.rejects(f.connection.runtime.run({prompt:'正文校正'}), error => {
    assert.equal(error.diagnostic?.category,'invalid_response');assert.doesNotMatch(JSON.stringify(error.diagnostic),new RegExp(key));return true;
  });
});

test("诊断区分请求超时和主动取消，截断输出保留finishReason", async (t) => {
  const f = await setup(t,{timeoutMs:60}); await f.configure(); await f.enable();
  f.reply((_url,init) => new Promise((_resolve,reject) => init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true})));
  const keepAlive=setInterval(()=>{},100);t.after(()=>clearInterval(keepAlive));
  await assert.rejects(f.connection.runtime.run({prompt:'等超时'}), error => {assert.equal(error.diagnostic?.code,'AI_TIMEOUT');return true;});
  const controller=new AbortController(); const pending=f.connection.runtime.run({prompt:'主动取消',signal:controller.signal});controller.abort();
  await assert.rejects(pending,error=>{assert.equal(error.diagnostic?.code,'AI_CANCELLED');return true;});
  f.reply(() => complete('截断内容','length'));
  await assert.rejects(f.connection.runtime.run({prompt:'截断JSON',schema:{type:'object'}}),error=>{
    assert.equal(error.diagnostic?.code,'AI_INCOMPLETE_OUTPUT');assert.equal(error.diagnostic?.finishReason,'length');return true;
  });
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

test("角色测试仅验证所需能力，文字模型可用于分句和注音；同一密钥支持不同模型且不改全局模型", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  fixture.reply((_url, init) => {
    const body = JSON.parse(init.body);
    if (body.stream) return stream([chunk("OK", "stop"), "[DONE]"]);
    return body.response_format ? complete('{"ok":true}')
      : Response.json({ error: { message: "This is not a multimodal model" } }, { status: 400 });
  });
  assert.equal((await fixture.connection.credentialStatus()).connected, true);
  assert.equal((await fixture.connection.auth.status()).connected, false, "旧业务在首次保存角色配置前仍需原全局启用");
  const textModel = CODIX_MODELS[2].id;
  const segmented = await fixture.connection.testModel(textModel, { role: "segmentation" });
  assert.equal(segmented.passed, true);
  assert.deepEqual(Object.keys(segmented.checks), ["json"]);
  assert.equal(fixture.requests.length, 1);
  const annotated = await fixture.connection.testModel(textModel, { role: "annotation" });
  assert.equal(annotated.passed, true);
  assert.equal(fixture.requests.length, 2);
  const reference = await fixture.connection.testModel(textModel, { role: "annotation", referenceImage: true });
  assert.equal(reference.passed, false);
  assert.equal(reference.checks.image.state, "unsupported");
  assert.equal(fixture.requests.length, 4, "参考原图只测试JSON与图片");
  const { roleReport } = await import("../shared/ai-roles.mjs");
  const reports = await fixture.connection.testReports();
  assert.equal(roleReport(reports, textModel, "segmentation").passed, true);
  assert.equal(roleReport(reports, textModel, "annotation").passed, true);
  assert.equal(roleReport(reports, textModel, "ocr").passed, false);
  fixture.requests.length = 0;
  await fixture.connection.runtime.run({ model: textModel, prompt: "只用文字", schema: { type: "object" } });
  await fixture.connection.runtime.run({ model: "Qwen/Qwen3.6-35B", prompt: "只用文字", schema: { type: "object" } });
  assert.deepEqual(fixture.requests.map((request) => request.body.model), [textModel, "Qwen/Qwen3.6-35B"]);
  assert.equal((await fixture.connection.configuration()).model, "codiX-agent");
  assert.equal((await fixture.connection.auth.status()).connected, false);
  await fixture.configure({ apiKey: "fixture-replacement-key" });
  assert.deepEqual(await fixture.connection.testReports(), []);
});

test("远端模型目录缓存随凭据持久化，重启读取与保存角色无需网络请求", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  fixture.reply(() => Response.json({ data: [{ id: "remote-text-model" }] }));
  await fixture.connection.models();
  const reopened = createProviderConnection({ providerId: "api_base", storageDir: fixture.storageDir,
    apiBaseOptions: { fetchImpl: () => { throw new Error("缓存读取不能发请求"); } } });
  t.after(() => reopened.close());
  assert.deepEqual((await reopened.knownModels()).models.map((model) => model.id), ["remote-text-model"]);
  assert.deepEqual((await reopened.configuration()).models.map((model) => model.id), ["remote-text-model"]);
  await reopened.configure({ apiKey: "fixture-new-key" });
  assert.equal((await reopened.knownModels()).source, "preset");
});

test("角色草稿测试失败只更新能力证据，不改已有全局模型选择或远端目录", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  fixture.reply(() => Response.json({ data: [{ id: "codiX-agent" }, { id: "text-model" }] }));
  await fixture.connection.models();
  await fixture.enable();
  const filename = join(fixture.storageDir, "api_base", "connection.json");
  const selected = await readFile(filename, "utf8");
  assert.equal(JSON.parse(selected).modelSelected, true);
  fixture.reply(() => Response.json({ error: { message: "unsupported JSON" } }, { status: 422 }));
  const failed = await fixture.connection.testModel("codiX-agent", { role: "segmentation" });
  assert.equal(failed.passed, false);
  assert.equal(await readFile(filename, "utf8"), selected);
  assert.deepEqual((await fixture.connection.knownModels()).models.map((item) => item.id), ["codiX-agent", "text-model"]);
});

test("iliad推理强度按模型声明验证、映射reasoning_effort，默认省略，测试按强度独立保留", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  const model = "Deepseek/deepseek-v4-flash-0731";
  const known = await fixture.connection.knownModels();
  assert.deepEqual(known.models.find((entry) => entry.id === model).reasoningOptions, { efforts: ["none", "low", "high", "max"] });
  assert.equal(known.models.find((entry) => entry.id === "codiX-agent").reasoningOptions, undefined);
  assert.deepEqual(await fixture.connection.validateReasoning(model, { effort: "low" }), { effort: "low" });
  for (const reasoning of [{ effort: "medium" }, { enabled: false }, { budgetTokens: 1024 }])
    await assert.rejects(fixture.connection.validateReasoning(model, reasoning), (error) => error.status === 400);
  assert.equal(fixture.requests.length, 0);
  fixture.reply(() => complete('{"ok":true}'));
  await fixture.connection.runtime.run({ model, prompt: "JSON", schema: { type: "object" } });
  assert.equal(Object.hasOwn(fixture.requests.at(-1).body, "reasoning_effort"), false);
  for (const effort of ["none", "low"]) {
    const report = await fixture.connection.testModel(model, { role: "segmentation", reasoning: { effort } });
    assert.equal(report.passed, true);
    assert.deepEqual(report.reasoning, { effort });
    assert.equal(fixture.requests.at(-1).body.reasoning_effort, effort);
    const result = await fixture.connection.runtime.run({ model, prompt: "JSON", schema: { type: "object" }, reasoning: { effort } });
    assert.equal(fixture.requests.at(-1).body.reasoning_effort, effort);
    assert.equal(result.reasoningEffort, effort);
  }
  await fixture.connection.testModel(model, { role: "segmentation" });
  const { roleReport } = await import("../shared/ai-roles.mjs");
  const reports = await fixture.connection.testReports();
  assert.equal(reports.filter((report) => report.model === model).length, 3);
  assert.equal(roleReport(reports, model, "segmentation", false, { effort: "low" }).passed, true);
  assert.equal(roleReport(reports, model, "segmentation", false, { effort: "high" }), null);
  const reopened = createProviderConnection({ providerId: "api_base", storageDir: fixture.storageDir });
  t.after(() => reopened.close());
  assert.equal(roleReport(await reopened.testReports(), model, "segmentation", false, { effort: "none" }).passed, true);
});

test("旧远端目录补充已知强度、未知模型不伪造支持；刷新只保留安全强度声明", async (t) => {
  const fixture = await setup(t);
  await fixture.configure();
  fixture.reply(() => Response.json({ data: [
    { id: "Qwen/Qwen3.6-35B" }, { id: "unknown-model" },
    { id: "declared-model", reasoningOptions: { efforts: ["none", "low", "bad value", "low"], toggle: true, budget: { min: 1, max: 999 } } },
  ] }));
  const catalog = await fixture.connection.models();
  assert.deepEqual(catalog.models.find((entry) => entry.id === "Qwen/Qwen3.6-35B").reasoningOptions, { efforts: ["none", "low", "medium", "high"] });
  assert.equal(catalog.models.find((entry) => entry.id === "unknown-model").reasoningOptions, undefined);
  assert.deepEqual(catalog.models.find((entry) => entry.id === "declared-model").reasoningOptions, { efforts: ["none", "low"] });
});


test('一个HTTP请求取消不会中断另一个并发请求', async t => {
  const f=await setup(t); await f.configure(); await f.enable();
  const waiting=[];
  f.reply((_url,init)=>new Promise((resolve,reject)=> { waiting.push({resolve,signal:init.signal}); init.signal.addEventListener('abort',()=>reject(init.signal.reason),{once:true}); }));
  const controller=new AbortController();
  const first=f.connection.runtime.run({prompt:'第一章',signal:controller.signal});
  const rejected=assert.rejects(first,/取消或超时/);
  const second=f.connection.runtime.run({prompt:'第二章'});
  await new Promise(setImmediate);
  assert.equal(waiting.length,2); controller.abort(); await rejected;
  assert.equal(waiting[1].signal.aborted,false);
  assert.equal(f.connection.runtime.status().activeCount,1);
  waiting[1].resolve(complete('独立完成'));
  assert.equal((await second).text,'独立完成');
});
