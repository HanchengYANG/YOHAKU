import { test, expect } from "@playwright/test";
import { ensureOwnerSession } from "./session.mjs";

test("阅读页收起书架并定宽居中，书架以浮层打开且不改动保存的选择，手机为抽屉", { tag: "@phone" }, async ({ page }, info) => {
  await ensureOwnerSession(page.request);
  const response = await page.request.post("/api/documents", { data: {
    title: `阅读布局 ${info.project.name}`, kind: "article", orientation: "horizontal",
    bodyHtml: Array.from({ length: 45 }, (_, i) => `<p data-paragraph-id="layout-p-${i}"><span data-sentence-id="layout-s-${i}">静かな部屋で、本の続きをゆっくり読む。窓の外では風が吹いている。</span></p>`).join(""),
  } });
  expect(response.status()).toBe(201);
  const document = await response.json();
  try {
    await page.goto(`/#${document.id}`);
    const article = page.getByRole("article", { name: "日语原文", exact: true });
    await expect(article).toBeVisible();
    const shelf = page.getByRole("complementary", { name: "书架", exact: true });
    const openShelf = page.getByRole("button", { name: "打开书架", exact: true });
    const closeShelf = () => page.getByRole("button", { name: "关闭书架", exact: true }).click({ position: { x: page.viewportSize().width - 12, y: 300 } });
    if (info.project.name === "phone") {
      await openShelf.click();
      await expect(shelf).toHaveClass(/is-open/);
      await closeShelf();
      await expect(shelf).not.toHaveClass(/is-open/);
      return;
    }
    const saved = await page.evaluate(() => localStorage.getItem("yohaku.sidebarCollapsed"));
    for (const width of [1024, 1100, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(shelf).toBeHidden();
      const column = await page.locator(".reader-page").evaluate((element) => ({
        width: element.getBoundingClientRect().width,
        expected: Math.min(800, element.closest(".reader-main-column").clientWidth - 32),
      }));
      expect(Math.abs(column.width - column.expected)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await openShelf.click();
      await expect(shelf).toBeVisible();
      await closeShelf();
      await expect(shelf).toBeHidden();
    }
    expect(await page.evaluate(() => localStorage.getItem("yohaku.sidebarCollapsed"))).toBe(saved);

    // Between 1024 and 1199px the chat panel covers the text instead of narrowing it.
    await page.setViewportSize({ width: 1100, height: 1000 });
    const before = await page.locator(".reader-page").boundingBox();
    await page.getByRole("button", { name: /^对话/ }).click();
    await expect(page.getByLabel("原文 AI 讨论", { exact: true })).toBeVisible();
    const after = await page.locator(".reader-page").boundingBox();
    expect(Math.abs(after.width - before.width)).toBeLessThan(2);
    expect(Math.abs(after.x - before.x)).toBeLessThan(2);
    await page.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();

    await page.goto("/");
    await expect(shelf).toBeVisible();
    await page.screenshot({ path: "artifacts/reading-layout-desktop.png", fullPage: false });
  } finally {
    const current = await page.request.get(`/api/documents/${document.id}`);
    if (current.ok()) await page.request.delete(`/api/documents/${document.id}`, { data: { revision: (await current.json()).revision } });
  }
});
