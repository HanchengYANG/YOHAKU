import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import { chatMarkdownOptions, safeMarkdownUrl } from "../client/chat-markdown.mjs";
import { availableChatGroups, visibleChatMessages } from "../client/chat-history.mjs";

test("关联历史保留穿插顺序及相同时间的问答配对，全部视图包含旧记录", () => {
  const pair = (groupId, question) => [
    { groupId, role: "user", content: question, createdAt: "2026-10-30T09:00:00Z" },
    { groupId, role: "assistant", content: `${question} 的回答`, createdAt: "2026-10-30T09:00:00Z" },
  ];
  const messages = [...pair("A", "A 首问"), ...pair("B", "B 首问"), ...pair("A", "A 追问"), { role: "user", content: "旧记录" }, ...pair("orphan", "游离问答")];
  assert.deepEqual(visibleChatMessages(messages, ["A"]).map(({ content }) => content), ["A 首问", "A 首问 的回答", "A 追问", "A 追问 的回答"]);
  assert.deepEqual(visibleChatMessages(messages, ["A", "B"]), messages.slice(0, 6));
  assert.equal(visibleChatMessages(messages), messages);
  const scope = ["A", "B"];
  const groups = [{ id: "A" }, { id: "B" }, { id: "orphan" }];
  assert.deepEqual(availableChatGroups(groups, scope), groups.slice(0, 2));
  assert.deepEqual(visibleChatMessages(messages, scope), messages.slice(0, 6));
});

test("AI Markdown渲染块级结构、表格及代码，同时忽略HTML并阻止危险链接", () => {
  const text = '# 标题\n\n一段 **强调** 与 *斜体*、`inline`。\n\n- 第一项\n- 第二项\n\n> 引用\n\n[安全链接](https://example.com/) [邮件](mailto:reader@example.com) [危险](javascript:alert%281%29)\n\n```js\nconst value = "<script>";\n```\n\n| 列一 | 列二 |\n| --- | --- |\n| A | B |\n\n<script>window.evil = true</script>\n\n<img src="https://example.com/tracker" onerror="evil()">';
  const html = renderToStaticMarkup(createElement(Markdown, chatMarkdownOptions, text));
  assert.match(html, /<h1>标题<\/h1>/);
  for (const tag of ["strong", "em", "ul", "li", "blockquote", "code", "pre", "table", "th", "td"]) assert.match(html, new RegExp(`<${tag}[ >]`));
  assert.match(html, /class="chat-table-scroll"/);
  assert.match(html, /href="https:\/\/example.com\/" target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /href="mailto:reader@example.com"/);
  assert.match(html, /<span>危险<\/span>/);
  assert.doesNotMatch(html, /<script|<img|onerror=|javascript:/);
  assert.match(html, /&lt;script&gt;/);
});

test("Markdown链接只接受http、https、mailto与本页锚点", () => {
  for (const url of ["javascript:alert(1)", "java\nscript:alert(1)", "data:text/html,hi", "vbscript:msgbox(1)", "file:///etc/passwd", "//example.com/", "/api/session/logout"]) assert.equal(safeMarkdownUrl(url), undefined);
  for (const url of ["https://example.com/", "http://example.com/", "mailto:reader@example.com", "#user-content-fn-1"]) assert.equal(safeMarkdownUrl(url), url);
});
