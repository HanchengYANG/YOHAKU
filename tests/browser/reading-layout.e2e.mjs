import { test, expect } from "@playwright/test";
import { ensureOwnerSession } from "./session.mjs";

test("阅读区回收空白，桌面书架可收起并记忆，手机抽屉独立", async ({ page }, info) => {
  await ensureOwnerSession(page.request);
  const response = await page.request.post("/api/documents", { data: {
    title: `阅读布局 ${info.project.name}`, kind: "article", orientation: "horizontal",
    bodyHtml: Array.from({ length: 45 }, (_, i) => `<p data-paragraph-id="layout-p-${i}"><span data-sentence-id="layout-s-${i}">静かな部屋で、本の続きをゆっくり読む。窓の外では風が吹いている。</span></p>`).join(""),
  } });
  expect(response.status()).toBe(201);
  const document = await response.json();
  try {
    if (info.project.name === "phone") await page.addInitScript(() => localStorage.setItem("yohaku.sidebarCollapsed", "1"));
    await page.goto(`/#${document.id}`);
    const article = page.getByRole("article", { name: "日语原文", exact: true });
    await expect(article).toBeVisible();
    const shelf = page.getByRole("complementary", { name: "书架", exact: true });
    if (info.project.name === "phone") {
      await expect(page.getByRole("button", { name: "收起书架", exact: true })).toBeHidden();
      await page.getByRole("button", { name: "打开书架", exact: true }).click();
      await expect(shelf).toHaveClass(/is-open/);
      await page.getByRole("button", { name: "关闭书架", exact: true }).click({position:{x:page.viewportSize().width-12,y:100}});
      await expect(shelf).not.toHaveClass(/is-open/);
      return;
    }
    for (const width of [1024, 1100, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      const readingWidth = await page.locator(".reader-page").evaluate(element => element.getBoundingClientRect().width);
      const expected = await page.locator(".main-panel").evaluate(element => Math.min(960, element.clientWidth - 48));
      expect(Math.abs(readingWidth - expected)).toBeLessThan(2);
      await page.getByRole("button", { name: "收起书架", exact: true }).click();
      await expect(shelf).toBeHidden();
      const collapsedExpected = await page.locator(".main-panel").evaluate(element => Math.min(960, element.clientWidth - 48));
      expect(Math.abs((await page.locator(".reader-page").boundingBox()).width - collapsedExpected)).toBeLessThan(2);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole("button", { name: "展开书架", exact: true }).click();
      await expect(shelf).toBeVisible();
    }
    await page.setViewportSize({ width: 1100, height: 1000 });
    await page.evaluate(() => scrollTo(0, 1300));
    const anchor = await article.evaluate(element => {
      const sentence = [...element.querySelectorAll("[data-sentence-id]")].find(node => node.getBoundingClientRect().bottom > 64);
      return { id: sentence.dataset.sentenceId, top: sentence.getBoundingClientRect().top };
    });
    await page.getByRole("button", { name: "收起书架", exact: true }).click();
    expect(Math.abs((await article.locator(`[data-sentence-id="${anchor.id}"]`).boundingBox()).y - anchor.top)).toBeLessThan(2);
    expect(await page.evaluate(() => localStorage.getItem("yohaku.sidebarCollapsed"))).toBe("1");
    await page.reload();
    await expect(page.getByRole("button", { name: "展开书架", exact: true })).toBeVisible();
    const other = await page.context().newPage();
    try {
      await other.goto(`/#${document.id}`);
      await expect(other.getByRole("button", { name: "展开书架", exact: true })).toBeVisible();
      await other.setViewportSize({ width: 390, height: 844 });
      await expect(other.getByRole("button", { name: "展开书架", exact: true })).toBeHidden();
      await other.getByRole("button", { name: "打开书架", exact: true }).click();
      await expect(other.getByRole("complementary", { name: "书架", exact: true })).toHaveClass(/is-open/);
    } finally { await other.close(); }
    await page.screenshot({ path: "artifacts/reading-layout-desktop.png", fullPage: false });
  } finally {
    const current = await page.request.get(`/api/documents/${document.id}`);
    if (current.ok()) await page.request.delete(`/api/documents/${document.id}`, { data: { revision: (await current.json()).revision } });
  }
});
