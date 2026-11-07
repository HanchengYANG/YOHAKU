// tests/client-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import api, { NETWORK_FAILURE, apiFetch } from "../client/api.mjs";

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test("断网时给出白话提示，不出现 Failed to fetch", async (t) => {
  stubFetch(t, async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(api("/books"), (error) => error.message === NETWORK_FAILURE && error.network === true && error.status === 0);
  await assert.rejects(apiFetch("/api/imports"), (error) => error.message === NETWORK_FAILURE);
});

test("取消请求仍是 AbortError", async (t) => {
  stubFetch(t, async () => { throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(api("/books"), (error) => error.name === "AbortError");
});

test("错误响应带上错误代码和操作", async (t) => {
  stubFetch(t, async () => new Response(JSON.stringify({ error: "AI 暂时不可用 · 错误代码 7K2QD9", errorCode: "7K2QD9", action: "ai-settings" }),
    { status: 503, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(api("/x"), (error) =>
    error.message === "AI 暂时不可用 · 错误代码 7K2QD9" && error.errorCode === "7K2QD9" && error.action === "ai-settings" && error.status === 503);
});

test("代理拒绝过大的上传时说文件太大，而不是服务没有返回有效结果", async (t) => {
  stubFetch(t, async () => new Response("<html><body>413 Request Entity Too Large</body></html>",
    { status: 413, headers: { "Content-Type": "text/html" } }));
  await assert.rejects(api("/imports", { method: "POST" }), (error) => error.status === 413 && /太大/.test(error.message));
});

test("看不懂的错误页说清原因并带上 HTTP 状态码", async (t) => {
  for (const [status, pattern] of [[502, /重启/], [504, /超时/], [500, /HTTP 500/]]) {
    stubFetch(t, async () => new Response("<html>error</html>", { status, headers: { "Content-Type": "text/html" } }));
    await assert.rejects(api("/books"), (error) => error.status === status && pattern.test(error.message)
      && error.message.includes(`HTTP ${status}`) && !error.message.includes("没有返回有效结果"));
  }
});
