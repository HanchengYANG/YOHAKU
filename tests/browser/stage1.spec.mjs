import { test, expect } from "@playwright/test";
import { ensureOwnerSession } from "./session.mjs";

test.beforeEach(async ({ page }) => {
  await ensureOwnerSession(page.request);
});

async function deleteDocument(page, id) {
  const current = await (await page.request.get(`/api/documents/${id}`)).json();
  const deleted = await page.request.delete(`/api/documents/${id}`, {
    data: { revision: current.revision },
  });
  expect(deleted.status()).toBe(204);
}

async function selectWord(page, from, to) {
  await page.getByRole("textbox", { name: "日语正文" }).evaluate(
    (el, { from, to }) => {
      el.focus();
      el.setSelectionRange(from, to - 1);
    },
    { from, to },
  );
  await page
    .getByRole("textbox", { name: "日语正文" })
    .press("Shift+ArrowRight");
}

test("导入、选区注音、校对、保存重开、导出及手机布局", async ({
  page,
}, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: /从一段想读的/ }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/stage1-welcome-${info.project.name}.png`,
    fullPage: true,
  });
  await page
    .getByRole("button", { name: "导入第一篇文字", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "材料标题" })
    .fill(`验收歌词 ${info.project.name}`);
  await page
    .getByRole("textbox", { name: "日语正文" })
    .fill("はーい口開けてー\n汚い言葉の歯石が取れないね〜\n\n背中を見た");
  await selectWord(page, 3, 4);
  await page
    .getByRole("textbox", { name: "假名读音", exact: true })
    .fill("くち");
  await page.getByRole("button", { name: "添加注音" }).click();
  await selectWord(page, 4, 5);
  await page.getByRole("textbox", { name: "假名读音", exact: true }).fill("あ");
  await page.getByRole("button", { name: "添加注音" }).click();
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const reading = page.getByRole("textbox", {
    name: "口的读音（第1行）",
    exact: true,
  });
  await reading.fill("");
  await expect(reading).toBeVisible();
  await expect(page.getByRole("button", { name: "保存并阅读" })).toBeDisabled();
  await reading.fill("くち");
  await page.screenshot({
    path: `artifacts/stage1-editor-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "保存并阅读" }).click();
  await expect(
    page.getByRole("heading", {
      name: `验收歌词 ${info.project.name}`,
      exact: true,
    }),
  ).toBeVisible();
  const docId = await page.evaluate(() => window.location.hash.slice(1));
  const article = page.getByRole("article", { name: "日语原文" });
  await expect(article.locator("rt")).toHaveText(["くち", "あ"]);
  await expect(article.locator(".text-line")).toHaveCount(4);
  await page.reload();
  await expect(article.locator("rt")).toHaveText(["くち", "あ"]);
  const rects = await article
    .locator("ruby")
    .first()
    .evaluate((el) => {
      const r = el.querySelector("rt").getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el.firstChild);
      const base = range.getBoundingClientRect();
      return {
        rubyBottom: r.bottom,
        baseMiddle: base.top + base.height / 2,
        rubyHeight: r.height,
        baseHeight: base.height,
      };
    });
  // Font ranges include ascent whitespace; ruby must sit above the base's middle.
  expect(rects.rubyBottom).toBeLessThan(rects.baseMiddle);
  expect(rects.rubyHeight).toBeLessThan(rects.baseHeight);
  await page.getByRole("button", { name: "隐藏注音" }).click();
  await expect(article.locator("rt").first()).toHaveCSS("visibility", "hidden");
  await page.getByRole("button", { name: "显示注音" }).click();
  await page.getByRole("slider", { name: "阅读字号" }).fill("30");
  await expect(article.locator(".japanese-text")).toHaveCSS(
    "font-size",
    "30px",
  );
  await page.screenshot({
    path: `artifacts/stage1-reader-${info.project.name}.png`,
    fullPage: true,
  });
  const json = await page.request.get(
    `/api/documents/${docId}/export?format=json`,
  );
  expect((await json.json()).document.content).toContain(
    "{口|くち}{開|あ}けてー",
  );
  const markdown = await page.request.get(
    `/api/documents/${docId}/export?format=markdown`,
  );
  expect(await markdown.text()).toContain("<rt>くち</rt>");
  const downloadReady = page.waitForEvent("download");
  await page.getByRole("link", { name: "Markdown", exact: true }).click();
  expect((await downloadReady).suggestedFilename()).toMatch(/\.md$/);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.getByRole("button", { name: "校对文字与注音" }).click();
  await page
    .getByRole("textbox", { name: "日语正文" })
    .fill(
      "はーい口開けてー\n汚い言葉の歯石が取れないね〜\n\n背中を見た\n追加の行",
    );
  await expect(
    page.getByRole("region", { name: "阅读预览" }).locator("rt"),
  ).toHaveText(["くち", "あ"]);
  await page.getByRole("button", { name: "保存并阅读" }).click();
  await expect(article.locator(".text-line")).toHaveCount(5);
  await deleteDocument(page, docId);
  expect(errors).toEqual([]);
});

