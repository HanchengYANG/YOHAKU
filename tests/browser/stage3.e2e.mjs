import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import sharp from "sharp";
import { bodyRanges, bodyText, hasCompleteSentenceBoundaries } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";
let cookies = [];
test.beforeEach(async ({ page }) => {
  if (cookies.length) await page.context().addCookies(cookies);
  await ensureOwnerSession(page.request);
  cookies = await page.context().cookies();
  expect((await page.request.post("/api/ai/login", { data: {} })).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
});
const calls = async () => JSON.parse(await readFile(new URL("../../artifacts/ai-e2e-data/runtime-calls.json", import.meta.url), "utf8"));
async function current(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function remove(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  if (response.ok()) expect((await page.request.delete(`/api/documents/${id}`, {data:{revision:(await response.json()).revision}})).status()).toBe(204);
}

async function createUnsegmentedArticle(page, suffix) {
  const response = await page.request.post("/api/documents", { data: {
    title: `旧文章自动分句 ${suffix}`,
    kind: "article", orientation: "horizontal",
    content: `{古い|ふるい}資料を読む。\n\n次の句も読む。${suffix}の記録。`,
  } });
  expect(response.status()).toBe(201);
  const document = await response.json();
  expect(bodyRanges(document.bodyHtml).sentences).toHaveLength(0);
  return document;
}
const sentencePath = (id) => `/api/documents/${id}/sentences`;
const sentenceResponse = (id) => (response) => response.request().method() === "POST" && new URL(response.url()).pathname === sentencePath(id);

// These records intentionally bypass the import UI, as old saved articles do.
test("阅读旧文章立即初始化并保存分句，保留原文和注音，刷新不重复请求", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `首次 ${info.project.name}`);
  const requests = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === sentencePath(document.id)) requests.push(request.postDataJSON());
  });
  try {
    const response = page.waitForResponse(sentenceResponse(document.id));
    await page.goto(`/#${document.id}`);
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    const saved = await current(page, document.id);
    expect(saved.revision).toBeGreaterThan(document.revision);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(document.bodyHtml));
    expect(saved.content).toBe(document.content);
    expect(saved.blocks).toEqual(document.blocks);
    expect(bodyRanges(saved.bodyHtml).sentences.length).toBeGreaterThan(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({force:false,revision:document.revision,bodyHash:document.bodyHash});
    const modelCalls = (await calls()).filter(call => call.type === "sentences").length;
    await page.reload();
    await expect(page.getByRole("heading", {name:document.title,exact:true})).toBeVisible();
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    await page.waitForLoadState("networkidle");
    expect(requests).toHaveLength(1);
    expect((await calls()).filter(call => call.type === "sentences")).toHaveLength(modelCalls);
    const reopened = await current(page, document.id);
    expect(reopened.bodyHtml).toBe(saved.bodyHtml);
    expect(reopened.revision).toBe(saved.revision);
  } finally { await remove(page, document.id); }
});

test("旧文章自动分句失败隐藏正文，保留编辑和返回入口且能手动重试", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `失败 ${info.project.name}`);
  const routePattern = `**${sentencePath(document.id)}`;
  let attempts = 0;
  await page.route(routePattern, route => {
    attempts++;
    return route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"测试：旧文章分句暂不可用。"})});
  });
  try {
    await page.goto(`/#${document.id}`);
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toHaveCount(0);
    await expect(page.getByRole("region", {name:"准备阅读",exact:true})).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("旧文章分句暂不可用");
    await expect(page.getByRole("button", {name:"重试分句",exact:true})).toBeEnabled();
    await expect(page.getByRole("button", {name:"校对文字与注音",exact:true})).toBeEnabled();
    await expect(page.getByRole("button", {name:"返回书架",exact:true})).toBeEnabled();
    await expect(page.getByRole("button", {name:"对话记录",exact:true})).toHaveCount(0);
    await page.waitForLoadState("networkidle");
    expect(attempts).toBe(1);
    const unchanged = await current(page, document.id);
    expect(unchanged.bodyHtml).toBe(document.bodyHtml);
    expect(unchanged.revision).toBe(document.revision);
    await page.unroute(routePattern);
    const retry = page.waitForResponse(sentenceResponse(document.id));
    await page.getByRole("button", {name:"重试分句",exact:true}).click();
    expect((await retry).ok()).toBe(true);
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    const saved = await current(page, document.id);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(document.bodyHtml));
    expect(saved.content).toBe(document.content);
    expect(bodyRanges(saved.bodyHtml).sentences.length).toBeGreaterThan(1);
  } finally { await page.unroute(routePattern); await remove(page, document.id); }
});

