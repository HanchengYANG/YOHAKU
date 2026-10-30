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
    page.getByRole("region", { name: "阅读首页", exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: `artifacts/stage1-welcome-${info.project.name}.png`,
    fullPage: true,
  });
  if (await page.getByRole("button", { name: "打开书架", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "打开书架", exact: true }).click();
  }
  await page
    .getByRole("button", { name: "导入文字", exact: true })
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
  if (await page.getByRole("button", { name: "打开书架", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "打开书架", exact: true }).click();
  }
  await page.getByRole("button", { name: "导入文字", exact: true }).click();
  await page.getByRole("textbox", { name: "日语正文" }).fill("未保存草稿");
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

test("原词示例与完整词注音统一横排，注音在上方并能保存重开", async ({ page }, info) => {
  const created = await page.request.post("/api/documents", {
    data: {
      title: "把读音放回字词上方",
      kind: "lyrics",
      orientation: "horizontal",
      content:
        "はーい{口|くち}{開|あ}けてー\n{汚|きたな}い{言葉|ことば}の{歯石|しせき}が{取|と}れないね〜\n\n{僕|ぼく}が{生|う}まれた{日|ひ}の{空|そら}は\n{背中|せなか}を{撫|な}でる{声|こえ}を{聞|き}いたあの{日|ひ}",
    },
  });
  expect(created.ok()).toBe(true);
  const initial = await created.json();
  await page.goto(`/#${initial.id}`);
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  await expect(page.getByRole("combobox", { name: "阅读方向" })).toHaveCount(0);
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator(".japanese-text")).toHaveCSS(
    "writing-mode",
    "horizontal-tb",
  );
  const originalReadings = [
    "くち", "あ", "きたな", "ことば", "しせき", "と", "ぼく", "う",
    "ひ", "そら", "せなか", "な", "こえ", "き", "ひ",
  ];
  await expect(preview.locator("rt")).toHaveText(originalReadings);
  const body = page.getByRole("textbox", { name: "日语正文" });
  const originalText = await body.inputValue();
  await body.fill(`${originalText}\n食べる`);
  await selectWord(page, originalText.length + 1, originalText.length + 4);
  await page
    .getByRole("textbox", { name: "假名读音", exact: true })
    .fill("たべる");
  await page.getByRole("button", { name: "添加注音" }).click();
  await expect(preview.locator("rt")).toHaveText([...originalReadings, "た"]);
  await page.getByRole("button", { name: "保存并阅读" }).click();
  const article = page.getByRole("article", { name: "日语原文" });
  await expect(article.locator(".japanese-text")).toHaveCSS(
    "writing-mode",
    "horizontal-tb",
  );
  await expect(article.locator("rt")).toHaveText([...originalReadings, "た"]);
  await expect(article.locator(".text-line")).toHaveCount(6);
  const displayedKanji = article.locator("ruby").last();
  expect(await displayedKanji.evaluate((el) => el.firstChild.textContent)).toBe("食");
  const position = await article
    .locator("ruby")
    .last()
    .evaluate((el) => {
      const rt = el.querySelector("rt").getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(el.firstChild);
      const base = range.getBoundingClientRect();
      return {
        rtBottom: rt.bottom,
        baseMiddle: base.top + base.height / 2,
        rtHeight: rt.height,
        baseHeight: base.height,
      };
    });
  expect(position.rtBottom).toBeLessThan(position.baseMiddle);
  expect(position.rtHeight).toBeLessThan(position.baseHeight);
  const id = await page.evaluate(() => location.hash.slice(1));
  const saved = await (await page.request.get(`/api/documents/${id}`)).json();
  expect(saved.orientation).toBe("horizontal");
  expect(saved.content).toContain("{食べる|たべる}");
  expect(saved.blocks.at(-1).segments).toEqual([
    { text: "食べる", reading: "たべる", origin: "manual" },
  ]);
  await page.reload();
  await expect(article.locator(".japanese-text")).toHaveCSS("writing-mode", "horizontal-tb");
  await expect(article.locator("rt")).toHaveText([...originalReadings, "た"]);
  expect(await article.locator("ruby").last().evaluate((el) => el.firstChild.textContent))
    .toBe("食");
  expect(await (await page.request.get(`/api/documents/${id}`)).json()).toEqual(saved);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `artifacts/stage1-horizontal-whole-word-${info.project.name}.png`,
    fullPage: true,
  });
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  await page.getByRole("tab", { name: /注音校正/ }).click();
  await expect(page.getByRole("textbox", { name: "食べる的读音（第6行）", exact: true }))
    .toHaveValue("たべる");
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await deleteDocument(page, id);
});

