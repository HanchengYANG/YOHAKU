import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorNotice from "../client/components/ErrorNotice.mjs";
import { UserContext } from "../client/user-context.mjs";
import { errorNoticeModel } from "../client/error-presentation.mjs";

const aiError = Object.assign(new Error("AI 暂时不可用 · 错误代码 7K2QD9"), { errorCode: "7K2QD9", action: "ai-settings" });

test("普通错误显示一句话和可复制的代码", () => {
  const html = renderToStaticMarkup(h(ErrorNotice, { error: "出错了，请重试 · 错误代码 7K2QD9" }));
  assert.match(html, /role="alert"/);
  assert.match(html, /出错了，请重试/);
  assert.match(html, /aria-label="复制错误代码 7K2QD9"/);
  assert.doesNotMatch(html, /去 AI 设置/);
});

test("管理员遇到 AI 授权失效时看到去 AI 设置", () => {
  const html = renderToStaticMarkup(h(UserContext.Provider, { value: { isAdmin: true } }, h(ErrorNotice, { error: aiError })));
  assert.match(html, /AI 连接已失效/);
  assert.match(html, /去 AI 设置/);
});

test("朋友只看到 AI 暂时不可用和代码", () => {
  assert.deepEqual(errorNoticeModel(aiError, { isAdmin: false }), { message: "AI 暂时不可用", code: "7K2QD9", action: null, actionLabel: null });
});

test("用户能自己解决的白话原样显示", () => {
  assert.deepEqual(errorNoticeModel(new Error("书名需要填写")), { message: "书名需要填写", code: null, action: null, actionLabel: null });
});

test("管理员看到原文指引和代码", () => {
  const guidance = Object.assign(new Error("所选模型不支持图片输入 · 错误代码 7K2QD9"), { errorCode: "7K2QD9" });
  assert.deepEqual(errorNoticeModel(guidance, { isAdmin: true }), { message: "所选模型不支持图片输入", code: "7K2QD9", action: null, actionLabel: null });
  const html = renderToStaticMarkup(h(UserContext.Provider, { value: { isAdmin: true } }, h(ErrorNotice, { error: "所选模型不支持图片输入 · 错误代码 7K2QD9" })));
  assert.match(html, /所选模型不支持图片输入</);
  assert.match(html, /aria-label="复制错误代码 7K2QD9"/);
});

test("没有错误时不渲染", () => {
  assert.equal(renderToStaticMarkup(h(ErrorNotice, { error: null })), "");
});
