import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, newErrorCode, redact } from "../server/errors.mjs";
import { AI_SETTINGS_ACTION, isErrorCode } from "../shared/error-codes.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

test("错误代码由随机字节均匀映射到 32 个字符", () => {
  assert.equal(newErrorCode(Buffer.from([0, 1, 31, 32, 255, 100])), "01Z0Z4");
  assert.equal(isErrorCode(newErrorCode()), true);
});

test("隐藏密钥、令牌与授权头", () => {
  assert.equal(redact("Authorization: Bearer abc.def.ghi1234 failed"), "Authorization: [已隐藏] failed");
  assert.equal(redact("key sk-abcdefgh12345 rejected"), "key [已隐藏] rejected");
  assert.equal(redact('{"apiKey":"xyz123"}'), '{"apiKey":"[已隐藏]"}');
  assert.equal(redact("普通错误"), "普通错误");
});

test("隐藏 Basic 授权、JWT 与 Cookie", () => {
  assert.equal(redact("Authorization: Basic dXNlcjpwYXNz rejected"), "Authorization: [已隐藏] rejected");
  assert.equal(redact("got eyJhbGciOi.eyJzdWIiOiIx.c2lnbmF0dXJl back"), "got [已隐藏] back");
  assert.equal(redact("Cookie: sid=abc; theme=dark\nnext line"), "Cookie: [已隐藏]\nnext line");
  assert.equal(redact("set-cookie: sid=abc; Path=/"), "set-cookie: [已隐藏]");
});

test("用户能自己解决的错误不记录", () => {
  assert.deepEqual(classifyError(fail(400, "书名需要填写")), { record: false, kind: null, action: null });
  assert.equal(classifyError(Object.assign(new Error("找不到这篇材料"), { status: 404 })).record, false);
  assert.deepEqual(classifyError(fail(409, "AI 正在处理请求", { code: "AI_BUSY" })), { record: false, kind: "AI_BUSY", action: null });
  assert.deepEqual(classifyError(fail(409, "API 请求已取消或超时，请重试。", {
    diagnostic: { code: "AI_CANCELLED", category: "cancelled" }, execution: { providerId: "api_base" },
  })), { record: false, kind: "AI_CANCELLED", action: null });
});

test("角色内的用户错误只带执行信息时不记录", () => {
  assert.deepEqual(classifyError(fail(409, "正文草稿已变化，请重新提交。", { execution: { providerId: "openai", role: "annotation" } })),
    { record: false, kind: null, action: null });
});

test("角色外层补上的兜底诊断不把用户错误当作 AI 错误", () => {
  const fallback = { diagnostic: { code: "AI_UNKNOWN_ERROR", category: "unknown" } };
  assert.equal(classifyError(fail(409, "方向已变化", fallback)).record, false);
  assert.equal(classifyError(fail(502, "方向已变化", fallback)).record, true);
});

test("提供方自己抛出的 4xx 视为 AI 错误并记录", () => {
  assert.deepEqual(classifyError(fail(400, "所选模型不支持图片输入，尚未发起推理。", { aiProvider: true })),
    { record: true, kind: null, action: null });
});

test("服务端、AI 与上游错误都记录", () => {
  assert.deepEqual(classifyError(new Error("SQLITE_FULL")), { record: true, kind: null, action: null });
  assert.deepEqual(classifyError(fail(502, "AI 调用失败", { diagnostic: { code: "AI_INVALID_RESPONSE" } })),
    { record: true, kind: "AI_INVALID_RESPONSE", action: null });
  assert.equal(classifyError(fail(429, "达到频率限制", { diagnostic: { code: "AI_RATE_LIMIT" } })).record, true);
});

test("AI 授权失效带上去 AI 设置的操作", () => {
  for (const error of [
    fail(503, "网站 AI 尚未连接", { code: "AI_AUTH_REQUIRED" }),
    fail(401, "API key 无效", { diagnostic: { code: "AI_AUTH_ERROR" } }),
  ]) assert.deepEqual(classifyError(error), { record: true, kind: "AI_AUTH_REQUIRED", action: AI_SETTINGS_ACTION });
});