for (const partial of [false, true]) test(`${partial ? "部分分句" : "未分句"}文章等待全文处理时不挂载正文，完成后才允许阅读`, async ({page}, info) => {
  let document = await createUnsegmentedArticle(page, `等待 ${partial} ${info.project.name}`);
  if (partial) {
    const response = await page.request.put(`/api/documents/${document.id}`, {data:{...document,
      bodyHtml:document.bodyHtml.replace("資料",'<span data-sentence-id="partial-sentence">資料</span>')}});
    expect(response.ok()).toBe(true);
    document = await response.json();
    expect(bodyRanges(document.bodyHtml).sentences).toHaveLength(1);
    expect(hasCompleteSentenceBoundaries(document.bodyHtml)).toBe(false);
  }
  let release, signalStarted;
  const held = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { signalStarted = resolve; });
  const pattern = `**${sentencePath(document.id)}`;
  await page.addInitScript(() => {
    window.__readingGateAllowed = false;
    window.__readingGateFlashed = false;
    new MutationObserver(() => {
      if (!window.__readingGateAllowed && document.querySelector('article[aria-label="日语原文"]')) window.__readingGateFlashed = true;
    }).observe(document, {childList:true,subtree:true});
  });
  await page.route(pattern, async route => {
    const response = await route.fetch();
    signalStarted();
    await held;
    await route.fulfill({response});
  });
  try {
    await page.goto(`/#${document.id}`);
    await started;
    const waiting = page.getByRole("region", {name:"准备阅读",exact:true});
    await expect(waiting).toBeVisible();
    await expect(waiting.getByRole("progressbar", {name:"正在分句",exact:true})).toBeVisible();
    await expect(waiting.getByRole("progressbar")).not.toHaveAttribute("aria-valuenow");
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toHaveCount(0);
    await expect(page.locator(".article-body,.selection-questions,.document-chat")).toHaveCount(0);
    await expect(page.getByRole("button", {name:"对话记录",exact:true})).toHaveCount(0);
    expect(await page.evaluate(() => window.__readingGateFlashed)).toBe(false);
    await page.evaluate(() => { window.__readingGateAllowed = true; });
    release();
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    await expect(waiting).toHaveCount(0);
    const saved = await current(page, document.id);
    expect(hasCompleteSentenceBoundaries(saved.bodyHtml)).toBe(true);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(document.bodyHtml));
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { release(); await page.unroute(pattern); await remove(page, document.id); }
});

test("阅读分句遇到旧版本时读取最新正文，只重试一次且不展示旧正文", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `版本变化 ${info.project.name}`);
  const pattern = `**${sentencePath(document.id)}`;
  const requests = [];
  let updated;
  await page.route(pattern, async route => {
    requests.push(route.request().postDataJSON());
    if (requests.length > 1) return route.continue();
    const response = await page.request.put(`/api/documents/${document.id}`, {data:{...document,
      bodyHtml:document.bodyHtml.replace("資料", "最新文章")}});
    expect(response.ok()).toBe(true);
    updated = await response.json();
    await route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"测试：文章已在其他页面更新。"})});
  });
  try {
    await page.goto(`/#${document.id}`);
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    await page.waitForLoadState("networkidle");
    expect(requests).toHaveLength(2);
    expect(requests[0].revision).toBe(document.revision);
    expect(requests[1].revision).toBe(updated.revision);
    const saved = await current(page, document.id);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(updated.bodyHtml));
    expect(hasCompleteSentenceBoundaries(saved.bodyHtml)).toBe(true);
    expect(await page.getByRole("article", {name:"日语原文",exact:true}).textContent()).toContain("最新文章");
  } finally { await page.unroute(pattern); await remove(page, document.id); }
});

test("阅读分句持续版本冲突只尝试两次，停止等待并保留明确重试入口", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `持续冲突 ${info.project.name}`);
  const pattern = `**${sentencePath(document.id)}`;
  let attempts = 0;
  await page.route(pattern, route => {
    attempts++;
    return route.fulfill({status:409,contentType:"application/json",body:JSON.stringify({error:"测试：分句版本持续冲突。"})});
  });
  try {
    await page.goto(`/#${document.id}`);
    await expect(page.getByRole("alert")).toContainText("分句版本持续冲突");
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toHaveCount(0);
    await expect(page.getByRole("button", {name:"重试分句",exact:true})).toBeEnabled();
    await page.waitForLoadState("networkidle");
    expect(attempts).toBe(2);
    await page.unroute(pattern);
    await page.getByRole("button", {name:"重试分句",exact:true}).click();
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    expect(hasCompleteSentenceBoundaries((await current(page, document.id)).bodyHtml)).toBe(true);
  } finally { await page.unroute(pattern); await remove(page, document.id); }
});
