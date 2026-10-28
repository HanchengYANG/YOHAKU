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
  // OAuth return may finish navigation before React has loaded the website
  // session. Wait for the workspace before deciding whether its drawer exists.
  await expect(page.locator(".topbar")).toBeVisible();
  if (
    await page
      .getByRole("region", { name: "AI 授权设置", exact: true })
      .isVisible()
  )
    return;
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

async function openImageImport(page) {
  await page.goto("/");
  await page
    .getByRole("main")
    .getByRole("button", { name: "导入图片", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "导入照片或截图", exact: true }),
  ).toBeVisible();
}

async function transferImages(page, action, files) {
  // Synthetic browser events exercise clipboardData/DataTransfer without reading
  // or changing the operating system clipboard or another Chrome session.
  return page.evaluate(
    ({ action, files }) => {
      const data = new DataTransfer();
      for (const item of files)
        data.items.add(
          new File(
            [
              item.bytes
                ? new Uint8Array(item.bytes)
                : new Uint8Array(item.size || 0),
            ],
            item.name,
            { type: item.type },
          ),
        );
      const event =
        action === "paste"
          ? new ClipboardEvent("paste", {
              clipboardData: data,
              bubbles: true,
              cancelable: true,
            })
          : new DragEvent("drop", {
              dataTransfer: data,
              bubbles: true,
              cancelable: true,
            });
      const target =
        action === "paste"
          ? window
          : document.querySelector(".image-import-preview");
      target.dispatchEvent(event);
      return event.defaultPrevented;
    },
    { action, files },
  );
}

async function checkOriginalPreview(page, saved, projectName) {
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  const body = page.getByRole("textbox", { name: "日语正文", exact: true });
  const originalBody = await body.inputValue();
  const image = page.getByAltText("用于校对正文和注音的日语原图", {
    exact: true,
  });
  const rotate = page.getByRole("button", { name: "向左旋转90°", exact: true });
  const zoom = page.getByRole("combobox", { name: "原图缩放", exact: true });
  await expect
    .poll(() => image.evaluate((el) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  await expect(zoom).toHaveValue("100");
  const dimensions = () =>
    image.evaluate((el) => {
      const rect = el.getBoundingClientRect();
      const frame = el.closest(".ocr-image-frame").getBoundingClientRect();
      return {
        width: rect.width,
        height: rect.height,
        naturalWidth: el.naturalWidth,
        naturalHeight: el.naturalHeight,
        frameWidth: frame.width,
        frameHeight: frame.height,
        frameLeft: frame.left,
        frameTop: frame.top,
        left: rect.left,
        top: rect.top,
      };
    });
  const initial = await dimensions();
  expect(initial.naturalWidth).not.toBe(initial.naturalHeight);
  expect(initial.width / initial.height).toBeCloseTo(
    initial.naturalWidth / initial.naturalHeight,
    2,
  );
  await rotate.click();
  // Compare physical browser rectangles to independent natural dimensions, not
  // merely the authored transform string or an implementation state counter.
  await expect
    .poll(async () => {
      const current = await dimensions();
      return Math.abs(
        current.width / current.height -
          initial.naturalHeight / initial.naturalWidth,
      );
    })
    .toBeLessThan(0.01);
  const quarterTurn = await dimensions();
  expect(Math.abs(quarterTurn.frameWidth - quarterTurn.width)).toBeLessThan(2);
  expect(Math.abs(quarterTurn.frameHeight - quarterTurn.height)).toBeLessThan(
    2,
  );
  expect(Math.abs(quarterTurn.frameLeft - quarterTurn.left)).toBeLessThan(2);
  expect(Math.abs(quarterTurn.frameTop - quarterTurn.top)).toBeLessThan(2);
  await zoom.selectOption("200");
  await expect
    .poll(async () => (await dimensions()).width / quarterTurn.width)
    .toBeGreaterThan(1.8);
  const enlarged = await dimensions();
  expect(enlarged.width / quarterTurn.width).toBeLessThan(2.2);
  expect(enlarged.height / quarterTurn.height).toBeGreaterThan(1.8);
  const scrolling = await page.locator(".ocr-original-image").evaluate((el) => {
    const bounds = {
      horizontal: el.scrollWidth > el.clientWidth,
      vertical: el.scrollHeight > el.clientHeight,
    };
    el.scrollLeft = el.scrollWidth;
    el.scrollTop = el.scrollHeight;
    const result = { ...bounds, left: el.scrollLeft, top: el.scrollTop };
    el.scrollLeft = 0;
    el.scrollTop = 0;
    return result;
  });
  expect(scrolling.horizontal).toBe(true);
  expect(scrolling.vertical).toBe(true);
  expect(scrolling.left).toBeGreaterThan(0);
  expect(scrolling.top).toBeGreaterThan(0);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: `artifacts/stage2-rotated-zoomed-test-double-${projectName}.png`,
    fullPage: true,
    animations: "disabled",
  });
  for (let turn = 0; turn < 3; turn++) await rotate.click();
  await expect
    .poll(async () => {
      const current = await dimensions();
      return Math.abs(
        current.width / current.height -
          initial.naturalWidth / initial.naturalHeight,
      );
    })
    .toBeLessThan(0.01);
  // A half turn has the same bounding ratio. Check the browser's actual matrix
  // as well, to distinguish four quarter turns from an upside-down image.
  const matrix = await image.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return { a: m.a, b: m.b, c: m.c, d: m.d };
  });
  expect(matrix.a).toBeCloseTo(1, 3);
  expect(matrix.b).toBeCloseTo(0, 3);
  expect(matrix.c).toBeCloseTo(0, 3);
  expect(matrix.d).toBeCloseTo(1, 3);
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const expectedReadings = saved.blocks.flatMap((block) =>
    block.segments.filter((s) => s.reading).map((s) => s.reading),
  );
  await expect(
    page.getByRole("region", { name: "阅读预览", exact: true }).locator("rt"),
  ).toHaveText(expectedReadings);
  await expect(body).toHaveValue(originalBody);
}

