// UI integration only: actual uploads/Sharp/SQLite, explicit OAuth/model doubles.
// These checks are not evidence of real subscription authorization or OCR quality.
import { test, expect } from "@playwright/test";
import { writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ensureOwnerSession, testOwner } from "./session.mjs";
import { discardFixtureTasks } from "./image-task-fixture.mjs";
import { openAccountMenu } from "./navigation.mjs";
const accountFlowTitle = "网站账号登录、退出与邀请码注册使用真实会话和资料隔离";
let ownerCookies = [];
test.beforeEach(async ({ page }, info) => {
  if (info.title === accountFlowTitle) return;
  // Reuse this isolated fixture session instead of logging in once per test;
  // the complete suite exceeds the production login rate limit otherwise.
  // The account-flow test creates its own contexts and still tests real login.
  if (ownerCookies.length) await page.context().addCookies(ownerCookies);
  await ensureOwnerSession(page.request);
  ownerCookies = await page.context().cookies();
});

let imagePath, secondImagePath, imageDirectory;
test.beforeAll(async () => {
  imageDirectory = await mkdtemp(join(tmpdir(), "yohaku-browser-images-"));
  imagePath = join(imageDirectory, "first.png");
  secondImagePath = join(imageDirectory, "second.png");
  await sharp({ create: { width: 800, height: 600, channels: 3, background: "#f5f3ee" } }).png().toFile(imagePath);
  await sharp({ create: { width: 640, height: 480, channels: 3, background: "#e4ebdf" } }).png().toFile(secondImagePath);
});
test.afterAll(async () => {
  if (imageDirectory) await rm(imageDirectory, { recursive: true, force: true });
});
const callback =
  "/auth/callback?state=ui-test-state&code=ui-test-code&client_id=ui-test-client";
const ocrText = "僕が生まれた日の空は\n\n背中を撫でる\n用語（原文）\nアキックス：「ここで食べる。」";
const runtimeControlsPath = new URL("../../artifacts/ai-e2e-data/image-runtime-controls.json", import.meta.url);
const activeTasks = new Set();
const setImageControls = async (controls = {}) => {
  const temporary = new URL("./image-runtime-controls.stage2.tmp", runtimeControlsPath);
  await writeFile(temporary, JSON.stringify(controls));
  await rename(temporary, runtimeControlsPath);
};
async function getTask(page, id) {
  const response = await page.request.get(`/api/image-tasks/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function submitImageTask(page) {
  const submit = page.getByRole("button", { name: "识别并注音", exact: true });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(page.getByRole("region", { name: "任务状态", exact: true })).toBeVisible();
  const id = await page.evaluate(() => location.hash.slice("#tasks/".length));
  expect(id).toMatch(/^[a-f0-9-]+$/); activeTasks.add(id);
  return id;
}
async function waitTask(page, id, state = "ready") {
  await expect.poll(async () => (await getTask(page, id)).state, { timeout: 20000 }).toBe(state);
  return getTask(page, id);
}
async function openTaskResult(page, id, button = "开始校对") {
  await page.getByRole("button", { name: button, exact: true }).click();
  await expect(page.locator(".editor-page")).toBeVisible();
  const response = await page.request.get(`/api/image-tasks/${id}/result`);
  expect(response.ok()).toBe(true);
  const result = await response.json(), recognition = result.sourceImages[0]?.recognition;
  return { ...recognition, ...result, annotation: recognition?.annotation,
    blocks: recognition?.annotation?.blocks || result.blocks,
    annotationReasoningEffort: recognition?.annotation?.reasoningEffort };
}
test.afterEach(async ({ page }) => {
  await setImageControls();
  discardFixtureTasks(activeTasks);
  activeTasks.clear();
  const status = await page.request.get("/api/ai/status");
  if (status.ok()) await expect.poll(async () => {
    const response = await page.request.get("/api/ai/status");
    return !response.ok() || !(await response.json()).runtime.busy;
  }).toBe(true);
});

async function openSettings(page) {
  // OAuth return may finish navigation before React has loaded the website
  // session. Wait for the workspace before deciding whether its drawer exists.
  await expect(page.locator(".main-panel")).toBeVisible();
  if (
    await page
      .getByRole("region", { name: "AI 授权设置", exact: true })
      .isVisible()
  )
    return;
  await openAccountMenu(page);
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "AI 设置", exact: true }),
  ).toBeVisible();
}

async function enableTestAccount(page) {
  // Owner provider callbacks must originate from a real website session and
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
    false,
  );
  expect(
    await providers
      .locator("option")
      .evaluateAll((options) =>
        options
          .filter((option) => !option.disabled)
          .map((option) => option.value),
      ),
  ).toEqual(["openai", "api_base"]);
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
  await expect(page.getByText("当前模型：UI-TEST-DOUBLE", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存提供方", exact: true })).toHaveCount(0);
  await page.screenshot({
    path: `artifacts/stage2-auth-connected-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "断开授权", exact: true }).click();
  await expect(page.getByText("尚未授权", { exact: true })).toBeVisible();
});

