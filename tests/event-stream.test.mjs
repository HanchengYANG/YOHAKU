import test from "node:test";
import assert from "node:assert/strict";
import { readEventStream } from "../shared/event-stream.mjs";
import { sendChat } from "../client/chat-stream.mjs";

test("SSE 按单字节接收 UTF-8、CRLF、多行数据及没有末尾换行的事件", async () => {
  const bytes = new TextEncoder().encode(': 心跳\r\nevent: answer\r\ndata:第一行🙂\r\ndata: 第二行\r\n\r\ndata: 尾部');
  const body = new ReadableStream({start(controller) {
    for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
    controller.close();
  }});
  assert.deepEqual(await Array.fromAsync(readEventStream(body)),[
    {event:"answer",data:"第一行🙂\n第二行"},{event:"message",data:"尾部"},
  ]);
});

test("事件体大小有上限，提前退出会取消读取", async () => {
  let cancelled = false;
  const body = new ReadableStream({start(controller) {controller.enqueue(new TextEncoder().encode("data: too long\n\n"));},cancel() {cancelled=true;}});
  await assert.rejects(Array.fromAsync(readEventStream(body,{maxBytes:5})),/过长/);
  assert.equal(cancelled,true);
});

test("聊天客户端在终态前回调增量，只接受明确完成；兼容 JSON 与 HTTP 错误", async (t) => {
  let controller;
  const body = new ReadableStream({start(value) {controller=value;}}), encoder = new TextEncoder();
  const push = (event) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
  let received, arrived;
  const first = new Promise((resolve) => {arrived=resolve;});
  t.mock.method(globalThis,"fetch",async (_url,options) => {
    assert.equal(options.headers.Accept,"text/event-stream");
    return new Response(body,{headers:{"content-type":"text/event-stream"}});
  });
  let finished=false;
  const answer=sendChat("/test",{body:"{}",onEvent:(event) => {received=event;arrived();}}).then((value)=>{finished=true;return value;});
  push({type:"delta",delta:"逐字🙂"}); await first;
  assert.equal(finished,false); assert.equal(received.delta,"逐字🙂");
  push({type:"done",conversation:{id:"completed"}}); controller.close();
  assert.deepEqual(await answer,{id:"completed"});
  globalThis.fetch.mock.mockImplementation(async () => new Response('data: {"type":"delta","delta":"不完整"}\n\n',{headers:{"content-type":"text/event-stream"}}));
  await assert.rejects(sendChat("/test"),/中断/);
  globalThis.fetch.mock.mockImplementation(async () => new Response('data: {"type":"error","status":409,"error":"引用已变化"}\n\n',{headers:{"content-type":"text/event-stream"}}));
  await assert.rejects(sendChat("/test"),(error)=>error.status===409 && error.message==="引用已变化");
  globalThis.fetch.mock.mockImplementation(async () => Response.json({id:"json"}));
  assert.deepEqual(await sendChat("/test"),{id:"json"});
  globalThis.fetch.mock.mockImplementation(async () => Response.json({error:"无权访问"},{status:403}));
  await assert.rejects(sendChat("/test"),(error)=>error.status===403);
});

test("回答读到一半断网时给出白话提示并标记 network，不出现浏览器原文", async (t) => {
  const encoder = new TextEncoder();
  let delivered = 0;
  const body = new ReadableStream({pull(controller) {
    if (delivered++ === 0) controller.enqueue(encoder.encode('data: {"type":"delta","delta":"一半"}\n\n'));
    else controller.error(new TypeError("network error"));
  }});
  t.mock.method(globalThis,"fetch",async () => new Response(body,{headers:{"content-type":"text/event-stream"}}));
  const events = [];
  await assert.rejects(sendChat("/test",{onEvent:(event)=>events.push(event)}),
    (error)=>error.message==="回答传输中断，未完成的内容没有保存。请重试。" && error.network===true);
  assert.equal(events.length,1);
});

test("回调自身抛出的 TypeError 不被当成断网", async (t) => {
  t.mock.method(globalThis,"fetch",async () => new Response('data: {"type":"delta","delta":"字"}\n\n',{headers:{"content-type":"text/event-stream"}}));
  await assert.rejects(sendChat("/test",{onEvent:()=>{throw new TypeError("bug in caller");}}),
    (error)=>error instanceof TypeError && error.message==="bug in caller" && error.network===undefined);
});
