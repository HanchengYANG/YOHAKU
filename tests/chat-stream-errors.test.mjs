// tests/chat-stream-errors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { respondToChat } from "../server/ai/chat-stream.mjs";
import { createErrorLog } from "../server/errors.mjs";
import { readEventStream } from "../shared/event-stream.mjs";
import { failureText, isErrorCode } from "../shared/error-codes.mjs";

test("流式对话失败只下发带代码的文案", async (t) => {
  const errorLog = createErrorLog(new DatabaseSync(":memory:"));
  const app = express();
  app.locals.errorLog = errorLog;
  app.post("/chat", (req, res) => respondToChat(req, res, async () => {
    throw Object.assign(new Error("upstream said: model overloaded"), {
      status: 502, expose: true, diagnostic: { code: "AI_INVALID_RESPONSE", category: "invalid_response" },
    });
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: "POST", headers: { Accept: "text/event-stream" } });
  const events = [];
  for await (const frame of readEventStream(response.body)) events.push(JSON.parse(frame.data));
  const error = events.find((event) => event.type === "error");
  assert.ok(isErrorCode(error.errorCode));
  assert.equal(error.error, failureText(error.errorCode));
  assert.equal(error.status, 502);
  assert.equal(errorLog.get(error.errorCode).message, "upstream said: model overloaded");
  assert.equal(errorLog.get(error.errorCode).scope, "chat");
});

test("对话中用户可处理的失败经 capture 后仍以原文下发，不记录", async (t) => {
  const errorLog = createErrorLog(new DatabaseSync(":memory:"));
  const app = express();
  app.locals.errorLog = errorLog;
  let stored;
  app.post("/chat", (req, res) => respondToChat(req, res, async () => {
    const cause = Object.assign(new Error("对话已删除，本次迟到结果未恢复对话。"), { status: 409, expose: true });
    // Mirrors the answer() catch in server/ai/routes.mjs.
    stored = errorLog.capture(cause, { scope: "chat", location: "chat:answer" });
    throw cause;
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: "POST", headers: { Accept: "text/event-stream" } });
  const events = [];
  for await (const frame of readEventStream(response.body)) events.push(JSON.parse(frame.data));
  const error = events.find((event) => event.type === "error");
  assert.equal(stored, "对话已删除，本次迟到结果未恢复对话。");
  assert.equal(error.error, "对话已删除，本次迟到结果未恢复对话。");
  assert.equal(error.status, 409);
  assert.equal(error.errorCode, undefined);
  assert.equal(errorLog.list().items.length, 0);
});
