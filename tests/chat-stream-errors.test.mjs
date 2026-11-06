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
