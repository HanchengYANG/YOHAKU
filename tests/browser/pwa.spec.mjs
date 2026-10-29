import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  // An untrusted HTTPS certificate can prevent service-worker availability.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "serviceWorker", { value: undefined, configurable: true });
    delete Object.getPrototypeOf(navigator).serviceWorker;
    delete navigator.serviceWorker;
    Object.defineProperty(navigator, "userAgent", { value: "iPhone Safari" });
  });
});

test("未登录访问者可下载生产根证书并看到 iOS 安装与信任指引", async ({ page }) => {
  await page.route("**/yohaku.crt", (route) => route.fulfill({
    status: 200,
    contentType: "application/x-x509-ca-cert",
    body: "",
  }));
  await page.goto("/");
  const banner = page.getByRole("status").filter({ hasText: "证书信任设置" });
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("已下载描述文件");
  await expect(banner.getByRole("link", { name: "下载证书", exact: true })).toHaveAttribute("href", "/yohaku.crt");
  await expect(page.locator(".account-gate")).toBeVisible();
});

test("首页回退的 HTML 不会被误认为可安装证书", async ({ page }) => {
  await page.route("**/yohaku.crt", (route) => route.fulfill({
    status: 200,
    contentType: "text/html",
    body: "<!doctype html><title>App shell</title>",
  }));
  await page.goto("/");
  await expect(page.locator(".account-gate")).toBeVisible();
  await expect(page.getByRole("link", { name: "下载证书", exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "网站证书", exact: true })).toHaveCount(0);
});
