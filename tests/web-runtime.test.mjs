import test from "node:test";
import assert from "node:assert/strict";
import { createWebRuntime, presentWebResponse } from "../server/providers/openai/web-runtime.mjs";
const completed = () => ({ id: "resp-test", status: "completed", model: "verified-model", output: [
  { type: "web_search_call", status: "completed", action: { query: "官方来源", sources: [{ title: "来源", url: "https://example.test/official" }, { title: "非法协议", url: "javascript:alert(1)" }] } },
  { type: "message", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "原文解释与背景。citesource", annotations: [{ type: "url_citation", start_index: 8, end_index: 21, title: "来源", url: "https://example.test/official" }] }] },
] });
const stream = (events) => new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), { status: 200 });
function fixture(options = {}) {
  const calls = [], state = { account: { connected: true, id: "account", subject: "subject" }, token: "test-private-token" };
  const auth = { status: async () => ({ ...state.account }), accessToken: async () => state.token, ...options.auth };
  const { auth: _authOptions, ...runtimeOptions } = options;
  const runtime = createWebRuntime({ auth, fetchImpl: async (url, request) => { calls.push({ url, request }); return options.response || stream([{ type: "response.completed", response: completed() }]); }, ...runtimeOptions });
  return { calls, state, runtime };
}
test("订阅联网只提供原生搜索工具，完成事件提取安全来源，不发送本机或收费API凭据", async () => {
  const f = fixture();
  const result = await f.runtime.run({ prompt: "已保存问题与引用快照", model: "verified-model", expectedAccountId: "account", expectedSubject: "subject" });
  assert.equal(result.completed, true);
  assert.match(result.text, /\[来源\]\(https:\/\/example.test\/official\)/);
  assert.equal(result.webSearch.performed, true);
  assert.deepEqual(result.sources, [{ title: "来源", url: "https://example.test/official" }]);
  assert.match(result.threadId, /^responses:/);
  const request = JSON.parse(f.calls[0].request.body);
  assert.deepEqual(request.tools, [{ type: "web_search", external_web_access: true }]);
  assert.equal(request.store, false);
  assert.equal(request.stream, true);
  assert.deepEqual(request.include, ["web_search_call.action.sources"]);
  assert.equal(f.calls[0].request.headers.Authorization, `Bearer ${f.state.token}`);
  assert.doesNotMatch(JSON.stringify(result), /test-private-token/);
  const again = await f.runtime.run({ prompt: "历史快照与当前追问", model: "verified-model", threadId: result.threadId });
  assert.equal(again.threadId, result.threadId);
  assert.equal(JSON.parse(f.calls[1].request.body).previous_response_id, undefined, "不依赖store:false无法恢复的远程响应句柄");
});
test("没有完成事件、失败和部分回答均拒绝，不伪造联网来源", async () => {
  for (const events of [[{ type: "response.output_text.delta", delta: "部分文字" }], [{ type: "response.incomplete", response: completed() }], [{ type: "response.completed", response: { ...completed(), status: "in_progress" } }]]) {
    const f = fixture({ response: stream(events) });
    await assert.rejects(f.runtime.run({ prompt: "问题", model: "verified-model" }), /未完整|失败|未保存|未完成/);
  }
  const response = completed(); response.output = response.output.filter((item) => item.type !== "web_search_call");
  const parsed = presentWebResponse(response);
  assert.equal(parsed.webSearch.performed, false);
  assert.deepEqual(parsed.sources, []);
});
test("联网请求身份变化在请求前及完成后均拒绝，错误隐藏凭据", async () => {
  const f = fixture();
  await assert.rejects(f.runtime.run({ prompt: "问题", model: "verified-model", expectedAccountId: "other" }), (error) => error.status === 409);
  assert.equal(f.calls.length, 0);
  let reads = 0;
  const g = fixture({ auth: { status: async () => ({ connected: true, id: ++reads > 2 ? "switched" : "account" }) } });
  await assert.rejects(g.runtime.run({ prompt: "问题", model: "verified-model", expectedAccountId: "account" }), (error) => error.status === 409);
  const h = fixture({ fetchImpl: async () => { throw new Error("network Bearer test-private-token"); } });
  await assert.rejects(h.runtime.run({ prompt: "问题", model: "verified-model" }), (error) => !error.message.includes("test-private-token"));
});
test("HTTP联网失败及取消不写入成功答案", async () => {
  const f = fixture({ response: new Response("private upstream body", { status: 401 }) });
  await assert.rejects(f.runtime.run({ prompt: "问题", model: "verified-model" }), /授权失败/);
  assert.doesNotMatch(f.runtime.status().lastError, /private upstream/);
  let started;
  const waiting = new Promise((resolve) => { started = resolve; });
  const g = fixture({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => { started(); signal.addEventListener("abort", () => reject(new Error("aborted"))); }) });
  const pending = g.runtime.run({ prompt: "问题", model: "verified-model" }); await waiting; g.runtime.stop();
  await assert.rejects(pending, /停止或超时/);
  assert.equal(g.runtime.status().busy, false);
});


test("SIWC终结事件省略output时，仅在完成后采纳完成item；搜索失败显式拒绝", async () => {
  const result = completed();
  const events = [...result.output.map((item, index) => ({ type: "response.output_item.done", item: { ...item, id: `item-${index}` } })), { type: "response.completed", response: { ...result, output: [] } }];
  const f = fixture({ response: stream(events) });
  assert.equal((await f.runtime.run({ prompt: "查证", model: "verified-model" })).webSearch.performed, true);
  const failed = completed(); failed.output[0].status = "failed";
  assert.throws(() => presentWebResponse(failed), /网页搜索失败/);
});


test("顶层完成但搜索或助手消息明确未完成时不接受部分输出", () => {
  for (const type of ["web_search_call", "message"]) {
    const response = completed(); response.output.find((item) => item.type === type).status = "in_progress";
    assert.throws(() => presentWebResponse(response), /未完成|未完整完成/);
  }
  const response = completed(); response.output.find((item) => item.type === "message").status = "incomplete";
  assert.throws(() => presentWebResponse(response), /未完整完成/);
});
