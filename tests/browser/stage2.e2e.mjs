// UI integration only: actual uploads/Sharp/SQLite, explicit OAuth/model doubles.
// These checks are not evidence of real subscription authorization or OCR quality.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ensureOwnerSession, testOwner } from "./session.mjs";

const accountFlowTitle = "网站账号登录、退出与邀请码注册使用真实会话和资料隔离";
test.beforeEach(async ({ page }, info) => {
  if (info.title !== accountFlowTitle) await ensureOwnerSession(page.request);
});

const imagePath = fileURLToPath(
  new URL("../../fixtures/images/01-lyrics-ruby.png", import.meta.url),
);
const callback =
  "/auth/callback?state=ui-test-state&code=ui-test-code&client_id=ui-test-client";

async function openSettings(page) {
  if (
    await page
      .getByRole("button", { name: "打开书架", exact: true })
      .isVisible()
  ) {
    await page.getByRole("button", { name: "打开书架", exact: true }).click();
  }
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "连接你的 ChatGPT", exact: true }),
  ).toBeVisible();
}

async function enableTestAccount(page) {
  // Per-user provider callbacks must originate from a real website session and
  // a recorded login attempt; the test double only replaces upstream OAuth.
  const started = await page.request.post("/api/ai/login", { data: {} });
  expect(started.ok()).toBe(true);
  const response = await page.request.get(callback);
  expect(response.ok()).toBe(true);
}

