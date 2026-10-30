import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { bodyRanges, bodyText } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";

const modelCalls = async () => JSON.parse(await readFile(new URL("../../artifacts/ai-e2e-data/runtime-calls.json", import.meta.url), "utf8")).filter((call) => call.type === "chat");
const markdown = `## 片段说明

这是 **强调** 与 *斜体*，还有 \`inline\`。

- 第一项
- 第二项

> 引用内容

[正常链接](https://www.jpf.go.jp/) [危险链接](javascript:alert%281%29)

\`\`\`js
const longValue = "${"long-code-".repeat(28)}";
\`\`\`

| 语法 | 长例句 |
| --- | --- |
| かけ | ${"long-table-cell-".repeat(20)} |

<script>window.chatMarkdownExecuted = true</script>

<img src="https://example.invalid/tracker" onerror="window.chatMarkdownExecuted=true">`;

test("关联历史保留A/B/A顺序，筛选与追问独立，旧新Markdown安全且只滚动消息区", async ({ page }, info) => {
  await ensureOwnerSession(page.request);
  expect((await page.request.post("/api/ai/login", { data: {} })).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
  const created = await page.request.post("/api/documents", { data: {
    title: `关联历史与Markdown ${info.project.name}`, kind: "article", orientation: "horizontal",
    content: `読みかけの本を閉じて、庭の木々を眺めた。\n${"風が静かに吹いていた。\n".repeat(20)}`,
  } });
  expect(created.status()).toBe(201);
  const initial = await created.json();
  const id = initial.id;
  try {
    expect((await page.request.post(`/api/documents/${id}/sentences`, { data: { revision: initial.revision, bodyHash: initial.bodyHash, force: false } })).ok()).toBe(true);
    const document = await (await page.request.get(`/api/documents/${id}`)).json();
    const text = bodyText(document.bodyHtml);
    const selection = (start, end) => ({ start, end, text: text.slice(start, end), bodyHash: document.bodyHash,
      sentenceIds: bodyRanges(document.bodyHtml).sentences.filter((item) => item.start < end && item.end > start).map((item) => item.id) });
    const first = await page.request.post(`/api/documents/${id}/conversations`, { data: { selection: selection(0, 10), operation: "custom", question: "**A 首问**" } });
    expect(first.ok()).toBe(true);
    const a = await first.json();
    const groupA = a.groups[0].id;
    const second = await page.request.post(`/api/documents/${id}/conversations`, { data: { selection: selection(6, 18), operation: "custom", question: "B 首问" } });
    expect(second.ok()).toBe(true);
    const b = await second.json();
    const groupB = b.groups.find((group) => group.id !== groupA).id;
    const third = await page.request.post(`/api/conversations/${a.id}/messages`, { data: { groupId: groupA, question: "A 追问" } });
    expect(third.ok()).toBe(true);
    let discussion = await third.json();
    const decorate = (item) => ({ ...item, messages: [
      { role: "user", content: "旧的无组记录", createdAt: "2026-10-30T09:00:00Z" },
      ...item.messages.map((message, index) => index === 1 ? { ...message, content: markdown } : message),
    ] });
    await page.route(`**/api/documents/${id}/conversations`, async (route) => {
      if (route.request().method() !== "GET") return route.continue();
      await route.fulfill({ json: { conversations: [decorate(discussion)] } });
    });
    let answerGate = null;
    let answerHeld = null;
    await page.route(`**/api/conversations/${a.id}/messages`, async (route) => {
      const response = await route.fetch();
      discussion = await response.json();
      const gate = answerGate; answerGate = null;
      if (gate) { answerHeld?.(); await gate; }
      await route.fulfill({ response, json: decorate(discussion) });
    });
    const before = (await modelCalls()).length;
    await page.goto(`/#${id}`);
    const article = page.getByRole("article", { name: "日语原文", exact: true });
    await expect(article).toBeVisible();
    await article.locator(`mark[data-qa-group-ids~="${groupA}"][data-qa-group-ids~="${groupB}"]`).first().click();
    const chat = page.getByRole("region", { name: "原文 AI 讨论", exact: true });
    await expect(chat.locator(".chat-message.user .chat-user-text")).toHaveText(["**A 首问**", "B 首问", "A 追问"]);
    await expect(chat.getByRole("button", { name: "翻译此片段", exact: true })).toHaveCount(0);
    await expect(chat.getByRole("button", { name: "解释此片段语法", exact: true })).toHaveCount(0);
    expect((await modelCalls()).length).toBe(before);
    await expect(chat.locator(".chat-markdown h2")).toHaveText("片段说明");
    await expect(chat.locator(".chat-markdown strong")).toHaveText("强调");
    await expect(chat.locator(".chat-markdown table")).toHaveCount(1);
    await expect(chat.locator(".chat-markdown pre code")).toContainText("longValue");
    await expect(chat.locator(".chat-message.user strong")).toHaveCount(0);
    await expect(chat.locator(".chat-markdown script, .chat-markdown img, .chat-markdown a[href^='javascript:']")).toHaveCount(0);
    expect(await page.evaluate(() => window.chatMarkdownExecuted)).toBeUndefined();
    await chat.getByRole("combobox", { name: "追问目标", exact: true }).selectOption(groupB);
    await expect(chat.locator(".chat-message.user .chat-user-text")).toHaveText(["**A 首问**", "B 首问", "A 追问"]);
    await chat.getByRole("textbox", { name: "向 AI 提问", exact: true }).fill("继续追问 B");
    let releaseAnswer;
    answerGate = new Promise((resolve) => { releaseAnswer = resolve; });
    const held = new Promise((resolve) => { answerHeld = resolve; });
    try {
      await chat.getByRole("button", { name: "发送问题", exact: true }).click();
      await held;
      await expect(chat.locator(".chat-messages")).toHaveAttribute("aria-busy", "true");
      // On phones, move the original passage above the covering drawer before
      // tapping it. Keep the same panel mounted while B's response is pending.
      const onlyA = article.locator(`mark[data-qa-group-ids="${groupA}"]`).first();
      await onlyA.evaluate((element) => { element.scrollIntoView({ block: "start" }); window.scrollBy(0, -100); });
      await onlyA.click();
      await expect(chat.locator(".chat-history-scope")).toContainText("此处关联 1 个问答组");
      await expect(chat.getByRole("combobox", { name: "追问目标", exact: true })).toHaveValue(groupA);
    } finally { releaseAnswer(); }
    await expect(chat.getByRole("textbox", { name: "向 AI 提问", exact: true })).toBeEnabled();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    await expect(chat.locator(".chat-message.user .chat-user-text")).toHaveText(["**A 首问**", "A 追问"]);
    await expect(chat.getByRole("combobox", { name: "追问目标", exact: true })).toHaveValue(groupA);
    await expect(chat.locator(".qa-group.active")).toHaveAttribute("data-qa-group-id", groupA);
    expect(discussion.messages.at(-1).groupId).toBe(groupB);
    await expect(chat.locator(".chat-markdown h2")).toHaveText("片段说明");
    await chat.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();
    await article.locator(`mark[data-qa-group-ids="${groupA}"]`).first().click();
    await expect(chat.locator(".chat-message.user .chat-user-text")).toHaveText(["**A 首问**", "A 追问"]);
    await chat.getByRole("button", { name: "查看全部对话", exact: true }).click();
    await expect(chat.locator(".chat-message.user .chat-user-text")).toHaveText(["旧的无组记录", "**A 首问**", "B 首问", "A 追问", "继续追问 B"]);
    const bodyPosition = await page.evaluate(() => ({ page: scrollY, main: document.querySelector(".main-panel")?.scrollTop || 0 }));
    await chat.locator(".chat-messages").evaluate((element) => { element.scrollTop = 0; });
    expect(await page.evaluate(() => ({ page: scrollY, main: document.querySelector(".main-panel")?.scrollTop || 0 }))).toEqual(bodyPosition);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/chat-polish-${info.project.name}.png`, fullPage: true });
  } finally {
    const response = await page.request.get(`/api/documents/${id}`);
    if (response.ok()) expect((await page.request.delete(`/api/documents/${id}`, { data: { revision: (await response.json()).revision } })).status()).toBe(204);
  }
});
