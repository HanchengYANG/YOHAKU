// UI integration only: actual uploads/Sharp/SQLite, explicit OAuth/model doubles.
// These checks are not evidence of real subscription authorization or OCR quality.
import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
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
const ocrText = "僕が生まれた日の空は\n\n背中を撫でる\n用語（原文）\nアキックス：「ここで食べる。」";
const ocrTypes = Array(5).fill("paragraph");

async function renderedText(locator) {
  return locator.locator(".text-line").evaluateAll((lines) =>
    lines.map((line) => {
      const copy = line.cloneNode(true);
      copy.querySelectorAll("rt, rp").forEach((node) => node.remove());
      return copy.textContent;
    }).join("\n"),
  );
}

async function getDocument(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}

async function importDraft(page) {
  await openImageImport(page);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const reply = page.waitForResponse((res) =>
    /\/api\/images\/[^/]+\/annotate$/.test(new URL(res.url()).pathname),
  );
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
  const response = await reply;
  expect(response.ok()).toBe(true);
  return response.json();
}

async function createImageDocument(page) {
  const draft = await importDraft(page);
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
  const document = await getDocument(page, await page.evaluate(() => location.hash.slice(1)));
  return { draft, document };
}

async function currentImage(page, id) {
  const metadata = await page.request.get(`/api/images/${id}`);
  expect(metadata.ok()).toBe(true);
  const raw = await page.request.get(`/api/images/${id}/raw`);
  expect(raw.ok()).toBe(true);
  const bytes = await raw.body();
  const pixels = await sharp(bytes).metadata();
  return { metadata: await metadata.json(), bytes, pixels };
}

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
  await expect(page.getByLabel("识别方式", { exact: true })).toHaveCount(0);
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