test("授权设置主流程（OAuth 为明确测试替身，不向官方发送授权请求）", async ({
  page,
}, info) => {
  await page.request.post("/api/ai/logout");
  await page.goto("/");
  await openSettings(page);
  await expect(page.getByText("尚未授权", { exact: true })).toBeVisible();
  const providers = page.getByRole("combobox", {
    name: "AI 提供方",
    exact: true,
  });
  await expect(providers).toHaveValue("openai");
  await expect(providers.locator('option[value="claude"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  await expect(providers.locator('option[value="api_base"]')).toHaveJSProperty(
    "disabled",
    true,
  );
  expect(
    await providers
      .locator("option")
      .evaluateAll((options) =>
        options
          .filter((option) => !option.disabled)
          .map((option) => option.value),
      ),
  ).toEqual(["openai"]);
  await page.screenshot({
    path: `artifacts/stage2-auth-disconnected-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  let intercepted = false;
  await page.route("https://auth.openai.com/**", async (route) => {
    const target = new URL(route.request().url());
    expect(target.pathname).toBe("/api/accounts/authorize");
    expect(target.searchParams.get("client_id")).toBe("dynamic_agent_client");
    intercepted = true;
    await route.fulfill({
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>仅供测试的授权替身</title><h1>这里是浏览器测试替身，不是真实 OpenAI 授权页</h1><a href="http://127.0.0.1:4319${callback}">仅用于浏览器测试：完成授权</a></html>`,
    });
  });
  await page
    .getByRole("button", { name: "Continue with ChatGPT", exact: true })
    .click();
  await page
    .getByRole("link", { name: "仅用于浏览器测试：完成授权", exact: true })
    .click();
  await expect(page).toHaveURL(/127\.0\.0\.1:4319\/\?chatgpt=connected/);
  expect(intercepted).toBe(true);
  await openSettings(page);
  await expect(page.getByText("已授权", { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole("paragraph")
      .filter({ hasText: /^ui-test-only@example\.invalid$/ }),
  ).toBeVisible();
  await expect(
    page.getByText("当前模型：UI-TEST-DOUBLE", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/stage2-auth-connected-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "断开授权", exact: true }).click();
  await expect(page.getByText("尚未授权", { exact: true })).toBeVisible();
});

test("真实图片上传、校对保存与对话重开（OCR 和回答为测试替身）", async ({
  page,
}, info) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await enableTestAccount(page);
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: "导入图片", exact: true })
    .click();
  await page
    .getByLabel("选择日语图片", { exact: true })
    .setInputFiles(imagePath);
  await expect(
    page.getByAltText("待识别的日语原图", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "识别图片", exact: true }).click();
  const original = page.getByRole("region", { name: "原图对照", exact: true });
  await expect(original).toBeVisible();
  const originalImage = original.getByAltText("用于校对正文和注音的日语原图", {
    exact: true,
  });
  await expect
    .poll(() =>
      originalImage.evaluate((el) => el.complete && el.naturalWidth > 0),
    )
    .toBe(true);
  const imageUrl = await originalImage.getAttribute("src");
  expect(imageUrl).toMatch(/^\/api\/images\/[a-f0-9-]+\/raw$/);
  const raw = await page.request.get(imageUrl);
  expect(raw.ok()).toBe(true);
  expect(await raw.body()).toEqual(await readFile(imagePath));
  await expect(
    page
      .getByRole("listitem")
      .filter({ hasText: "此识别结果来自浏览器测试替身，不是真实 OCR。" }),
  ).toBeVisible();
  await expect(
    page.getByText("测试替身：绿色手写批注", { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/stage2-original-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator("rt")).toContainText([
    "ぼく",
    "う",
    "ひ",
    "そら",
    "せなか",
    "な",
  ]);
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const reading = page.getByRole("textbox", {
    name: "空的读音（第1行）",
    exact: true,
  });
  const row = page.locator(".ruby-edit-row").filter({ has: reading });
  await expect(row.getByText("补充", { exact: true })).toBeVisible();
  await reading.fill("くう");
  await expect(row.getByText("手动", { exact: true })).toBeVisible();
  const sourceRow = page.locator(".ruby-edit-row").filter({
    has: page.getByRole("textbox", {
      name: "僕的读音（第1行）",
      exact: true,
    }),
  });
  await expect(sourceRow.getByText("原有", { exact: true })).toBeVisible();
  await expect(
    preview.locator("rt").filter({ hasText: /^くう$/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/stage2-correction-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await expect(
    page.getByRole("heading", {
      name: "界面测试草稿（OCR 为测试替身）",
      exact: true,
    }),
  ).toBeVisible();
  const documentId = await page.evaluate(() => location.hash.slice(1));
  const saved = await (
    await page.request.get(`/api/documents/${documentId}`)
  ).json();
  expect(saved.sourceImageId).toBeTruthy();
  expect(saved.content).toContain("{空|くう}");
  expect(saved.blocks[0].segments.find((s) => s.text === "空").origin).toBe(
    "manual",
  );
  expect(saved.blocks[0].segments.find((s) => s.text === "僕").origin).toBe(
    "source",
  );
  expect(saved.recognition.nonBody.some((n) => n.type === "handwriting")).toBe(
    true,
  );
  await page.reload();
  await page.locator(".reader-recognition-details > summary").click();
  await expect(
    page.getByRole("link", { name: "查看完整原图", exact: true }),
  ).toHaveAttribute("href", imageUrl);
  await page
    .getByRole("button", { name: "校对文字与注音", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "原图对照", exact: true }),
  ).toBeVisible();
  await page.getByRole("tab", { name: /注音校正/ }).click();
  await expect(
    page.getByRole("textbox", { name: "空的读音（第1行）", exact: true }),
  ).toHaveValue("くう");
  await expect(
    page
      .locator(".ruby-edit-row")
      .filter({
        has: page.getByRole("textbox", {
          name: "空的读音（第1行）",
          exact: true,
        }),
      })
      .getByText("手动", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "问 AI", exact: true }).click();
  const chat = page.getByRole("region", { name: "原文 AI 讨论", exact: true });
  await chat
    .getByRole("textbox", { name: "向 AI 提问", exact: true })
    .fill("背中在这里是什么意思？");
  await chat.getByRole("button", { name: "发送问题", exact: true }).click();
  await expect(chat.locator(".chat-message.assistant")).toHaveCount(1);
  await expect(chat.locator(".chat-message.assistant")).toContainText(
    "【浏览器测试替身，不是真实 AI 回答】",
  );
  await chat
    .getByRole("textbox", { name: "向 AI 提问", exact: true })
    .fill("再给一个相关例句。");
  await chat.getByRole("button", { name: "继续提问", exact: true }).click();
  await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
  await expect(chat.locator(".chat-message.assistant").last()).toContainText(
    "测试回合 2",
  );
  await page.screenshot({
    path: `artifacts/stage2-chat-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await chat.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();
  await page.getByRole("button", { name: "问 AI", exact: true }).click();
  await expect(chat.locator(".chat-message")).toHaveCount(4);
  const conversations = await (
    await page.request.get(`/api/documents/${documentId}/conversations`)
  ).json();
  expect(conversations.conversations).toHaveLength(1);
  expect(conversations.conversations[0].messages).toHaveLength(4);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  const deleted = await page.request.delete(`/api/documents/${documentId}`, {
    data: { revision: saved.revision },
  });
  expect(deleted.status()).toBe(204);
  await page.request.post("/api/ai/logout");
  expect(browserErrors).toEqual([]);
});

test(accountFlowTitle, async ({ page, playwright, baseURL }, info) => {
  // A separate HTTP context prepares the administrator while the browser itself
  // stays anonymous. Login and invite registration below happen through the UI.
  const administrator = await playwright.request.newContext({ baseURL });
  let documentId;
  try {
    await ensureOwnerSession(administrator);
    const created = await administrator.post("/api/documents", {
      data: {
        title: "管理员自己的资料",
        kind: "article",
        orientation: "horizontal",
        content: "この文章は別の人には見えません。",
      },
    });
    expect(created.status()).toBe(201);
    const ownerDocument = await created.json();
    documentId = ownerDocument.id;
    expect((await page.request.get("/api/documents")).status()).toBe(401);
    await page.goto("/");
    await expect(
      page.getByRole("heading", { name: "回到你的书架", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "网站账号", exact: true })
      .fill(testOwner.username);
    await page
      .getByLabel("网站账号密码", { exact: true })
      .fill(testOwner.password);
    await page.getByRole("button", { name: "登录书架", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /从一段想读的/ }),
    ).toBeVisible();
    if (
      await page
        .getByRole("button", { name: "打开书架", exact: true })
        .isVisible()
    ) {
      await page.getByRole("button", { name: "打开书架", exact: true }).click();
    }
    const menu = page.getByRole("region", {
      name: "当前网站账号",
      exact: true,
    });
    await expect(
      menu.getByText(testOwner.username, { exact: true }),
    ).toBeVisible();
    await menu
      .getByRole("button", { name: "生成朋友的邀请码", exact: true })
      .click();
    const invitation = menu.getByRole("textbox", {
      name: "新生成的邀请码",
      exact: true,
    });
    await expect(invitation).toBeVisible();
    const inviteToken = await invitation.inputValue();
    expect(inviteToken.length).toBeGreaterThan(20);
    await page.screenshot({
      path: `artifacts/stage2-site-owner-invitation-${info.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await menu.getByRole("button", { name: "退出", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "回到你的书架", exact: true }),
    ).toBeVisible();
    expect((await page.request.get("/api/documents")).status()).toBe(401);
    await page
      .getByRole("button", { name: "凭邀请码注册", exact: true })
      .click();
    const username = `friend_${info.project.name}_${Date.now().toString(36)}`;
    await page
      .getByRole("textbox", { name: "网站账号", exact: true })
      .fill(username);
    await page
      .getByLabel("网站账号密码", { exact: true })
      .fill("fixture-friend-password");
    await page
      .getByRole("textbox", { name: "邀请码", exact: true })
      .fill(inviteToken);
    await page.getByRole("button", { name: "注册并登录", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: /从一段想读的/ }),
    ).toBeVisible();
    if (
      await page
        .getByRole("button", { name: "打开书架", exact: true })
        .isVisible()
    ) {
      await page.getByRole("button", { name: "打开书架", exact: true }).click();
    }
    await expect(menu.getByText(username, { exact: true })).toBeVisible();
    await expect(
      menu.getByRole("button", { name: "生成朋友的邀请码", exact: true }),
    ).toHaveCount(0);
    const library = await page.request.get("/api/documents");
    expect(library.status()).toBe(200);
    expect((await library.json()).documents).toEqual([]);
    expect([403, 404]).toContain(
      (await page.request.get(`/api/documents/${documentId}`)).status(),
    );
    await page.screenshot({
      path: `artifacts/stage2-site-friend-private-library-${info.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await menu.getByRole("button", { name: "退出", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "回到你的书架", exact: true }),
    ).toBeVisible();
    expect((await page.request.get("/api/documents")).status()).toBe(401);
  } finally {
    if (documentId) {
      await ensureOwnerSession(administrator);
      const current = await administrator.get(`/api/documents/${documentId}`);
      if (current.ok()) {
        const value = await current.json();
        await administrator.delete(`/api/documents/${documentId}`, {
          data: { revision: value.revision },
        });
      }
    }
    await administrator.dispose();
  }
});