test("未保存离开会确认，新建能清空旧草稿，慢速保存期间锁定编辑", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "试试注音示例" }).click();
  page.once("dialog", (dialog) => dialog.dismiss());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "日语正文" })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  if (await page.getByRole("button", { name: "打开书架" }).isVisible()) {
    await page.getByRole("button", { name: "打开书架" }).click();
  }
  await page.getByRole("button", { name: "导入文字", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "材料标题" })).toHaveValue("");
  await expect(page.getByRole("textbox", { name: "日语正文" })).toHaveValue("");
  await page.getByRole("textbox", { name: "材料标题" }).fill("慢速保存");
  await page.getByRole("textbox", { name: "日语正文" }).fill("空を見た");
  let release;
  const delayed = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() === "POST") {
      await delayed;
    }
    await route.continue();
  });
  await page.getByRole("button", { name: "保存并阅读" }).click();
  await expect(page.getByRole("textbox", { name: "日语正文" })).toBeDisabled();
  await expect(page.getByRole("textbox", { name: "材料标题" })).toBeDisabled();
  release();
  await expect(
    page.getByRole("heading", { name: "慢速保存", exact: true }),
  ).toBeVisible();
  const id = await page.evaluate(() => location.hash.slice(1));
  await deleteDocument(page, id);
});

test("多页面版本冲突后可以重新打开最新材料", async ({ page }) => {
  const created = await page.request.post("/api/documents", {
    data: {
      title: "并发修改",
      kind: "article",
      orientation: "horizontal",
      content: "最初の文章",
    },
  });
  const old = await created.json();
  await page.goto(`/#${old.id}`);
  await page.getByRole("button", { name: "校对文字与注音" }).click();
  await page.getByRole("textbox", { name: "材料标题" }).fill("旧页面的修改");
  await page.request.put(`/api/documents/${old.id}`, {
    data: { ...old, title: "其他页面已更新" },
  });
  await page.getByRole("button", { name: "保存并阅读" }).click();
  await expect(page.getByRole("alert")).toContainText("其他页面修改");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  if (await page.getByRole("button", { name: "打开书架" }).isVisible())
    await page.getByRole("button", { name: "打开书架" }).click();
  await page
    .getByRole("navigation", { name: "阅读材料" })
    .getByRole("button", { name: /并发修改/ })
    .click();
  await expect(
    page.getByRole("heading", { name: "其他页面已更新", exact: true }),
  ).toBeVisible();
  await deleteDocument(page, old.id);
});

test("无效材料显示错误，搜索书架后仍可重试", async ({ page }) => {
  await page.goto("/#missing-document");
  await expect(
    page.getByRole("button", { name: "重新打开", exact: true }),
  ).toBeVisible();
  if (await page.getByRole("button", { name: "打开书架" }).isVisible())
    await page.getByRole("button", { name: "打开书架" }).click();
  await page.getByRole("textbox", { name: "搜索书架" }).fill("不存在的词");
  await expect(
    page.getByRole("navigation", { name: "阅读材料" }),
  ).toContainText("没有找到匹配的材料");
  if (
    await page
      .getByRole("button", { name: "关闭书架", exact: true })
      .isVisible()
  )
    await page
      .getByRole("button", { name: "关闭书架", exact: true })
      .click({ position: { x: 320, y: 20 } });
  await expect(
    page.getByRole("button", { name: "重新打开", exact: true }),
  ).toBeVisible();
});

test("词组注音示例支持竖排，注音位于字词右侧", async ({ page }, info) => {
  await page.goto("/");
  await page.getByRole("button", { name: "试试注音示例" }).click();
  await page
    .getByRole("combobox", { name: "阅读方向" })
    .selectOption("vertical");
  await page.getByRole("button", { name: "保存并阅读" }).click();
  const article = page.getByRole("article", { name: "日语原文" });
  await expect(article.locator(".japanese-text")).toHaveCSS(
    "writing-mode",
    "vertical-rl",
  );
  const position = await article
    .locator("ruby")
    .first()
    .evaluate((el) => {
      const rt = el.querySelector("rt").getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el.firstChild);
      const base = range.getBoundingClientRect();
      return { rtLeft: rt.left, baseMiddle: base.left + base.width / 2 };
    });
  expect(position.rtLeft).toBeGreaterThan(position.baseMiddle);
  await expect(article.locator("rt")).toContainText([
    "くち",
    "あ",
    "きたな",
    "ことば",
    "しせき",
    "と",
  ]);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `artifacts/stage1-vertical-${info.project.name}.png`,
    fullPage: true,
  });
  const id = await page.evaluate(() => location.hash.slice(1));
  await deleteDocument(page, id);
});