async function checkOriginalPreview(page, projectName) {
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
  const expectedReadings = ["ぼく", "う", "ひ", "くう", "せなか", "な", "た"];
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
    page.getByRole("button", { name: "识别并注音", exact: true }),
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
    await page.getByRole("button", { name: "识别并注音", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("上传暂时失败");
    await expect(
      page.getByAltText("待识别的日语原图", { exact: true }),
    ).toBeVisible();
    await expect(page.locator(".image-file-details > strong")).toHaveText(
      original.name,
    );
    await page.getByRole("button", { name: "识别并注音", exact: true }).click();
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
        name: "正在识别正文（1/2）…",
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

test("自动导入总计时等待正文注音和原图显示，不在模型返回时提前结束", async ({ page }) => {
  await page.goto("/");
  await enableTestAccount(page);
  let releaseImage;
  const gate = new Promise((resolve) => { releaseImage = resolve; });
  await page.route(/\/api\/images\/[^/]+\/raw(?:\?.*)?$/, async (route) => {
    await gate;
    await route.continue();
  });
  try {
    const result = await importDraft(page);
    expect(result.annotation).toBeTruthy();
    await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
    await expect(page.locator("[data-import-elapsed-ms]")).toHaveCount(0);
    await expect(page.locator("[data-annotation-elapsed-ms]")).toHaveCount(0);
    await expect(page.locator("[data-ocr-elapsed-ms]")).toHaveCount(0);
  } finally {
    releaseImage();
  }
  await expect(page.locator("[data-import-elapsed-ms]")).toBeVisible();
  await expect(page.locator("[data-import-elapsed-ms]")).toContainText("上传后识别与注音完成用时");
  await expect(page.locator("[data-annotation-elapsed-ms]")).toBeVisible();
});

test("一次点击先识别再自动注音，全部完成后进入校对页且忙时不能替换", async ({ page }) => {
  await enableTestAccount(page);
  await openImageImport(page);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  let annotationCount = 0;
  let releaseAnnotation;
  let recognitionCompleted = false;
  const gate = new Promise((resolve) => { releaseAnnotation = resolve; });
  const recognizedReply = page.waitForResponse((response) => /\/api\/images\/[^/]+\/recognize$/.test(new URL(response.url()).pathname));
  const annotationReply = page.waitForResponse((response) => /\/api\/images\/[^/]+\/annotate$/.test(new URL(response.url()).pathname));
  await page.route("**/api/images/*/recognize", async (route) => {
    expect(annotationCount).toBe(0);
    const response = await route.fetch();
    recognitionCompleted = true;
    await route.fulfill({ response });
  });
  await page.route("**/api/images/*/annotate", async (route) => {
    annotationCount++;
    expect(recognitionCompleted).toBe(true);
    const request = route.request().postDataJSON();
    expect(request.manualReadings).toEqual([]);
    expect(typeof request.content).toBe("string");
    await gate;
    await route.continue();
  });
  const observeRecognition = recognizedReply.then(async (response) => {
    expect(response.ok()).toBe(true);
    recognitionCompleted = true;
    return response.json();
  });
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
  const draft = await observeRecognition;
  expect(draft.reasoningEffort).toBe("low");
  expect(draft.processing.bodyFormat).toBe("text_only");
  expect(draft.blocks.flatMap((block) => block.segments).every((segment) => segment.reading === null && segment.origin === null)).toBe(true);
  try {
    await expect.poll(() => annotationCount).toBe(1);
    await expect(page.getByRole("region", { name: "图片导入", exact: true })).toHaveAttribute("aria-busy", "true");
    await expect(page.getByLabel("日语正文", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "取消", exact: true })).toBeDisabled();
    await expect(page.getByLabel("选择日语图片", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "点击选择或更换图片", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "正在参考原图注音（2/2）…", exact: true })).toBeDisabled();
    const bytes = [...(await readFile(imagePath))];
    await transferImages(page, "paste", [{ name: "注音时不应替换.png", type: "image/png", bytes }]);
    await expect(page.getByRole("alert")).toContainText("完成后再更换图片");
    await expect(page.locator(".image-file-details > strong")).toHaveText("01-lyrics-ruby.png");
  } finally {
    releaseAnnotation();
  }
  const response = await annotationReply;
  expect(response.ok()).toBe(true);
  const annotated = await response.json();
  expect(annotated.annotationReasoningEffort).toBe("low");
  expect(annotated.annotation.readingPolicy).toBe("image_reference");
  expect(annotated.annotation.imageReference).toEqual({ imageId: draft.sourceImageId, revision: draft.sourceImage.revision });
  const segments = annotated.blocks.flatMap((block) => block.segments);
  expect(segments.filter((segment) => segment.origin === "source")).toHaveLength(0);
  expect(segments.filter((segment) => segment.origin === "generated")).toHaveLength(7);
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toBeEnabled();
  const totalClock = page.locator("[data-import-elapsed-ms]");
  await expect(totalClock).toBeVisible();
  await expect(page.locator("[data-annotation-elapsed-ms]")).toBeVisible();
  await expect(page.locator("[data-ocr-elapsed-ms]")).toHaveCount(0);
  const elapsed = await totalClock.getAttribute("data-import-elapsed-ms");
  const annotationElapsed = await page.locator("[data-annotation-elapsed-ms]").getAttribute("data-annotation-elapsed-ms");
  expect(Number(elapsed)).toBeGreaterThanOrEqual(Number(annotationElapsed));
  expect(Number(annotationElapsed)).toBeGreaterThan(0);
  expect(annotationCount).toBe(1);
  await expect(page.getByRole("button", { name: "生成缺失注音", exact: true })).toHaveCount(0);
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  expect(await renderedText(preview)).toBe(ocrText);
  await expect(preview.locator('ruby[data-origin="generated"]')).toHaveCount(7);
  expect(await totalClock.getAttribute("data-import-elapsed-ms")).toBe(elapsed);
  expect(annotationCount).toBe(1);
});

test("自动注音失败保留正文，重试只重发注音不重复上传或识别", async ({ page }) => {
  await enableTestAccount(page);
  await openImageImport(page);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  let uploads = 0, recognitions = 0, annotations = 0;
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (request.method() !== "POST") return;
    if (pathname === "/api/images") uploads++;
    if (/\/recognize$/.test(pathname)) recognitions++;
  });
  await page.route("**/api/images/*/annotate", async (route) => {
    annotations++;
    if (annotations === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试故障：注音暂时失败。" }) });
    return route.continue();
  });
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("注音暂时失败");
  await expect(page.getByRole("alert")).toContainText("正文");
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "重试注音", exact: true })).toBeEnabled();
  expect([uploads, recognitions, annotations]).toEqual([1, 1, 1]);
  await page.getByRole("button", { name: "重试注音", exact: true }).click();
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.locator("[data-import-elapsed-ms]")).toBeVisible();
  expect([uploads, recognitions, annotations]).toEqual([1, 1, 2]);
});