test("图片入口支持截图粘贴、拖放及键盘选图，拒绝无效或多张图片", async ({
  page,
}, info) => {
  await openImageImport(page);
  const bytes = [...(await readFile(imagePath))];
  const clipboardImage = { name: "粘贴的截图.png", type: "image/png", bytes };
  expect(await transferImages(page, "paste", [clipboardImage])).toBe(true);
  const preview = page.getByAltText("待识别的日语原图", { exact: true });
  await expect
    .poll(() => preview.evaluate((el) => el.complete && el.naturalWidth > 0))
    .toBe(true);
  await expect(page.locator(".image-file-details > strong")).toHaveText(
    clipboardImage.name,
  );
  const previewUrl = await preview.getAttribute("src");

  await transferImages(page, "paste", [
    { name: "不支持.gif", type: "image/gif", bytes: [71, 73, 70] },
  ]);
  await expect(page.getByRole("alert")).toContainText("PNG、JPEG 或 WebP");
  await expect(preview).toHaveAttribute("src", previewUrl);
  await transferImages(page, "drop", [
    clipboardImage,
    { ...clipboardImage, name: "第二张.png" },
  ]);
  await expect(page.getByRole("alert")).toContainText("一次只支持一张图片");
  await expect(page.locator(".image-file-details > strong")).toHaveText(
    clipboardImage.name,
  );
  await transferImages(page, "paste", [
    { name: "太大.png", type: "image/png", size: 12 * 1024 * 1024 + 1 },
  ]);
  await expect(page.getByRole("alert")).toContainText("大小不超过 12 MB");
  await expect(preview).toHaveAttribute("src", previewUrl);

  expect(
    await transferImages(page, "drop", [
      { ...clipboardImage, name: "拖入的截图.png" },
    ]),
  ).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".image-file-details > strong")).toHaveText(
    "拖入的截图.png",
  );
  const chooserReady = page.waitForEvent("filechooser");
  const picker = page.getByRole("button", {
    name: "点击选择或更换图片",
    exact: true,
  });
  await picker.focus();
  await picker.press("Enter");
  const chooser = await chooserReady;
  await chooser.setFiles(imagePath);
  await expect(page.locator(".image-file-details > strong")).toHaveText(
    "01-lyrics-ruby.png",
  );
  await expect(
    page.getByRole("button", { name: "识别图片", exact: true }),
  ).toBeEnabled();
  await page.screenshot({
    path: `artifacts/stage2-image-input-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
});

test("上传和识别失败可保留图片重试，忙时不能替换且识别重试不重复上传", async ({
  page,
}) => {
  await enableTestAccount(page);
  await openImageImport(page);
  const bytes = [...(await readFile(imagePath))];
  const original = { name: "需要重试的截图.png", type: "image/png", bytes };
  await transferImages(page, "paste", [original]);
  let uploadCount = 0,
    recognitionCount = 0,
    releaseUpload,
    releaseRecognition;
  const uploadGate = new Promise((resolve) => {
    releaseUpload = resolve;
  });
  const recognitionGate = new Promise((resolve) => {
    releaseRecognition = resolve;
  });
  await page.route("**/api/images", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    uploadCount++;
    if (uploadCount === 1)
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "测试故障：上传暂时失败。" }),
      });
    await uploadGate;
    await route.continue();
  });
  await page.route("**/api/images/*/recognize", async (route) => {
    recognitionCount++;
    if (recognitionCount === 1) {
      await recognitionGate;
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "测试故障：识别暂时失败。" }),
      });
    }
    await route.continue();
  });
  try {
    await page.getByRole("button", { name: "识别图片", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("上传暂时失败");
    await expect(
      page.getByAltText("待识别的日语原图", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".image-file-details > strong")).toHaveText(
      original.name,
    );
    await page.getByRole("button", { name: "识别图片", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "正在上传原图…", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "点击选择或更换图片", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel("选择日语图片", { exact: true }),
    ).toBeDisabled();
    await transferImages(page, "paste", [
      { ...original, name: "忙时不应替换.png" },
    ]);
    await expect(page.getByRole("alert")).toContainText("完成后再更换图片");
    await expect(page.locator(".image-file-details > strong")).toHaveText(
      original.name,
    );
    releaseUpload();
    await expect(
      page.getByRole("button", {
        name: "正在识别正文并生成注音…",
        exact: true,
      }),
    ).toBeDisabled();
    await transferImages(page, "drop", [
      { ...original, name: "识别时也不应替换.png" },
    ]);
    await expect(page.locator(".image-file-details > strong")).toHaveText(
      original.name,
    );
    releaseRecognition();
    await expect(page.getByRole("alert")).toContainText("识别暂时失败");
    await expect(
      page.getByRole("button", { name: "重试识别", exact: true }),
    ).toBeEnabled();
    await page.getByRole("button", { name: "重试识别", exact: true }).click();
    await expect(
      page.getByRole("region", { name: "原图对照", exact: true }),
    ).toBeVisible();
    expect(uploadCount).toBe(2); // One failed upload, one successful upload; no third upload for OCR retry.
    expect(recognitionCount).toBe(2);
  } finally {
    releaseUpload();
    releaseRecognition();
  }
});

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
  const nonBody = page.locator("details.ocr-nonbody-list");
  await expect(nonBody).toHaveJSProperty("open", false);
  await nonBody.locator(":scope > summary").click();
  await expect(
    page.getByText("测试替身：绿色手写批注", { exact: true }),
  ).toBeVisible();
  await nonBody.locator(":scope > summary").click();
  await page.screenshot({
    path: `artifacts/stage2-original-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator("rt")).toContainText([
    "ぼく",
    "うまれた",
    "ひ",
    "そら",
    "せなか",
    "なでる",
  ]);
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const reading = page.getByRole("textbox", {
    name: "空的读音（第1行）",
    exact: true,
  });
  const row = page.locator(".ruby-edit-row").filter({ has: reading });
  await expect(row.getByText("AI 注音", { exact: true })).toBeVisible();
  await reading.fill("くう");
  await expect(row.getByText("手动", { exact: true })).toBeVisible();
  const generatedRow = page.locator(".ruby-edit-row").filter({
    has: page.getByRole("textbox", {
      name: "僕的读音（第1行）",
      exact: true,
    }),
  });
  await expect(
    generatedRow.getByText("AI 注音", { exact: true }),
  ).toBeVisible();
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
    "generated",
  );
  expect(saved.blocks[0].segments.find((s) => s.text === "生まれた")).toEqual({
    text: "生まれた",
    reading: "うまれた",
    origin: "generated",
  });
  expect(saved.blocks[2].segments.find((s) => s.text === "撫でる")).toEqual({
    text: "撫でる",
    reading: "なでる",
    origin: "generated",
  });
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
  await checkOriginalPreview(page, saved, info.project.name);
  let previewDialogs = 0;
  const unexpectedDialog = async (dialog) => {
    previewDialogs++;
    await dialog.dismiss();
  };
  page.on("dialog", unexpectedDialog);
  try {
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(
      page.getByRole("article", { name: "日语原文", exact: true }),
    ).toBeVisible();
    expect(previewDialogs).toBe(0);
  } finally {
    page.off("dialog", unexpectedDialog);
  }
  const afterPreview = await (
    await page.request.get(`/api/documents/${documentId}`)
  ).json();
  expect(afterPreview).toEqual(saved);
  expect(await (await page.request.get(imageUrl)).body()).toEqual(
    await readFile(imagePath),
  );
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

