import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createErrorLog, errorResponder, publicErrorBody } from "../server/errors.mjs";
import { AI_SETTINGS_ACTION, failureText, isErrorCode } from "../shared/error-codes.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

async function serve(t, makeError) {
  const errorLog = createErrorLog(new DatabaseSync(":memory:"));
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "u1" }; next(); });
  app.get("/api/boom", () => { throw makeError(errorLog); });
  app.use(errorResponder({ errorLog, log: () => {} }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/boom?x=1`);
  return { errorLog, status: response.status, body: await response.json() };
}

test("用户能自己解决的错误原样返回白话，不记录", async (t) => {
  const { errorLog, status, body } = await serve(t, () => fail(400, "书名需要填写，最多 160 个字符。"));
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "书名需要填写，最多 160 个字符。" });
  assert.equal(errorLog.list().items.length, 0);
});

test("服务端错误返回代码，详情只在记录里", async (t) => {
  const { errorLog, status, body } = await serve(t, () => new Error("SQLITE_FULL: database or disk is full"));
  assert.equal(status, 500);
  assert.ok(isErrorCode(body.errorCode));
  assert.deepEqual(body, { error: failureText(body.errorCode), errorCode: body.errorCode });
  const entry = errorLog.get(body.errorCode);
  assert.equal(entry.message, "SQLITE_FULL: database or disk is full");
  assert.equal(entry.location, "GET /api/boom");
  assert.equal(entry.userId, "u1");
});

test("AI 授权失效带上操作", async (t) => {
  const { status, body } = await serve(t, () => fail(503, "网站 AI 尚未连接，请联系网站拥有者完成授权。", { code: "AI_AUTH_REQUIRED" }));
  assert.equal(status, 503);
  assert.equal(body.action, AI_SETTINGS_ACTION);
  assert.equal(body.error, failureText(body.errorCode, AI_SETTINGS_ACTION));
});

test("网站登录失效仍下发 code", async (t) => {
  const { body } = await serve(t, () => Object.assign(new Error("请先登录你的网站账户。"), { status: 401, code: "WEBSITE_AUTH_REQUIRED" }));
  assert.deepEqual(body, { code: "WEBSITE_AUTH_REQUIRED", error: "请先登录你的网站账户。" });
});

test("已经记录过的错误沿用原代码", async (t) => {
  const { errorLog, body } = await serve(t, (log) => {
    const error = fail(502, "AI 识别未完成", { diagnostic: { code: "AI_INCOMPLETE_OUTPUT", category: "incomplete_output" } });
    log.capture(error, { scope: "task" });
    return error;
  });
  assert.equal(errorLog.list().items.length, 1);
  assert.equal(errorLog.list().items[0].code, body.errorCode);
});

test("上传与请求体错误保持原有白话", async (t) => {
  const { body } = await serve(t, () => Object.assign(new Error("too large"), { type: "entity.too.large", status: 413 }));
  assert.deepEqual(body, { error: "提交内容过大，请减少正文长度。" });
});

test("记录写入失败时日志带上隐藏后的原始信息", () => {
  const calls = [];
  const errorLog = { record() { throw new Error("database is locked"); } };
  const { status, body } = publicErrorBody(new Error("上游失败 token=abc123"), { errorLog, log: (...args) => calls.push(args.join(" ")) });
  assert.equal(status, 500);
  assert.deepEqual(body, { error: "服务暂时遇到问题，请稍后再试。" });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /上游失败 token=\[已隐藏\]/);
  assert.match(calls[0], /database is locked/);
  assert.doesNotMatch(calls[0], /abc123/);
});