test("后台完成时间持久保存，打开校对原图的加载不延长任务历时", async ({ page }) => {
  await enableTestAccount(page);
  const response = await page.request.post("/api/image-tasks", { data: { idempotencyKey: `completion-duration-${Date.now()}` } });
  expect(response.ok()).toBe(true);
  const draft = await response.json(); activeTasks.add(draft.id);
  // Existing image drafts remain resumable through their task link.
  await page.goto(`/#tasks/${draft.id}`);
  await expect(page.getByRole("heading", { name: "导入照片或截图", exact: true })).toBeVisible();
  await setImageControls({ delayMs: 120 });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const id = await submitImageTask(page), completed = await waitTask(page, id);
  expect(Date.parse(completed.completedAt)).toBeGreaterThan(Date.parse(completed.startedAt));
  await expect(page.locator(".task-statistics")).toContainText("历时");
  let releaseImage;
  const gate = new Promise((resolve) => { releaseImage = resolve; });
  await page.route(/\/api\/images\/[^/]+\/raw(?:\?.*)?$/, async (route) => { await gate; await route.continue(); });
  try {
    const result = await openTaskResult(page, id);
    expect(result.annotation).toBeTruthy();
    await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
    const persisted = await getTask(page, id);
    expect(persisted.completedAt).toBe(completed.completedAt);
    expect(persisted.state).toBe("ready");
  } finally { releaseImage(); }
  const image = page.getByAltText("用于校对正文和注音的日语原图", { exact: true });
  await expect.poll(() => image.evaluate((element) => element.complete && element.naturalWidth > 0)).toBe(true);
  expect((await getTask(page, id)).completedAt).toBe(completed.completedAt);
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
      page.getByRole("region", { name: "登录网站账号", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("textbox", { name: "网站账号", exact: true })
      .fill(testOwner.username);
    await page
      .getByLabel("网站账号密码", { exact: true })
      .fill(testOwner.password);
    await page.getByRole("button", { name: "登录书架", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "阅读首页", exact: true }),
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
    await openAccountMenu(page);
    await menu.getByRole("button", { name: "邀请朋友", exact: true }).click();
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
      page.getByRole("region", { name: "登录网站账号", exact: true }),
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
      page.getByRole("region", { name: "阅读首页", exact: true }),
    ).toBeVisible();
    if (
      await page
        .getByRole("button", { name: "打开书架", exact: true })
        .isVisible()
    ) {
      await page.getByRole("button", { name: "打开书架", exact: true }).click();
    }
    await expect(menu.getByText(username, { exact: true })).toBeVisible();
    await openAccountMenu(page);
    await expect(menu.getByRole("button", { name: "邀请朋友", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "AI 设置", exact: true })).toHaveCount(0);
    expect((await page.request.post("/api/ai/login", { data: {} })).status()).toBe(403);
    const aiStatus = await page.request.get("/api/ai/status");
    expect((await aiStatus.json()).canManageAI).toBe(false);
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
      page.getByRole("region", { name: "登录网站账号", exact: true }),
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

