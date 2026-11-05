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

test("完成前转发正式回答的增量，忽略推理与中间消息，隐藏跨事件的原生引用标记", async () => {
  let controller, release;
  const waiting = new Promise((resolve) => {release=resolve;});
  const encoder = new TextEncoder(), events = [];
  const body = new ReadableStream({start(value) {controller=value;}});
  const push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
  const f = fixture({response:new Response(body,{headers:{"content-type":"text/event-stream"}})});
  let finished=false;
  const answer = f.runtime.run({prompt:"问题",model:"verified-model",onEvent:(event)=>{events.push(event);if(event.type==="delta") release();}}).then((result)=>{finished=true;return result;});
  push({type:"response.reasoning_text.delta",delta:"不得显示的推理"});
  push({type:"response.output_item.added",item:{id:"comment",type:"message",role:"assistant",phase:"commentary"},output_index:0});
  push({type:"response.output_text.delta",item_id:"comment",delta:"搜索前的中间说明"});
  push({type:"response.output_item.added",item:{id:"answer",type:"message",role:"assistant",phase:"final_answer"},output_index:1});
  push({type:"response.output_text.delta",item_id:"answer",content_index:0,delta:"原文解释"});
  await waiting; assert.equal(finished,false);
  push({type:"response.output_text.delta",item_id:"answer",content_index:0,delta:"cite"});
  push({type:"response.output_text.delta",item_id:"answer",content_index:0,delta:"source与背景。"});
  push({type:"response.completed",response:completed()}); controller.close();
  const result = await answer;
  assert.equal(events.filter((event)=>event.type==="delta").map((event)=>event.delta).join(""),"原文解释与背景。");
  assert.doesNotMatch(JSON.stringify(events),/推理|中间说明|/);
  assert.match(result.text,/\[来源\]\(https:\/\/example.test\/official\)/);
});

test("流式连接中断或调用方取消后仍拒绝部分答案，并释放运行状态", async () => {
  const f = fixture({response:stream([
    {type:"response.output_item.added",item:{id:"answer",type:"message",role:"assistant"}},
    {type:"response.output_text.delta",item_id:"answer",delta:"只收到一部分"},
  ])});
  const chunks=[];
  await assert.rejects(f.runtime.run({prompt:"问题",model:"verified-model",onEvent:(event)=>chunks.push(event)}),/未完整/);
  assert.equal(chunks[0].delta,"只收到一部分"); assert.equal(f.runtime.status().busy,false);
  const controller=new AbortController();controller.abort();
  const g=fixture();
  await assert.rejects(g.runtime.run({prompt:"问题",model:"verified-model",signal:controller.signal}),/停止或超时/);
  assert.equal(g.calls.length,0);
});

test("Responses问答仅在显式配置时发送reasoning.effort，默认不插入参数", async () => {
  const f = fixture();
  await f.runtime.run({ prompt: "问题", model: "verified-model", reasoning: { effort: "low" } });
  assert.deepEqual(JSON.parse(f.calls[0].request.body).reasoning, { effort: "low" });
  await f.runtime.run({ prompt: "默认问题", model: "verified-model" });
  assert.equal(Object.hasOwn(JSON.parse(f.calls[1].request.body), "reasoning"), false);
  for (const reasoning of [{ enabled: true }, { budgetTokens: 1024 }])
    await assert.rejects(f.runtime.run({ prompt: "不支持的控制", model: "verified-model", reasoning }), (error) => error.status === 400);
  assert.equal(f.calls.length, 2);
});

test('联网请求独立取消，一个请求挂起时另一个可完成', async () => {
  const waiting=[];
  const f=fixture({fetchImpl:(_url,{signal})=>new Promise((resolve,reject)=>{
    waiting.push({resolve,signal});signal.addEventListener('abort',()=>reject(signal.reason),{once:true});
  })});
  const controller=new AbortController();
  const first=f.runtime.run({prompt:'第一章',model:'verified-model',signal:controller.signal});
  const failed=assert.rejects(first,/停止或超时/);
  const second=f.runtime.run({prompt:'第二章',model:'verified-model'});
  await new Promise(setImmediate);
  assert.equal(waiting.length,2);assert.equal(f.runtime.status().activeCount,2);
  controller.abort();await failed;
  assert.equal(waiting[1].signal.aborted,false);
  waiting[1].resolve(stream([{type:'response.completed',response:completed()}]));
  assert.equal((await second).completed,true);assert.equal(f.runtime.status().busy,false);
});

test('无视取消的HTTP传输超时后仍释放请求，不接受迟到答案',async()=>{
  let late;
  const f=fixture({turnTimeoutMs:20,fetchImpl:()=>new Promise(resolve=>late=resolve)});
  await assert.rejects(f.runtime.run({prompt:'慢请求',model:'verified-model'}),/停止或超时/);
  assert.equal(f.runtime.status().busy,false);
  late(stream([{type:'response.completed',response:completed()}]));
  await new Promise(setImmediate);
  assert.equal(f.runtime.status().lastSuccessfulAt,null);
});