test("假名锚点只让汉字显示注音，前后缀与多汉字整词保存校对不拆分", async ({ page }, info) => {
  const content = "{お父さん|おとうさん}。{取り戻す|とりもどす}。\n{キリコ|きりこ}と{ここで|ここで}。";
  const expectedBody = "お父さん。取り戻す。\nキリコとここで。";
  const created = await page.request.post("/api/documents", {
    data: { title: "整词数据与汉字注音显示", kind: "article", orientation: "horizontal", content },
  });
  expect(created.status()).toBe(201);
  const initial = await created.json();
  await page.goto(`/#${initial.id}`);
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  const checkDisplay = async () => {
    await expect(article.locator("rt")).toHaveText(["とう", "と", "もど"]);
    expect(await article.locator("ruby").evaluateAll((items) => items.map((el) => el.firstChild.textContent)))
      .toEqual(["父", "取", "戻"]);
    await expect(article.locator(".text-line").nth(1).locator("ruby")).toHaveCount(0);
    const text = await article.locator(".text-line").evaluateAll((lines) => lines.map((line) => {
      const copy = line.cloneNode(true);
      copy.querySelectorAll("rt, rp").forEach((node) => node.remove());
      return copy.textContent;
    }).join("\n"));
    expect(text).toBe(expectedBody);
  };
  await checkDisplay();
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "日语正文", exact: true })).toHaveValue(expectedBody);
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const father = page.getByRole("textbox", { name: "お父さん的读音（第1行）", exact: true });
  await expect(father).toHaveValue("おとうさん");
  await expect(page.getByRole("textbox", { name: "取り戻す的读音（第1行）", exact: true })).toHaveValue("とりもどす");
  await expect(page.getByRole("textbox", { name: "キリコ的读音（第2行）", exact: true })).toHaveValue("きりこ");
  await expect(page.getByRole("textbox", { name: "ここで的读音（第2行）", exact: true })).toHaveValue("ここで");
  await father.fill("おとーさん");
  await father.fill("おとうさん");
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await page.reload();
  await checkDisplay();
  await page.screenshot({
    path: `artifacts/stage2-kanji-only-display-${info.project.name}.png`,
    fullPage: true,
  });
  const response = await page.request.get(`/api/documents/${initial.id}`);
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  expect(saved.content).toBe(content);
  expect(saved.blocks.map((block) => block.segments)).toEqual(initial.blocks.map((block) => block.segments));
  expect(saved.blocks.flatMap((block) => block.segments.filter((s) => s.reading).map((s) => [s.text, s.reading])))
    .toEqual([["お父さん", "おとうさん"], ["取り戻す", "とりもどす"], ["キリコ", "きりこ"], ["ここで", "ここで"]]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await deleteDocument(page, initial.id);
});

test("首页书案概览、当前阅读与最近阅读使用已保存书籍和材料并能正确打开", async ({ page }, info) => {
  const suffix = info.project.name;
  let documentId;
  let bookId;
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    const documentResponse = await page.request.post("/api/documents", {
      data: { title: `首页真实材料-${suffix}`, kind: "article", orientation: "horizontal", content: "午後に{本|ほん}を{読む|よむ}。" },
    });
    expect(documentResponse.status()).toBe(201);
    const document = await documentResponse.json();
    documentId = document.id;
    const bookResponse = await page.request.post("/api/books", { data: { title: `首页真实书籍-${suffix}` } });
    expect(bookResponse.status()).toBe(201);
    const book = await bookResponse.json();
    bookId = book.id;
    const pageResponse = await page.request.post("/api/documents", {
      data: { bookId, title: "首页书籍第一页", kind: "book", orientation: "horizontal", content: "これは{最初|さいしょ}のページです。" },
    });
    expect(pageResponse.status()).toBe(201);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await expect(page.getByRole("region", { name: "阅读首页", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "我的阅读资料", exact: true })).toBeVisible();
    const recent = page.getByRole("region", { name: "最近阅读", exact: true });
    await expect(recent).toBeVisible();
    await expect(recent.getByRole("button", { name: `打开书籍：${book.title}`, exact: true })).toBeVisible();
    await expect(recent.getByRole("button", { name: `继续阅读：${document.title}`, exact: true })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({
      path: `artifacts/design-2026-10-28/homepage-${suffix}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await recent.getByRole("button", { name: `打开书籍：${book.title}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: book.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(`#book/${bookId}`);
    await expect(page.getByLabel("书籍文章列表", { exact: true }).getByRole("listitem")).toHaveCount(1);
    await page.goto("/");
    await recent.getByRole("button", { name: `继续阅读：${document.title}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: document.title, exact: true })).toBeVisible();
    expect(await page.evaluate(() => location.hash)).toBe(`#${documentId}`);
    await expect(page.getByRole("article", { name: "日语原文", exact: true }).locator("rt")).toHaveText(["ほん", "よ"]);
    await expect(page.getByRole("navigation", { name: "文章导航", exact: true })).toHaveCount(0);
    await page.goto("/");
    if (await page.getByRole("button", { name: "打开书架", exact: true }).isVisible()) {
      await page.getByRole("button", { name: "打开书架", exact: true }).click();
    }
    await page.getByRole("button", { name: "新建书籍", exact: true }).click();
    await expect(page.getByRole("heading", { name: "新建书籍", exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "书籍名称", exact: true })).toBeVisible();
    expect(browserErrors).toEqual([]);
  } finally {
    if (documentId) await deleteDocument(page, documentId);
    if (bookId) {
      const response = await page.request.get(`/api/books/${bookId}`);
      if (response.ok()) {
        const book = await response.json();
        expect((await page.request.delete(`/api/books/${bookId}`, { data: { revision: book.revision } })).status()).toBe(204);
      }
    }
  }
});