test("自动注音失败可先校对正文，手动重试继续保留已完成结果", async ({ page }) => {
  await enableTestAccount(page);
  await openImageImport(page);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  let annotations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /\/annotate$/.test(new URL(request.url()).pathname)) annotations++;
  });
  await page.route("**/api/images/*/annotate", async (route) => {
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试故障：注音暂时失败。" }) });
  });
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("注音暂时失败");
  await page.getByRole("button", { name: "先校对正文", exact: true }).click();
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.getByRole("tab", { name: /注音校正/ })).toContainText("0");
  await expect(page.locator("[data-ocr-elapsed-ms]")).toBeVisible();
  await expect(page.locator("[data-import-elapsed-ms]")).toHaveCount(0);
  await page.unroute("**/api/images/*/annotate");
  const reply = page.waitForResponse((response) => /\/api\/images\/[^/]+\/annotate$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "生成缺失注音", exact: true }).click();
  expect((await reply).ok()).toBe(true);
  await expect(page.locator("[data-annotation-elapsed-ms]")).toBeVisible();
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.getByText("正文与注音已完成，请一起校对正文和读音后保存。", { exact: true })).toBeVisible();
  await expect(page.getByText(/正文已完成，注音尚未完成/)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "生成缺失注音", exact: true })).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(annotations).toBe(2);
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
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
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
  expect(imageUrl).toMatch(/^\/api\/images\/[a-f0-9-]+\/raw(?:\?revision=\d+)?$/);
  const rawPath = new URL(imageUrl, "http://127.0.0.1:4319").pathname;
  const raw = await page.request.get(imageUrl);
  expect(raw.ok()).toBe(true);
  expect(await raw.body()).toEqual(await readFile(imagePath));
  await expect(page.locator("details.ocr-nonbody-list")).toHaveCount(0);
  await page.screenshot({
    path: `artifacts/stage2-original-test-double-${info.project.name}.png`,
    fullPage: true,
    animations: "disabled",
  });
  await expect(page.locator("[data-import-elapsed-ms]")).toBeVisible();
  await expect(page.locator("[data-annotation-elapsed-ms]")).toBeVisible();
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator(".japanese-text")).toHaveCSS("writing-mode", "horizontal-tb");
  await expect(preview.locator("h2.text-heading")).toHaveCount(0);
  await expect(preview.locator("ul.ruby-text-list > li.text-line")).toHaveCount(0);
  expect(await renderedText(preview)).toBe(ocrText);
  await expect(preview.locator("rt")).toHaveText([
    "ぼく",
    "う",
    "ひ",
    "そら",
    "せなか",
    "な",
    "た",
  ]);
  await expect(preview.locator('ruby[data-origin="source"]')).toHaveCount(0);
  await expect(preview.locator('ruby[data-origin="generated"]')).toHaveCount(7);
  await expect(
    preview.locator("rt").filter({ hasText: "あきっくす" }),
  ).toHaveCount(0);
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const reading = page.getByRole("textbox", {
    name: "空的读音（第1行）",
    exact: true,
  });
  const row = page.locator(".ruby-edit-row").filter({ has: reading });
  await expect(row.getByText("AI 注音", { exact: true })).toBeVisible();
  await reading.fill("くう");
  await expect(row.getByText("手动", { exact: true })).toBeVisible();
  const sourceRow = page.locator(".ruby-edit-row").filter({
    has: page.getByRole("textbox", {
      name: "僕的读音（第1行）",
      exact: true,
    }),
  });
  await expect(sourceRow.getByText("AI 注音", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("textbox", {
      name: "アキックス的读音（第5行）",
      exact: true,
    }),
  ).toHaveCount(0);
  await expect(
    preview.locator('.ruby-word[title="生まれた：うまれた"]'),
  ).toHaveCount(1);
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
      name: "僕が生まれた日の空は",
      exact: true,
    }),
  ).toBeVisible();
  const documentId = await page.evaluate(() => location.hash.slice(1));
  const saved = await (
    await page.request.get(`/api/documents/${documentId}`)
  ).json();
  expect(saved.sourceImageId).toBeTruthy();
  expect(saved.orientation).toBe("horizontal");
  expect(saved.recognition.sourceOrientation).toBe("horizontal");
  expect(saved.recognition.orientation).toBe("horizontal");
  expect(saved.blocks.map((block) => block.type)).toEqual(ocrTypes);
  expect(saved.recognition.blocks.map((block) => block.type)).toEqual(ocrTypes);
  expect(saved.content).toContain("{空|くう}");
  expect(saved.blocks[0].segments.find((s) => s.text === "空").origin).toBe(
    "manual",
  );
  expect(saved.blocks[0].segments.find((s) => s.text === "僕").origin).toBe(
    "generated",
  );
  expect(saved.recognition.annotation.blocks[0].segments.find((s) => s.text === "生まれた")).toEqual({
    text: "生まれた",
    reading: "うまれた",
    origin: "generated",
  });
  expect(saved.recognition.annotation.blocks[2].segments.find((s) => s.text === "撫でる")).toEqual({
    text: "撫でる",
    reading: "なでる",
    origin: "generated",
  });
  expect(saved.blocks.flatMap((block) => block.segments).filter((segment) => segment.origin === "generated")).toHaveLength(6);
  expect(saved.recognition.blocks.flatMap((block) => block.segments).filter((segment) => segment.origin === "generated")).toHaveLength(0);
  expect(saved.recognition.nonBody).toEqual([]);
  expect(saved.recognition.readingPolicy).toBe("image_ocr_correction_only");
  expect(saved.recognition.blocks[4].segments.some((segment) =>
    segment.text.includes("アキックス") && segment.reading === null && segment.origin === null,
  )).toBe(true);
  expect(saved.content).not.toContain("{アキックス|");
  await page.reload();
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  await expect(article.locator("h2.text-heading")).toHaveCount(0);
  await expect(article.locator("ul.ruby-text-list > li.text-line")).toHaveCount(0);
  await expect(article.locator(".japanese-text")).toHaveCSS("writing-mode", "horizontal-tb");
  expect(await renderedText(article)).toBe(ocrText);
  await page.locator(".reader-recognition-details > summary").click();
  await expect(
    page.getByRole("link", { name: "查看完整原图", exact: true }),
  ).toHaveAttribute("href", rawPath);
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
  await expect(
    page.getByRole("textbox", { name: "生まれた的读音（第1行）", exact: true }),
  ).toHaveValue("うまれた");
  await expect(
    page
      .locator(".ruby-edit-row")
      .filter({
        has: page.getByRole("textbox", {
          name: "僕的读音（第1行）",
          exact: true,
        }),
      })
      .getByText("AI 注音", { exact: true }),
  ).toBeVisible();
  await checkOriginalPreview(page, info.project.name);
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
  const completeText = page.getByRole("group", { name: "完整原文中的批量注音位置", exact: true });
  await expect(completeText.locator("mark.ruby-occurrence.unavailable")).toHaveCount(1);
  await expect(completeText.locator("mark.ruby-occurrence.unavailable")).toHaveAttribute("aria-disabled", "true");
  await expect(completeText.locator("button.ruby-occurrence")).toHaveCount(0);
  await expect(completeText.locator("rt")).toHaveText(["た"]);
  await expect(batch).toContainText("完整");

  await query.fill("名字");
  await search.click();
  const occurrences = completeText.locator("button.ruby-occurrence");
  const selected = completeText.locator('button.ruby-occurrence[aria-pressed="true"]');
  await expect(occurrences).toHaveCount(4);
  await expect(batch.getByRole("checkbox")).toHaveCount(0);
  expect(await renderedText(completeText)).toBe(expectedBody);
  await expect(selected).toHaveCount(0);
  if (info.project.name === "phone") await occurrences.nth(0).tap();
  else await occurrences.nth(0).click();
  await expect(occurrences.nth(0)).toHaveAttribute("aria-pressed", "true");
  await expect(occurrences.nth(1)).toHaveAttribute("aria-pressed", "false");
  expect(await occurrences.nth(0).evaluate((el) => getComputedStyle(el).backgroundColor))
    .not.toBe(await occurrences.nth(1).evaluate((el) => getComputedStyle(el).backgroundColor));
  await occurrences.nth(1).focus();
  await occurrences.nth(1).press("Space");
  await expect(selected).toHaveCount(2);
  await occurrences.nth(1).press("Enter");
  await expect(selected).toHaveCount(1);
  await query.fill("名字 ");
  await expect(occurrences).toHaveCount(0);
  await search.click();
  await expect(selected).toHaveCount(0);
  await occurrences.nth(0).click();
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  const body = page.getByRole("textbox", { name: "日语正文", exact: true });
  await body.fill(`${expectedBody} `);
  await page.getByRole("tab", { name: "批量注音", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  await body.fill(expectedBody);
  await page.getByRole("tab", { name: "批量注音", exact: true }).click();
  await batch
    .getByRole("button", { name: "全选可修改的位置", exact: true })
    .click();
  await expect(selected).toHaveCount(4);
  await batch.getByRole("button", { name: "取消全选", exact: true }).click();
  await expect(selected).toHaveCount(0);
  await batch
    .getByRole("button", { name: "全选可修改的位置", exact: true })
    .click();
  const reading = batch.getByRole("textbox", {
    name: "批量假名读音",
    exact: true,
  });
  await reading.fill("みょうじ");
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  await expect(preview.locator("rt")).toHaveText(["た"]);
  await batch
    .getByRole("button", { name: "应用到选中的 4 处", exact: true })
    .click();
  await expect(preview.locator("rt")).toHaveText([
    "た",
    "みょうじ",
    "みょうじ",
    "みょうじ",
    "みょうじ",
  ]);
  await expect(selected).toHaveCount(0);
  await occurrences.nth(1).click();
  await occurrences.nth(3).click();
  await reading.fill("ミンツー");
  await batch
    .getByRole("button", { name: "应用到选中的 2 处", exact: true })
    .click();
  const expectedReadings = [
    "た",
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
  const nameReadings = page.getByRole("textbox", { name: /^名字的读音/ });
  await nameReadings.nth(0).focus();
  const active = page.locator("mark.ruby-active-occurrence");
  await expect(active).toHaveCount(1);
  await expect(page.locator('.ruby-edit-row[data-active="true"]')).toHaveCount(1);
  await expect(active.locator("xpath=..")).toContainText("一人目の");
  await nameReadings.nth(2).focus();
  await expect(active).toHaveCount(1);
  await expect(active.locator("xpath=..")).toContainText("三人目の");
  await expect(page.locator('.ruby-edit-row[data-active="true"] input')).toHaveAttribute("aria-label", "名字的读音（第4行）");
  await page.getByRole("button", {
    name: "移除名字的注音（第4行）", exact: true,
  }).click();
  await expect(active).toHaveCount(0);
  await expect(page.locator('.ruby-edit-row[data-active="true"]')).toHaveCount(0);
  expect(await renderedText(page.getByRole("region", { name: "阅读预览", exact: true }))).toBe(expectedBody);
  page.once("dialog", async (dialog) => {
    expect(dialog.type()).toBe("confirm");
    await dialog.accept();
  });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(page.getByRole("article", { name: "日语原文", exact: true }).locator("rt")).toHaveText(expectedReadings);
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

test("长文末尾注音定位只滚动预览内部，输入焦点与全文保持", async ({ page }, info) => {
  const lines = Array.from({ length: 60 }, (_, index) =>
    `第${index + 1}段の{名字|みょうじ}は、この段落で確認する。`,
  );
  const content = ["冒頭の記録。", ...lines, "末尾の記録。"].join("\n");
  const expectedBody = content.replaceAll("{名字|みょうじ}", "名字");
  const response = await page.request.post("/api/documents", {
    data: { title: "長文の逐处联动测试", kind: "article", orientation: "horizontal", content },
  });
  expect(response.status()).toBe(201);
  const document = await response.json();
  await page.goto(`/#${document.id}`);
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  await page.getByRole("tab", { name: /注音校正/ }).click();
  expect(await page.locator(".ruby-editor").evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  const reading = page.getByRole("textbox", { name: "名字的读音（第61行）", exact: true });
  // Bring the last control into view before focus triggers preview positioning.
  // A subsequent document-level jump would move this visible input away.
  await reading.scrollIntoViewIfNeeded();
  const pageBeforeFocus = await page.evaluate(() => window.scrollY);
  await reading.focus();
  await expect.poll(() => page.locator(".ruby-editor").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const mark = page.locator("mark.ruby-active-occurrence");
  await expect(mark).toHaveCount(1);
  const pane = page.locator(".preview-content");
  await expect.poll(() => pane.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  const geometry = await pane.evaluate((el) => {
    const box = el.getBoundingClientRect();
    const active = el.querySelector("mark.ruby-active-occurrence").getBoundingClientRect();
    return {
      overflow: el.scrollHeight > el.clientHeight,
      top: box.top + el.clientTop,
      bottom: box.top + el.clientTop + el.clientHeight,
      markTop: active.top,
      markBottom: active.bottom,
    };
  });
  expect(geometry.overflow).toBe(true);
  expect(geometry.markTop).toBeGreaterThanOrEqual(geometry.top - 1);
  expect(geometry.markBottom).toBeLessThanOrEqual(geometry.bottom + 1);
  await expect(reading).toBeFocused();
  const inputBounds = await reading.boundingBox();
  expect(inputBounds.y).toBeGreaterThanOrEqual(0);
  expect(inputBounds.y + inputBounds.height).toBeLessThanOrEqual(page.viewportSize().height);
  expect(Math.abs(await page.evaluate(() => window.scrollY) - pageBeforeFocus)).toBeLessThanOrEqual(2);
  await expect(mark.locator("xpath=..")).toContainText("第60段の");
  if (info.project.name === "desktop") {
    const columns = await page.locator(".editor-workspace").evaluate((el) => {
      const source = el.querySelector(".source-panel").getBoundingClientRect();
      const preview = el.querySelector(".preview-panel").getBoundingClientRect();
      return { sourceRight: source.right, previewLeft: preview.left, sourceTop: source.top, previewTop: preview.top };
    });
    expect(columns.sourceRight).toBeLessThanOrEqual(columns.previewLeft + 1);
    expect(Math.abs(columns.sourceTop - columns.previewTop)).toBeLessThan(2);
    expect(geometry.markTop).toBeGreaterThanOrEqual(0);
    expect(geometry.markBottom).toBeLessThanOrEqual(page.viewportSize().height);
  }
  const pageBeforeTyping = await page.evaluate(() => window.scrollY);
  await reading.press("End");
  await reading.pressSequentially("ー");
  await expect(reading).toHaveValue("みょうじー");
  await expect(reading).toBeFocused();
  await expect(mark).toHaveCount(1);
  expect(Math.abs(await page.evaluate(() => window.scrollY) - pageBeforeTyping)).toBeLessThanOrEqual(2);
  const afterTyping = await reading.boundingBox();
  expect(Math.abs(afterTyping.y - inputBounds.y)).toBeLessThanOrEqual(2);
  expect(await renderedText(pane)).toBe(expectedBody);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  await expect(article).toBeVisible();
  expect(await renderedText(article)).toBe(expectedBody);
  expect((await page.request.delete(`/api/documents/${document.id}`, {
    data: { revision: document.revision },
  })).status()).toBe(204);
});

test("显式保存图片方向更新真实像素，失败可重试且不丢正文", async ({ page }) => {
  await enableTestAccount(page);
  const { document } = await createImageDocument(page);
  const imageId = document.sourceImageId;
  const before = await currentImage(page, imageId);
  const fixtureBytes = await readFile(imagePath);
  expect(before.bytes).toEqual(fixtureBytes);
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  const body = page.getByRole("textbox", { name: "日语正文", exact: true });
  const edited = `${ocrText}\n追記は残す。`;
  await body.fill(edited);
  const rotate = page.getByRole("button", { name: "向左旋转90°", exact: true });
  await expect(rotate).toBeEnabled();
  await rotate.click();
  const image = page.getByAltText("用于校对正文和注音的日语原图", { exact: true });
  await expect.poll(() => image.evaluate((el) => {
    const box = el.getBoundingClientRect();
    return box.width / box.height;
  })).toBeCloseTo(before.pixels.height / before.pixels.width, 2);
  const rotatePath = `/api/images/${imageId}/rotate`;
  // Explicit HTTP fault injection, unrelated to real model availability.
  const failRotation = (route) => route.fulfill({
    status: 503,
    contentType: "application/json",
    body: JSON.stringify({ error: "测试故障：图片方向保存暂时失败。" }),
  });
  await page.route(`**${rotatePath}`, failRotation);
  await page.getByRole("button", { name: "保存图片方向", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("图片方向保存暂时失败");
  await expect(body).toHaveValue(edited);
  await expect(page.getByRole("status").filter({ hasText: "图片方向尚未保存" })).toBeVisible();
  const failed = await currentImage(page, imageId);
  expect(failed.metadata.revision).toBe(before.metadata.revision);
  expect(failed.bytes).toEqual(before.bytes);
  await page.unroute(`**${rotatePath}`, failRotation);

  const rotatedReply = page.waitForResponse((res) =>
    new URL(res.url()).pathname === rotatePath && res.request().method() === "POST",
  );
  await page.getByRole("button", { name: "保存图片方向", exact: true }).click();
  const rotated = await rotatedReply;
  expect(rotated.status()).toBe(200);
  expect(rotated.request().postDataJSON()).toEqual({
    quarterTurns: 3, revision: before.metadata.revision,
  });
  const after = await currentImage(page, imageId);
  expect(after.metadata.id).toBe(imageId);
  expect(after.metadata.revision).toBe(before.metadata.revision + 1);
  expect([after.pixels.width, after.pixels.height]).toEqual([before.pixels.height, before.pixels.width]);
  expect([after.metadata.width, after.metadata.height]).toEqual([after.pixels.width, after.pixels.height]);
  expect(after.bytes).not.toEqual(before.bytes);
  await expect.poll(() => image.evaluate((el) => [el.naturalWidth, el.naturalHeight])).toEqual([
    before.pixels.height, before.pixels.width,
  ]);
  await expect(body).toHaveValue(edited);
  expect((await getDocument(page, document.id)).revision).toBe(document.revision);
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await page.reload();
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  await expect(article).toBeVisible();
  expect(await renderedText(article)).toBe(edited);
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  await expect.poll(() => image.evaluate((el) => [el.naturalWidth, el.naturalHeight])).toEqual([
    before.pixels.height, before.pixels.width,
  ]);
  await expect(page.getByRole("button", { name: "保存图片方向", exact: true })).toBeDisabled();
  const matrix = await image.evaluate((el) => {
    const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
    return [m.a, m.b, m.c, m.d];
  });
  expect(matrix).toEqual([1, 0, 0, 1]);
  expect(await readFile(imagePath)).toEqual(fixtureBytes);
  const saved = await getDocument(page, document.id);
  expect((await page.request.delete(`/api/documents/${document.id}`, {
    data: { revision: saved.revision },
  })).status()).toBe(204);
});

test("图片方向冲突重载保留正文，保存并阅读先旋转后持久正文", async ({ page }) => {
  await enableTestAccount(page);
  const { document } = await createImageDocument(page);
  const imageId = document.sourceImageId;
  const before = await currentImage(page, imageId);
  await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
  const body = page.getByRole("textbox", { name: "日语正文", exact: true });
  const edited = `${ocrText}\n衝突しても本文を残す。`;
  await body.fill(edited);
  const rotate = page.getByRole("button", { name: "向左旋转90°", exact: true });
  await expect(rotate).toBeEnabled();
  await rotate.click();
  // Another real API operation changes the file/version while this editor has
  // the old revision; the following 409 is produced by the production server.
  const changedElsewhere = await page.request.post(`/api/images/${imageId}/rotate`, {
    data: { quarterTurns: 1, revision: before.metadata.revision },
  });
  expect(changedElsewhere.status()).toBe(200);
  const external = await changedElsewhere.json();
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("其他页面修改");
  await expect(body).toHaveValue(edited);
  expect((await getDocument(page, document.id)).revision).toBe(document.revision);
  await page.getByRole("button", { name: "重新载入当前图片", exact: true }).click();
  await expect(body).toHaveValue(edited);
  const image = page.getByAltText("用于校对正文和注音的日语原图", { exact: true });
  await expect.poll(() => image.evaluate((el) => [el.naturalWidth, el.naturalHeight])).toEqual([
    before.pixels.height, before.pixels.width,
  ]);
  await expect(page.getByRole("button", { name: "保存图片方向", exact: true })).toBeDisabled();
  expect((await currentImage(page, imageId)).metadata.revision).toBe(external.revision);
  await rotate.click();
  const mutations = [];
  page.on("request", (request) => {
    const path = new URL(request.url()).pathname;
    if (request.method() === "POST" && path === `/api/images/${imageId}/rotate`)
      mutations.push({ kind: "rotate", data: request.postDataJSON() });
    if (request.method() === "PUT" && path === `/api/documents/${document.id}`)
      mutations.push({ kind: "document" });
  });
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  await expect(article).toBeVisible();
  expect(mutations).toEqual([
    { kind: "rotate", data: { quarterTurns: 3, revision: external.revision } },
    { kind: "document" },
  ]);
  const after = await currentImage(page, imageId);
  expect(after.metadata.revision).toBe(before.metadata.revision + 2);
  expect([after.pixels.width, after.pixels.height]).toEqual([before.pixels.width, before.pixels.height]);
  const saved = await getDocument(page, document.id);
  expect(saved.revision).toBe(document.revision + 1);
  expect(saved.blocks.map((b) => b.segments.map((s) => s.text).join("")).join("\n")).toBe(edited);
  expect(saved.blocks.slice(0, ocrTypes.length).map((b) => b.type)).toEqual(ocrTypes);
  await page.reload();
  await expect(article).toBeVisible();
  expect(await renderedText(article)).toBe(edited);
  expect((await page.request.delete(`/api/documents/${document.id}`, {
    data: { revision: saved.revision },
  })).status()).toBe(204);
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