test("批量注音只修改明确选中的词语位置，保存后保留各自读音", async ({
  page,
}, info) => {
  const content =
    "ここで{食べる|たべる}。\n一人目の名字を読む。\n二人目の名字を読む。\n三人目の名字を読む。\n四人目の名字を読む。";
  const expectedBody =
    "ここで食べる。\n一人目の名字を読む。\n二人目の名字を読む。\n三人目の名字を読む。\n四人目の名字を読む。";
  const created = await page.request.post("/api/documents", {
    data: {
      title: "逐处选择的批量注音测试",
      kind: "article",
      orientation: "horizontal",
      content,
    },
  });
  expect(created.status()).toBe(201);
  const initial = await created.json();
  await page.goto(`/#${initial.id}`);
  await page
    .getByRole("button", { name: "校对文字与注音", exact: true })
    .click();
  await page.getByRole("tab", { name: "批量注音", exact: true }).click();
  const batch = page.getByRole("tabpanel", { name: "批量注音", exact: true });
  const query = batch.getByRole("textbox", {
    name: "要标注的词语",
    exact: true,
  });
  const search = batch.getByRole("button", { name: "查找位置", exact: true });
  await query.fill("食");
  await search.click();
  await expect(batch.getByRole("checkbox")).toHaveCount(1);
  await expect(batch.getByRole("checkbox")).toBeDisabled();
  await expect(batch).toContainText("完整");

  await query.fill("名字");
  await search.click();
  const occurrences = batch.getByRole("checkbox");
  await expect(occurrences).toHaveCount(4);
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await occurrences.nth(0).check();
  await query.fill("名字 ");
  await expect(occurrences).toHaveCount(0);
  await search.click();
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await occurrences.nth(0).check();
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  const body = page.getByRole("textbox", { name: "日语正文", exact: true });
  await body.fill(`${expectedBody} `);
  await page.getByRole("tab", { name: "批量注音", exact: true }).click();
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  await body.fill(expectedBody);
  await page.getByRole("tab", { name: "批量注音", exact: true }).click();
  await batch
    .getByRole("button", { name: "全选可修改的位置", exact: true })
    .click();
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(4);
  await batch.getByRole("button", { name: "取消全选", exact: true }).click();
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await batch
    .getByRole("button", { name: "全选可修改的位置", exact: true })
    .click();
  const reading = batch.getByRole("textbox", {
    name: "批量假名读音",
    exact: true,
  });
  await reading.fill("みょうじ");
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator("rt")).toHaveText(["たべる"]);
  await batch
    .getByRole("button", { name: "应用到选中的 4 处", exact: true })
    .click();
  await expect(preview.locator("rt")).toHaveText([
    "たべる",
    "みょうじ",
    "みょうじ",
    "みょうじ",
    "みょうじ",
  ]);
  await expect(batch.locator('input[type="checkbox"]:checked')).toHaveCount(0);
  await occurrences.nth(1).check();
  await occurrences.nth(3).check();
  await reading.fill("ミンツー");
  await batch
    .getByRole("button", { name: "应用到选中的 2 处", exact: true })
    .click();
  const expectedReadings = [
    "たべる",
    "みょうじ",
    "ミンツー",
    "みょうじ",
    "ミンツー",
  ];
  await expect(preview.locator("rt")).toHaveText(expectedReadings);
  await page.screenshot({
    path: `artifacts/stage2-batch-reading-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await page.reload();
  await expect(
    page.getByRole("article", { name: "日语原文", exact: true }).locator("rt"),
  ).toHaveText(expectedReadings);
  const saved = await (
    await page.request.get(`/api/documents/${initial.id}`)
  ).json();
  expect(
    saved.blocks.map((b) => b.segments.map((s) => s.text).join("")).join("\n"),
  ).toBe(expectedBody);
  expect(saved.blocks[0].segments.find((s) => s.text === "食べる")).toEqual(
    initial.blocks[0].segments.find((s) => s.text === "食べる"),
  );
  const names = saved.blocks.flatMap((b) =>
    b.segments.filter((s) => s.text === "名字"),
  );
  expect(names.map((s) => s.reading)).toEqual(expectedReadings.slice(1));
  expect(names.map((s) => s.origin)).toEqual([
    "manual",
    "manual",
    "manual",
    "manual",
  ]);
  await page
    .getByRole("button", { name: "校对文字与注音", exact: true })
    .click();
  await page.getByRole("tab", { name: /注音校正/ }).click();
  await expect(
    page
      .locator(".ruby-edit-row")
      .filter({ has: page.getByRole("textbox", { name: /^名字的读音/ }) }),
  ).toHaveCount(4);
  await expect(page.locator(".ruby-edit-row .ruby-origin.manual")).toHaveCount(
    5,
  );
  await page.getByRole("button", { name: "取消", exact: true }).click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    (
      await page.request.delete(`/api/documents/${initial.id}`, {
        data: { revision: saved.revision },
      })
    ).status(),
  ).toBe(204);
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
