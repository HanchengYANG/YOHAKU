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
