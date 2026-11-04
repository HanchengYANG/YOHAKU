import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ExecutionDetails from "../client/components/ExecutionDetails.mjs";

test("执行来源在独立详情中显示实际角色、提供方、模型，不凭当前配置补全旧记录", () => {
  const render = (props) => renderToStaticMarkup(createElement(ExecutionDetails, props));
  assert.equal(render({}), "");
  assert.equal(render({ execution: { role: "ocr", providerId: "openai" } }), "");
  const html = render({ execution: { role: "segmentation", providerId: "api_base", model: "Deepseek/text-model", configurationVersion: 2, apiKey: "must-not-render" }, detailId: "execution:group:2" });
  assert.match(html, /<summary>执行来源<\/summary>/);
  assert.match(html, /<dd>分句<\/dd>/);
  assert.match(html, /<dd>iliad codix<\/dd>/);
  assert.match(html, /<dd>Deepseek\/text-model<\/dd>/);
  assert.match(html, /data-chat-detail="execution:group:2"/);
  assert.doesNotMatch(html, /must-not-render|configurationVersion/);
  const escaped = render({ execution: { role: "chat", providerId: "openai", model: "<script>" } });
  assert.match(escaped, /OpenAI/);
  assert.match(escaped, /问答/);
  assert.doesNotMatch(escaped, /<script>/);
});
