import { test, expect } from "@playwright/test";
import { ensureOwnerSession, testOwner } from "./session.mjs";

const iosHint = page => page.locator(".pwa-banner").filter({ hasText: "添加到主屏幕" });
const choiceCookie = async page => (await page.context().cookies()).find(cookie => cookie.name === "yohaku_pwa_choice");
async function installEvent(page, outcome = "dismissed") {
  await page.evaluate(outcome => {
    const event = new Event("beforeinstallprompt", { cancelable: true });
    event.prompt = async () => {};
    event.userChoice = Promise.resolve({ outcome });
    window.dispatchEvent(event);
  }, outcome);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari", configurable: true });
  });
  await page.route("**/yohaku.crt", route => route.fulfill({ status: 404, body: "" }));
});

test("iOS明确选择在同次登录刷新后保留，Cookie期限与真实网站登录一致", async ({ page }) => {
  await ensureOwnerSession(page.request);
  const session = await (await page.request.get("/api/session")).json();
  await page.goto("/");
  await expect(iosHint(page)).toBeVisible();
  await iosHint(page).getByRole("button", { name: "知道了", exact: true }).click();
  const choice = await choiceCookie(page);
  expect(choice).toBeTruthy();
  expect(Math.abs(choice.expires - session.loginSession.expiresAt / 1000)).toBeLessThan(1);
  expect(await page.evaluate(() => document.cookie.includes("yohaku_session="))).toBe(false);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(iosHint(page)).toHaveCount(0);
  expect((await choiceCookie(page)).expires).toBe(choice.expires);
  await installEvent(page);
  await expect(page.getByRole("button", { name: "安装", exact: true })).toHaveCount(0);
});

test("原生安装拒绝后重复事件与刷新都不再主动提示", async ({ page }) => {
  await ensureOwnerSession(page.request);
  await page.goto("/");
  await expect(iosHint(page)).toBeVisible();
  await installEvent(page);
  await page.getByRole("button", { name: "安装", exact: true }).click();
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
  expect(JSON.parse(decodeURIComponent((await choiceCookie(page)).value)).choice).toBe("dismissed");
  await installEvent(page);
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
  await page.reload();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
});

test("访客暂不选择平滑承接登录，退出后重新评估", async ({ page }) => {
  await ensureOwnerSession(page.request);
  await page.request.post("/api/session/logout", { data: {} });
  await page.goto("/");
  await expect(page.locator(".account-gate")).toBeVisible();
  await installEvent(page);
  await page.getByRole("button", { name: "暂不", exact: true }).click();
  expect((await choiceCookie(page)).expires).toBe(-1);
  await page.getByRole("textbox", { name: "网站账号", exact: true }).fill(testOwner.username);
  await page.getByRole("textbox", { name: "网站账号密码", exact: true }).fill(testOwner.password);
  await page.getByRole("button", { name: "登录书架", exact: true }).click();
  await expect(page.locator(".app-shell")).toBeVisible();
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
  const session = await (await page.request.get("/api/session")).json();
  await expect.poll(async () => (await choiceCookie(page))?.expires).toBe(Math.floor(session.loginSession.expiresAt / 1000));
  await page.request.post("/api/session/logout", { data: {} });
  await page.reload();
  await expect(page.locator(".account-gate")).toBeVisible();
  await expect(iosHint(page)).toBeVisible();
});

test("登录状态未加载时不闪出安装提示", async ({ page }) => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route("**/api/session", async route => { await gate; await route.continue(); });
  try {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.getByText("正在读取登录状态…", { exact: true })).toBeVisible();
    await expect(page.locator(".pwa-banner")).toHaveCount(0);
  } finally { release(); }
  await expect(page.locator(".account-gate")).toBeVisible();
  await expect(iosHint(page)).toBeVisible();
});

test("旧iOS关闭记录迁移到Cookie，独立窗口始终隐藏安装提示", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("yohaku.pwa.iosHintDismissed", "1");
  });
  await page.goto("/");
  await expect(page.locator(".account-gate")).toBeVisible();
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
  await expect.poll(async () => !!await choiceCookie(page)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("yohaku.pwa.iosHintDismissed"))).toBe(null);
  await page.context().clearCookies();
  await page.addInitScript(() => { Object.defineProperty(navigator, "standalone", { value: true }); });
  await page.reload();
  await expect(page.locator(".account-gate")).toBeVisible();
  await installEvent(page);
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
});

test("独立窗口隐藏安装提示但仍能下载网站证书", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "standalone", { value: true });
  });
  await page.route("**/yohaku.crt", route => route.fulfill({
    status: 200,
    contentType: "application/x-x509-ca-cert",
    body: "",
  }));
  await page.goto("/");
  await expect(page.locator(".account-gate")).toBeVisible();
  await expect(page.getByRole("link", { name: "网站证书", exact: true })).toHaveAttribute("href", "/yohaku.crt");
  await installEvent(page);
  await expect(page.locator(".pwa-banner")).toHaveCount(0);
});
