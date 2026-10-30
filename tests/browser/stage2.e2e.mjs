// UI integration only: actual uploads/Sharp/SQLite, explicit OAuth/model doubles.
// These checks are not evidence of real subscription authorization or OCR quality.
import { test, expect } from "@playwright/test";
import { readFile, writeFile, rename, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { ensureOwnerSession, testOwner } from "./session.mjs";
import { discardFixtureTasks } from "./image-task-fixture.mjs";
import { selectArticleText, selectionFor } from "./article-selection.mjs";
import { bodyText, hasCompleteSentenceBoundaries } from "../../shared/article-html.mjs";

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

async function discussionInput(page, id, quote, question) {
  let document = await getDocument(page, id);
  const segmented = await page.request.post(`/api/documents/${id}/sentences`, {data:{revision:document.revision,bodyHash:document.bodyHash}});
  expect(segmented.ok()).toBe(true);
  document = await getDocument(page, id);
  return {selection:selectionFor(document,quote),question};
}

const runtimeControlsPath = new URL("../../artifacts/ai-e2e-data/image-runtime-controls.json", import.meta.url);
const runtimeCallsPath = new URL("../../artifacts/ai-e2e-data/runtime-calls.json", import.meta.url);
const activeTasks = new Set();
const setImageControls = async (controls = {}) => {
  const temporary = new URL("./image-runtime-controls.stage2.tmp", runtimeControlsPath);
  await writeFile(temporary, JSON.stringify(controls));
  await rename(temporary, runtimeControlsPath);
};
async function runtimeCalls(after = 0) {
  try { return JSON.parse(await readFile(runtimeCallsPath, "utf8")).filter((call) => call.sequence > after); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
}
async function runtimeCursor() { return (await runtimeCalls()).at(-1)?.sequence || 0; }
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
async function importDraft(page, filePath = imagePath) {
  await openImageImport(page);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(filePath);
  const id = await submitImageTask(page);
  await waitTask(page, id);
  return openTaskResult(page, id);
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

async function openEditorDetails(page, selector) {
  await expect(page.locator(".editor-page")).toBeVisible();
  const details = page.locator(selector);
  if (await details.count() && !(await details.evaluate((element) => element.open)))
    await details.locator(":scope > summary").click();
}

const uploadQueue = (page) => page.getByRole("region", { name: "照片队列", exact: true });
const uploadCards = (queue) => queue.locator(".source-sort-card[data-sort-image-id]");
const uploadNames = (queue) => uploadCards(queue).locator(".source-sort-card-label small");
const queueIds = (queue) => uploadCards(queue).evaluateAll((cards) => cards.map((card) => card.dataset.sortImageId));

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
  await expect(page.locator(".main-panel")).toBeVisible();
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
    page.getByRole("heading", { name: "配置网站共享 AI", exact: true }),
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

async function openImageImport(page) {
  await page.goto("/");
  await expect(page.locator(".main-panel")).toBeVisible();
  if (
    await page
      .getByRole("button", { name: "打开书架", exact: true })
      .isVisible()
  ) {
    await page.getByRole("button", { name: "打开书架", exact: true }).click();
  }
  await page
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

test("图片入口支持多张粘贴、拖放和键盘选图，拒绝无效文件并保留队列", async ({ page }, info) => {
  await openImageImport(page);
  const bytes = [...(await readFile(imagePath))];
  const clipboardImage = { name: "粘贴的截图.png", type: "image/png", bytes };
  const queue = uploadQueue(page);
  expect(await transferImages(page, "paste", [clipboardImage])).toBe(true);
  const preview = page.getByAltText("待识别的日语原图", { exact: true });
  await expect.poll(() => preview.evaluate((el) => el.complete && el.naturalWidth > 0)).toBe(true);
  await expect(uploadCards(queue)).toHaveCount(1);
  await expect(page.locator(".image-file-details > strong")).toHaveText(clipboardImage.name);
  const previewUrl = await preview.getAttribute("src");

  await transferImages(page, "paste", [{ name: "不支持.gif", type: "image/gif", bytes: [71, 73, 70] }]);
  await expect(page.getByRole("alert")).toContainText("PNG、JPEG 或 WebP");
  await expect(preview).toHaveAttribute("src", previewUrl);
  await expect(uploadCards(queue)).toHaveCount(1);
  expect(await transferImages(page, "drop", [clipboardImage, { ...clipboardImage, name: "第二张.png" }])).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(uploadNames(queue)).toHaveText([clipboardImage.name, clipboardImage.name, "第二张.png"]);
  const batchPreviewUrl = await preview.getAttribute("src");

  await transferImages(page, "paste", [{ name: "太大.png", type: "image/png", size: 12 * 1024 * 1024 + 1 }]);
  await expect(page.getByRole("alert")).toContainText("大小不超过 12 MB");
  await expect(preview).toHaveAttribute("src", batchPreviewUrl);
  await expect(uploadCards(queue)).toHaveCount(3);
  expect(await transferImages(page, "drop", [{ ...clipboardImage, name: "拖入的截图.png" }])).toBe(true);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.locator(".image-file-details > strong")).toHaveText("拖入的截图.png");

  const chooserReady = page.waitForEvent("filechooser");
  const picker = page.getByRole("button", { name: "点击选择或更换图片", exact: true });
  await picker.focus(); await picker.press("Enter");
  const chooser = await chooserReady;
  expect(chooser.isMultiple()).toBe(true);
  await chooser.setFiles([imagePath, secondImagePath]);
  await expect(page.getByLabel("选择日语图片", { exact: true })).toHaveAttribute("multiple", "");
  await expect(uploadNames(queue)).toHaveText([
    clipboardImage.name, clipboardImage.name, "第二张.png", "拖入的截图.png", "first.png", "second.png",
  ]);
  await expect(page.locator(".image-file-details > strong")).toHaveText("first.png");
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "移除second.png", exact: true }).click();
  await expect(uploadCards(queue)).toHaveCount(5);
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  await page.screenshot({ path: `artifacts/stage2-image-input-${info.project.name}.png`, fullPage: true, animations: "disabled" });
});

test("图片队列前移后移保持当前照片，右上角移除不改变其他照片", async ({ page }, info) => {
  await openImageImport(page);
  const bytes = await readFile(imagePath), other = await readFile(secondImagePath);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles([
    { name: "排序甲.png", mimeType: "image/png", buffer: bytes },
    { name: "排序乙.png", mimeType: "image/png", buffer: other },
    { name: "排序丙.png", mimeType: "image/png", buffer: bytes },
  ]);
  const queue = uploadQueue(page), cards = uploadCards(queue);
  await expect(cards).toHaveCount(3);
  await expect(page.locator(".image-batch-list")).toHaveCount(0);
  await expect(queue.locator(".source-sort-summary")).toContainText("已上传 3 / 3");
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  const summaryBox = await queue.locator(".source-sort-summary").boundingBox(), firstCardBox = await cards.first().boundingBox();
  expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(firstCardBox.y);
  const initial = await queueIds(queue);
  const image = (id) => queue.locator(`.source-sort-card[data-sort-image-id="${id}"]`);
  const previous = queue.getByRole("button", { name: "前移当前照片", exact: true });
  const next = queue.getByRole("button", { name: "后移当前照片", exact: true });
  await expect(previous).toBeDisabled(); await expect(next).toBeEnabled();
  await expect(queue.getByRole("button", { name: "允许拖动排序", exact: true })).toHaveCount(0);
  await next.click();
  await expect.poll(() => queueIds(queue)).toEqual([initial[1], initial[0], initial[2]]);
  await expect(image(initial[0])).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".image-file-details > strong")).toHaveText("排序甲.png");
  await previous.click();
  await expect.poll(() => queueIds(queue)).toEqual(initial);
  await image(initial[2]).click();
  await expect(next).toBeDisabled(); await expect(previous).toBeEnabled();
  await previous.click();
  await expect.poll(() => queueIds(queue)).toEqual([initial[0], initial[2], initial[1]]);
  await expect(image(initial[2])).toHaveAttribute("aria-pressed", "true");
  await next.click();
  await expect.poll(() => queueIds(queue)).toEqual(initial);

  const currentInfo = page.locator('[aria-label="当前照片信息"]');
  await expect(currentInfo).toContainText("排序丙.png");
  await expect(currentInfo).toContainText(/3\s*\/\s*3/);
  const infoBox = await currentInfo.boundingBox(), previewBox = await page.locator(".image-import-preview").boundingBox();
  expect(infoBox).toBeTruthy(); expect(previewBox).toBeTruthy();
  expect(infoBox.y + infoBox.height).toBeLessThanOrEqual(previewBox.y + 1);
  await queue.getByRole("button", { name: "移除排序乙.png", exact: true }).click();
  await expect.poll(() => queueIds(queue)).toEqual([initial[0], initial[2]]);
  await expect(image(initial[2])).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".image-file-details > strong")).toHaveText("排序丙.png");
  await expect(currentInfo).toContainText(/2\s*\/\s*2/);
  await queue.getByRole("button", { name: "移除排序甲.png", exact: true }).click();
  await expect.poll(() => queueIds(queue)).toEqual([initial[2]]);
  await expect(image(initial[2])).toHaveAttribute("aria-pressed", "true");
  await expect(currentInfo).toContainText(/1\s*\/\s*1/);
  await expect(previous).toBeDisabled(); await expect(next).toBeDisabled();
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();

  if (info.project.name === "phone") {
    await page.setViewportSize({ width: 320, height: 844 });
    await expect(image(initial[2]).locator(".source-sort-card-label")).toBeHidden();
    const compact = await image(initial[2]).boundingBox();
    expect(compact.width).toBeGreaterThanOrEqual(44); expect(compact.width).toBeLessThanOrEqual(80);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await queue.getByRole("button", { name: "移除排序丙.png", exact: true }).click();
  await expect(uploadQueue(page)).toHaveCount(0);
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeDisabled();
  await page.screenshot({ path: `artifacts/image-queue-sort-remove-${info.project.name}.png`, fullPage: true, animations: "disabled" });
});

test("后台任务逐图显示部分失败，重试保留已完成正文和注音", async ({ page }, info) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ annotationFailures: "permanent", annotationSkip: 1 });
  const before = await runtimeCursor();
  const bytes = await readFile(imagePath);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles([
    { name: "进度甲.png", mimeType: "image/png", buffer: bytes },
    { name: "进度乙.png", mimeType: "image/png", buffer: bytes },
    { name: "进度丙.png", mimeType: "image/png", buffer: bytes },
  ]);
  const id = await submitImageTask(page);
  const failed = await waitTask(page, id, "needs_attention");
  expect(failed.counts).toMatchObject({ total: 3, uploaded: 3, recognized: 3, completed: 1, failed: 2 });
  const items = page.getByRole("list", { name: "逐图处理状态", exact: true }).locator("li");
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toHaveAttribute("data-status-kind", "done");
  await expect(items.nth(1)).toHaveAttribute("data-status-kind", "error");
  await expect(items.nth(2)).toHaveAttribute("data-status-kind", "error");
  await expect(items.nth(1)).toContainText("正文已保留");
  const callsBefore = await runtimeCalls(before);
  expect(callsBefore.filter((call) => call.phase === "recognize")).toHaveLength(3);
  expect(callsBefore.filter((call) => call.phase === "annotate")).toHaveLength(7);
  await setImageControls();
  const retryCursor = await runtimeCursor();
  await page.getByRole("button", { name: "重试失败步骤", exact: true }).click();
  const done = await waitTask(page, id);
  expect(done.items.map((item) => item.imageId)).toEqual(failed.items.map((item) => item.imageId));
  const retryCalls = await runtimeCalls(retryCursor);
  expect(retryCalls.filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["annotate", "annotate"]);
  await openTaskResult(page, id);
  await page.getByRole("button", { name: "全文检查", exact: true }).click();
  expect(await renderedText(page.locator(".editor-full-content"))).toBe(ocrText + ocrText + ocrText);
  await page.getByRole("button", { name: "关闭全文检查", exact: true }).click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/image-queue-progress-${info.project.name}.png`, fullPage: true, animations: "disabled" });
});

test("识别前逐图排序和旋转真实像素，任务重试复用方向且提交后冻结输入", async ({ page }, info) => {
  await enableTestAccount(page); await openImageImport(page);
  const red = await sharp({ create: { width: 200, height: 200, channels: 3, background: "#c32c24" } }).png().toBuffer();
  const firstBytes = await sharp(await readFile(imagePath)).composite([{ input: red, top: 0, left: 0 }]).png().toBuffer();
  const secondBytes = await readFile(secondImagePath);
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles([
    { name: "方向甲.png", mimeType: "image/png", buffer: firstBytes },
    { name: "方向乙.png", mimeType: "image/png", buffer: secondBytes },
  ]);
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  const queue = uploadQueue(page), ids = await queueIds(queue);
  const card = (index) => queue.locator(`.source-sort-card[data-sort-image-id="${ids[index]}"]`);
  await page.getByRole("button", { name: "向左旋转90°", exact: true }).click();
  await expect(page.locator('[aria-label="识别前调整图片方向"]')).toContainText("270°");
  await card(1).click();
  await page.getByRole("button", { name: "向右旋转90°", exact: true }).click();
  await expect(page.locator('[aria-label="识别前调整图片方向"]')).toContainText("90°");
  await card(0).click();
  await queue.getByRole("button", { name: "后移当前照片", exact: true }).click();
  await expect.poll(() => queueIds(queue)).toEqual([ids[1], ids[0]]);
  const preview = page.getByAltText("待识别的日语原图", { exact: true });
  await expect.poll(() => preview.evaluate((image) => { const box = image.getBoundingClientRect(); return box.width / box.height; })).toBeCloseTo(600 / 800, 2);
  await setImageControls({ annotationFailures: "permanent" });
  const cursor = await runtimeCursor(), id = await submitImageTask(page);
  const failed = await waitTask(page, id, "needs_attention");
  expect(failed.items.map((item) => item.name)).toEqual(["方向乙.png", "方向甲.png"]);
  const rotated = await Promise.all(failed.items.map((item) => currentImage(page, item.imageId)));
  expect(rotated.map((item) => [item.metadata.revision, item.pixels.width, item.pixels.height])).toEqual([[2, 480, 640], [2, 600, 800]]);
  expect(await sharp(rotated[0].bytes).raw().toBuffer()).toEqual(await sharp(secondBytes).rotate(90).raw().toBuffer());
  expect(await sharp(rotated[1].bytes).raw().toBuffer()).toEqual(await sharp(firstBytes).rotate(270).raw().toBuffer());
  const illegalTurn = await page.request.post(`/api/images/${failed.items[0].imageId}/rotate`, { data: { quarterTurns: 1, revision: 2 } });
  expect(illegalTurn.status()).toBe(409);
  await setImageControls();
  const retryCursor = await runtimeCursor();
  await page.getByRole("button", { name: "重试失败步骤", exact: true }).click();
  await waitTask(page, id);
  expect((await runtimeCalls(retryCursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["annotate", "annotate"]);
  expect((await runtimeCalls(cursor)).filter((call) => call.phase === "recognize")).toHaveLength(2);
  for (let index = 0; index < failed.items.length; index++) {
    const image = await currentImage(page, failed.items[index].imageId);
    expect(image.metadata.revision).toBe(2); expect(image.bytes).toEqual(rotated[index].bytes);
  }
  await openTaskResult(page, id);
  await page.screenshot({ path: `artifacts/image-import-direction-${info.project.name}.png`, fullPage: true, animations: "disabled" });
});

test("任务提交成功响应丢失后找回同一任务，不重传或重复旋转原图", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  let uploads = 0;
  page.on("request", (request) => { if (request.method() === "POST" && /\/api\/image-tasks\/[^/]+\/items\/[^/]+\/image$/.test(new URL(request.url()).pathname)) uploads++; });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  const initialId = await page.evaluate(() => location.hash.slice("#tasks/".length));
  await page.getByRole("button", { name: "向左旋转90°", exact: true }).click();
  await expect(page.locator('[aria-label="识别前调整图片方向"]')).toContainText("270°");
  let lostReply = false;
  await page.route("**/api/image-tasks/*/submit", async (route) => {
    const response = await route.fetch(); expect(response.status()).toBe(202); lostReply = true;
    await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试：任务提交成功响应丢失。" }) });
  });
  const cursor = await runtimeCursor(), id = await submitImageTask(page);
  expect(id).toBe(initialId); expect(lostReply).toBe(true);
  const ready = await waitTask(page, id), image = await currentImage(page, ready.items[0].imageId);
  expect(uploads).toBe(1);
  expect([image.metadata.revision, image.pixels.width, image.pixels.height]).toEqual([2, 600, 800]);
  expect(await sharp(image.bytes).raw().toBuffer()).toEqual(await sharp(await readFile(imagePath)).rotate(270).raw().toBuffer());
  const duplicate = await page.request.post(`/api/image-tasks/${id}/submit`, { data: { version: ready.version } });
  expect(duplicate.status()).toBe(202); expect((await duplicate.json()).id).toBe(id);
  expect((await currentImage(page, ready.items[0].imageId)).metadata.revision).toBe(2);
  expect((await runtimeCalls(cursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["recognize", "annotate"]);
  await openTaskResult(page, id);
});

test("批量导入先选书再选文章，整批分句后保存无需再次等待分句", async ({ page }, info) => {
  await enableTestAccount(page);
  const createdBooks = [];
  let segmentationCalls = 0;
  try {
    for (const suffix of ["甲", "乙"]) {
      const created = await page.request.post("/api/books", { data: { title: `图片目标${suffix}-${info.project.name}` } });
      expect(created.status()).toBe(201);
      const book = await created.json(); createdBooks.push(book.id);
      const article = await page.request.post("/api/documents", { data: {
        title: `目标文章${suffix}`, kind: "book", orientation: "horizontal", bookId: book.id, content: `既存の本文${suffix}。`,
      } });
      expect(article.status()).toBe(201);
    }
    await openImageImport(page);
    const bookPicker = page.getByLabel("图片所属书籍", { exact: true });
    const articlePicker = page.getByLabel("图片所属文章", { exact: true });
    await expect(articlePicker.locator("option").filter({ hasText: /^目标文章[甲乙]$/ })).toHaveCount(0);
    await bookPicker.selectOption(createdBooks[0]);
    await expect(articlePicker.locator("option")).toHaveText(["新建文章", "目标文章甲"]);
    await articlePicker.selectOption({ label: "目标文章甲" });
    await bookPicker.selectOption(createdBooks[1]);
    await expect(articlePicker).toHaveValue("");
    await expect(articlePicker.locator("option")).toHaveText(["新建文章", "目标文章乙"]);
    await bookPicker.selectOption({ label: "＋ 新建书籍" });
    const title = `同篇多图-${info.project.name}`;
    await page.getByLabel("新书籍名称", { exact: true }).fill(title);
    await page.getByLabel("新文章标题", { exact: true }).fill("同一文章的两张原图");
    await page.getByLabel("选择日语图片", { exact: true }).setInputFiles([imagePath, secondImagePath]);
    await expect(uploadNames(uploadQueue(page))).toHaveText(["first.png", "second.png"]);
    const taskId = await submitImageTask(page);
    await waitTask(page, taskId);
    const beforeApply = await (await page.request.get("/api/books")).json();
    expect(beforeApply.books.some((book) => book.title === title)).toBe(false);
    await openTaskResult(page, taskId);
    await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toBeEnabled();
    await expect(page.locator(".source-sort-card[data-sort-image-id]")).toHaveCount(2);
    await openEditorDetails(page, ".editor-meta-details");
    await expect(page.getByLabel("保存到书籍", { exact: true })).toHaveValue("__task_new_book__");
    await page.route("**/api/documents/*/sentences", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      segmentationCalls++; await route.continue();
    });
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
    expect(segmentationCalls).toBe(0);
    const navigation = page.getByRole("navigation", { name: "文章导航", exact: true });
    await expect(navigation.getByRole("button", { name: "添加图片文章", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "继续添加图片", exact: true })).toBeEnabled();
    const document = await getDocument(page, await page.evaluate(() => location.hash.slice(1)));
    const savedBookId = document.bookId; createdBooks.push(savedBookId);
    expect(savedBookId).toBeTruthy();
    expect((await (await page.request.get(`/api/books/${savedBookId}`)).json()).title).toBe(title);
    expect(document.sourceImages).toHaveLength(2);
    expect(document.sourceImages[0].id).not.toBe(document.sourceImages[1].id);
    expect(bodyText(document.bodyHtml)).toBe(ocrText + ocrText);
    expect(hasCompleteSentenceBoundaries(document.bodyHtml)).toBe(true);
    for (const [index, path] of [imagePath, secondImagePath].entries()) {
      const raw = await page.request.get(`/api/images/${document.sourceImages[index].id}/raw`);
      expect(raw.ok()).toBe(true); expect(await raw.body()).toEqual(await readFile(path));
    }
    await page.unroute("**/api/documents/*/sentences");
  } finally {
    await page.unroute("**/api/documents/*/sentences");
    for (const id of createdBooks.reverse()) await removeTestBook(page, id);
    await page.request.post("/api/ai/logout");
  }
});

test("上传失败可重试，识别失败仍保留服务端原图且不重复上传", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  let uploadCount = 0;
  await page.route("**/api/image-tasks/*/items/*/image", async (route) => {
    uploadCount++;
    if (uploadCount === 1) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试故障：上传暂时失败。" }) });
    await route.continue();
  });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  await expect(page.getByRole("alert")).toContainText("上传暂时失败");
  await expect(page.getByAltText("待识别的日语原图", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重试上传", exact: true }).click();
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  await setImageControls({ ocrFailures: "permanent" });
  const id = await submitImageTask(page), failed = await waitTask(page, id, "needs_attention");
  expect(failed.counts).toMatchObject({ uploaded: 1, recognized: 0, failed: 1 });
  await expect(page.getByRole("list", { name: "逐图处理状态", exact: true })).toContainText("识别未完成");
  const oldImageId = failed.items[0].imageId, cursor = await runtimeCursor();
  await setImageControls();
  await page.getByRole("button", { name: "重试失败步骤", exact: true }).click();
  const done = await waitTask(page, id);
  expect(done.items[0].imageId).toBe(oldImageId); expect(uploadCount).toBe(2);
  expect((await runtimeCalls(cursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["recognize", "annotate"]);
  await openTaskResult(page, id);
  await expect(page.getByRole("region", { name: "原图对照", exact: true })).toBeVisible();
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

test("后台完成时间持久保存，打开校对原图的加载不延长任务用时", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ delayMs: 120 });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const id = await submitImageTask(page), completed = await waitTask(page, id);
  expect(Date.parse(completed.completedAt)).toBeGreaterThan(Date.parse(completed.startedAt));
  await expect(page.locator(".task-statistics")).toContainText("用时");
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

test("提交后后台依次识别和注音，完成后留在任务页待用户开始校对", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ delayMs: 150 });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const cursor = await runtimeCursor(), id = await submitImageTask(page);
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toHaveCount(0);
  await expect(page.getByLabel("选择日语图片", { exact: true })).toHaveCount(0);
  const ready = await waitTask(page, id);
  await expect(page.getByRole("region", { name: "任务状态", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "开始校对", exact: true })).toBeVisible();
  const changed = await page.request.patch(`/api/image-tasks/${id}`, { data: { version: ready.version, itemDirections: { [ready.items[0].id]: 1 } } });
  expect(changed.status()).toBe(409);
  expect((await runtimeCalls(cursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["recognize", "annotate"]);
  const annotated = await openTaskResult(page, id), draft = annotated.recognition;
  expect(draft.reasoningEffort).toBe("low"); expect(draft.processing.bodyFormat).toBe("text_only");
  expect(draft.blocks.flatMap((block) => block.segments).every((segment) => segment.reading === null && segment.origin === null)).toBe(true);
  expect(annotated.annotationReasoningEffort).toBe("low");
  expect(annotated.annotation.readingPolicy).toBe("image_reference");
  expect(annotated.annotation.imageReference).toEqual({ imageId: draft.sourceImageId, revision: draft.sourceImage.revision });
  const segments = annotated.blocks.flatMap((block) => block.segments);
  expect(segments.filter((segment) => segment.origin === "source")).toHaveLength(0);
  expect(segments.filter((segment) => segment.origin === "generated")).toHaveLength(7);
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toBeEnabled();
  await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
  const preview = page.getByRole("region", { name: "阅读预览", exact: true });
  expect(await renderedText(preview)).toBe(ocrText);
  await expect(preview.locator('ruby[data-origin="generated"]')).toHaveCount(7);
});

test("自动注音重试耗尽仍保留正文，手动重试任务只补注音", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ annotationFailures: "permanent" });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const before = await runtimeCursor(), id = await submitImageTask(page);
  const failed = await waitTask(page, id, "needs_attention");
  expect(failed.counts).toMatchObject({ uploaded: 1, recognized: 1, completed: 0, failed: 1 });
  await expect(page.getByRole("list", { name: "逐图处理状态", exact: true })).toContainText("正文已保留");
  const oldCalls = await runtimeCalls(before);
  expect(oldCalls.filter((call) => call.phase === "recognize")).toHaveLength(1);
  expect(oldCalls.filter((call) => call.phase === "annotate")).toHaveLength(3);
  const retryCursor = await runtimeCursor();
  await setImageControls();
  await page.getByRole("button", { name: "重试失败步骤", exact: true }).click();
  const done = await waitTask(page, id);
  expect(done.items[0].imageId).toBe(failed.items[0].imageId);
  expect((await runtimeCalls(retryCursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["annotate"]);
  await openTaskResult(page, id);
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
});

test("自动注音失败可先校对正文，再从校对器单独生成缺失注音", async ({ page }) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ annotationFailures: "permanent" });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
  const id = await submitImageTask(page);
  await waitTask(page, id, "needs_attention");
  await openTaskResult(page, id, "先校对正文／手动注音");
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await expect(page.getByRole("tab", { name: /注音校正/ })).toContainText("0");
  await page.getByRole("tab", { name: /注音校正/ }).click();
  await setImageControls();
  const cursor = await runtimeCursor();
  let releaseManual;
  const gate = new Promise((resolve) => { releaseManual = resolve; });
  const routePattern = "**/api/image-tasks/*/items/*/annotate";
  await page.route(routePattern, async (route) => { await gate; await route.continue(); });
  const reply = page.waitForResponse((response) => /\/api\/image-tasks\/[^/]+\/items\/[^/]+\/annotate$/.test(new URL(response.url()).pathname));
  try {
    await page.getByRole("button", { name: "生成缺失注音", exact: true }).click();
    const progress = page.getByRole("region", { name: "图片处理进度", exact: true });
    await expect(progress).toHaveAttribute("data-phase", "annotate");
    expect(await progress.getByRole("progressbar", { name: "生成注音进度", exact: true }).getAttribute("aria-valuenow")).toBeNull();
    await expect(page.getByRole("button", { name: "正在生成缺失注音…", exact: true })).toBeDisabled();
    releaseManual(); expect((await reply).ok()).toBe(true);
    await expect(progress).toHaveCount(0);
  } finally { releaseManual(); await page.unroute(routePattern); }
  await expect(page.locator("[data-annotation-elapsed-ms]")).toBeVisible();
  await page.getByRole("tab", { name: "正文编辑", exact: true }).click();
  await expect(page.getByLabel("日语正文", { exact: true })).toHaveValue(ocrText);
  await page.getByRole("tab", { name: /注音校正/ }).click();
  await expect(page.getByText("正文与注音已完成，请一起校对正文和读音后保存。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "生成缺失注音", exact: true })).toHaveCount(0);
  expect((await runtimeCalls(cursor)).filter((call) => call.type === "image").map((call) => call.phase)).toEqual(["annotate"]);
});

test("真实图片上传、校对保存与对话重开（OCR 和回答为测试替身）", async ({
  page,
}, info) => {
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await enableTestAccount(page);
  await openImageImport(page);
  await page
    .getByLabel("选择日语图片", { exact: true })
    .setInputFiles(imagePath);
  await expect(
    page.getByAltText("待识别的日语原图", { exact: true }),
  ).toBeVisible();
  const taskId = await submitImageTask(page);
  await waitTask(page, taskId); await openTaskResult(page, taskId);
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
  await openEditorDetails(page, ".ocr-review-overview");
  await page.getByRole("tab", { name: /注音校正/ }).click();
  const recordedTask = await getTask(page, taskId);
  expect(recordedTask.state).toBe("ready");
  expect(recordedTask.completedAt).toBeTruthy();
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
  await expect(page.locator(".reader-recognition-details")).toHaveCount(0);
  await page
    .getByRole("button", { name: "校对文字与注音", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "原图对照", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "打开完整原图", exact: true }),
  ).toHaveAttribute("href", new RegExp(`^${rawPath}(?:\\?revision=\\d+)?$`));
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
  await selectArticleText(page, "背中");
  const popup = page.getByRole("dialog", {name:"划词提问"});
  await popup.getByRole("button", {name:"自定义问题",exact:true}).click();
  await popup.getByRole("textbox", {name:"选区自定义问题"}).fill("背中在这里是什么意思？");
  const chat = page.getByRole("region", { name: "原文 AI 讨论", exact: true });
  let releaseAnswer;
  const answerGate = new Promise((resolve) => { releaseAnswer = resolve; });
  const answerRoute = `**/api/documents/${documentId}/conversations`;
  await page.route(answerRoute, async (route) => {
    if (route.request().method() === "POST") await answerGate;
    await route.continue();
  });
  try {
    await popup.getByRole("button", { name: "发送", exact: true }).click();
    const progress = chat.getByRole("region", { name: "AI回答进度", exact: true });
    await expect(progress).toHaveAttribute("data-phase", "reply");
    expect(await progress.getByRole("progressbar", { name: "生成回答进度", exact: true }).getAttribute("aria-valuenow")).toBeNull();
    await expect(chat.getByRole("textbox", { name: "向 AI 提问", exact: true })).toBeDisabled();
    await page.screenshot({ path: `artifacts/design-2026-10-28/answer-progress-${info.project.name}.png`, fullPage: true, animations: "disabled" });
    releaseAnswer();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(1);
    await expect(progress).toHaveCount(0);
  } finally {
    releaseAnswer();
    await page.unroute(answerRoute);
  }
  await expect(chat.locator(".chat-message.assistant")).toContainText(
    "【浏览器测试替身，不是真实 AI 回答】",
  );
  await chat
    .getByRole("textbox", { name: "向 AI 提问", exact: true })
    .fill("再给一个相关例句。");
  await chat.getByRole("button", { name: "发送问题", exact: true }).click();
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
  await page.getByRole("button", { name: "对话记录", exact: true }).click();
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
    data: { revision: (await getDocument(page, documentId)).revision },
  });
  expect(deleted.status()).toBe(204);
  await page.request.post("/api/ai/logout");
  expect(browserErrors).toEqual([]);
});

test("批量注音只修改明确选中的词语位置，保存后保留各自读音", async ({
  page,
}, info) => {
  await enableTestAccount(page);
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
  await enableTestAccount(page);
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
  const latest = await getDocument(page, document.id);
  expect((await page.request.delete(`/api/documents/${document.id}`, {
    data: { revision: latest.revision },
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
    await expect(
      menu.getByRole("button", { name: "生成朋友的邀请码", exact: true }),
    ).toHaveCount(0);
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

async function removeTestBook(page, id) {
  if (!id) return;
  const response = await page.request.get(`/api/books/${id}`);
  if (!response.ok()) return;
  const book = await response.json();
  const removed = await page.request.delete(`/api/books/${id}`, {
    data: { revision: book.revision },
  });
  expect(removed.status()).toBe(204);
}

test("多页书籍逐张保存图片，翻页重开保留各页原图注音与独立讨论", async ({ page }, info) => {
  await enableTestAccount(page);
  let bookId;
  const title = `逐张图片书籍-${info.project.name}`;
  const browserErrors = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    await page.goto("/");
    const openShelf = page.getByRole("button", { name: "打开书架", exact: true });
    if (await openShelf.isVisible()) await openShelf.click();
    await page.getByRole("button", { name: "新建书籍", exact: true }).click();
    await page.getByRole("textbox", { name: "书籍名称", exact: true }).fill(title);
    await page.getByRole("button", { name: "创建书籍", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    bookId = await page.evaluate(() => location.hash.slice("#book/".length));
    expect(bookId).toMatch(/^[a-f0-9-]+$/);
    await page.getByRole("button", { name: "添加图片文章", exact: true }).click();
    await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
    const firstTaskId = await submitImageTask(page);
    await waitTask(page, firstTaskId); await openTaskResult(page, firstTaskId);
    await openEditorDetails(page, ".editor-meta-details");
    await expect(page.getByLabel("保存到书籍", { exact: true })).toHaveValue(bookId);
    await page.getByRole("textbox", { name: "材料标题", exact: true }).fill("第一张图片页");
    if (info.project.name === "desktop")
      await page.getByRole("tab", { name: "阅读预览", exact: true }).click();
    await page.getByRole("tab", { name: /注音校正/ }).click();
    const preview = page.locator(".preview-content");
    const previewHeight = info.project.name === "desktop"
      ? await preview.evaluate((element) => element.getBoundingClientRect().height)
      : null;
    await page.getByRole("textbox", { name: "空的读音（第1行）", exact: true }).fill("くう");
    if (previewHeight !== null) {
      await expect(page.locator("mark.ruby-active-occurrence")).toHaveCount(1);
      await expect.poll(() => preview.evaluate((element) => element.getBoundingClientRect().height))
        .toBeCloseTo(previewHeight, 2);
    }
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    await expect(page.getByRole("heading", { name: "第一张图片页", exact: true })).toBeVisible();
    const firstId = await page.evaluate(() => location.hash.slice(1));
    let first = await getDocument(page, firstId);
    expect(first.bookId).toBe(bookId);
    expect(first.position).toBe(1);
    expect(first.content).toContain("{空|くう}");
    expect(first.blocks[0].segments.find((segment) => segment.text === "空").origin).toBe("manual");
    const discussionResponse = await page.request.post(`/api/documents/${firstId}/conversations`, {
      data: await discussionInput(page, firstId, "空", "第一张图片页的独立讨论"),
    });
    expect(discussionResponse.status()).toBe(201);
    const discussion = await discussionResponse.json();
    first = await getDocument(page, firstId);

    // Append from the ordinary image importer to exercise the explicit parent
    // selector as well as the preselected book context used for the first page.
    const secondDraft = await importDraft(page, secondImagePath);
    await openEditorDetails(page, ".editor-meta-details");
    await page.getByLabel("保存到书籍", { exact: true }).selectOption(bookId);
    await page.getByRole("textbox", { name: "材料标题", exact: true }).fill("第二张图片页");
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    await expect(page.getByRole("heading", { name: "第二张图片页", exact: true })).toBeVisible();
    const secondId = await page.evaluate(() => location.hash.slice(1));
    const second = await getDocument(page, secondId);
    expect(second.bookId).toBe(bookId);
    expect(second.position).toBe(2);
    expect(second.id).not.toBe(first.id);
    expect(second.sourceImageId).not.toBe(first.sourceImageId);
    expect(second.recognition.sourceImageId).toBe(secondDraft.sourceImageId);
    expect(second.content).toContain("{空|そら}");
    expect(second.blocks[0].segments.find((segment) => segment.text === "空").origin).toBe("generated");
    for (const [document, path] of [[first, imagePath], [second, secondImagePath]]) {
      const original = await page.request.get(`/api/images/${document.sourceImageId}/raw`);
      expect(original.ok()).toBe(true);
      expect(await original.body()).toEqual(await readFile(path));
    }
    expect(second.recognition.blocks.flatMap((block) => block.segments).some((segment) => segment.reading)).toBe(false);
    expect(second.recognition.annotation.blocks.flatMap((block) => block.segments).some((segment) => segment.reading)).toBe(true);

    const bookResponse = await page.request.get(`/api/books/${bookId}`);
    expect(bookResponse.ok()).toBe(true);
    const book = await bookResponse.json();
    expect(book.pages.map((item) => item.id)).toEqual([firstId, secondId]);
    expect(book.pages.map((item) => item.position)).toEqual([1, 2]);
    const library = await (await page.request.get("/api/documents")).json();
    expect(library.documents.some((item) => [firstId, secondId].includes(item.id))).toBe(false);
    const listedBooks = await (await page.request.get(`/api/books?q=${encodeURIComponent(title)}`)).json();
    expect(listedBooks.books.map((item) => item.id)).toContain(bookId);

    await page.reload();
    const navigation = page.getByRole("navigation", { name: "文章导航", exact: true });
    const article = page.getByRole("article", { name: "日语原文", exact: true });
    await expect(navigation.getByLabel("书籍文章", { exact: true })).toHaveValue(secondId);
    await expect(navigation.getByRole("button", { name: "下一篇", exact: true })).toBeDisabled();
    await expect(article.locator("rt")).toContainText(["そら"]);
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    await expect(page.locator(".qa-group")).toHaveCount(0);
    await expect(page.locator(".chat-message")).toHaveCount(0);
    await page.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();

    await navigation.getByRole("button", { name: "上一篇", exact: true }).click();
    await expect(page.getByRole("heading", { name: "第一张图片页", exact: true })).toBeVisible();
    await expect(navigation.getByLabel("书籍文章", { exact: true })).toHaveValue(firstId);
    await expect(navigation.getByRole("button", { name: "上一篇", exact: true })).toBeDisabled();
    await expect(article.locator("rt")).toContainText(["くう"]);
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    await expect(page.locator(".qa-group")).toHaveCount(discussion.groups.length);
    await expect(page.locator(".chat-message.user")).toContainText("第一张图片页的独立讨论");
    await page.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();
    await navigation.getByRole("button", { name: "下一篇", exact: true }).click();
    await expect(page.getByRole("heading", { name: "第二张图片页", exact: true })).toBeVisible();
    await navigation.getByLabel("书籍文章", { exact: true }).selectOption(firstId);
    await expect(page.getByRole("heading", { name: "第一张图片页", exact: true })).toBeVisible();
    expect(await getDocument(page, firstId)).toEqual(first);
    expect(await getDocument(page, secondId)).toEqual(second);
    await page.screenshot({
      path: `artifacts/books-page-reader-${info.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    await navigation.getByRole("button", { name: `返回书籍：${title}`, exact: true }).click();
    await expect(page.getByLabel("书籍文章列表", { exact: true }).getByRole("listitem")).toHaveCount(2);
    await page.screenshot({
      path: `artifacts/books-two-image-pages-${info.project.name}.png`,
      fullPage: true,
      animations: "disabled",
    });
    expect(browserErrors).toEqual([]);
  } finally {
    await removeTestBook(page, bookId);
    await page.request.post("/api/ai/logout");
  }
});

test("既有材料原地转为书籍，保留原图注音讨论并可追加文字页", async ({ page }, info) => {
  await enableTestAccount(page);
  let bookId;
  let firstId;
  const title = `原地转换书籍-${info.project.name}`;
  try {
    let { document: original } = await createImageDocument(page);
    firstId = original.id;
    const conversationResponse = await page.request.post(`/api/documents/${firstId}/conversations`, {
      data: await discussionInput(page, firstId, "背中", "转换书籍前的原有讨论"),
    });
    expect(conversationResponse.status()).toBe(201);
    const originalDiscussion = await conversationResponse.json();
    await page.reload();
    await page.getByRole("button", { name: "转为书籍", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "书籍名称", exact: true })).toHaveValue(original.title);
    await page.getByRole("textbox", { name: "书籍名称", exact: true }).fill(title);
    await page.getByRole("button", { name: "创建书籍", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    const promoted = await getDocument(page, firstId);
    bookId = promoted.bookId;
    expect(bookId).toBeTruthy();
    expect(promoted.position).toBe(1);
    expect(promoted.id).toBe(original.id);
    expect(promoted.blocks).toEqual(original.blocks);
    expect(promoted.recognition).toEqual(original.recognition);
    expect(promoted.sourceImageId).toBe(original.sourceImageId);
    const conversations = await (await page.request.get(`/api/documents/${firstId}/conversations`)).json();
    expect(conversations.conversations).toEqual([originalDiscussion]);

    await page.getByRole("button", { name: "添加文字文章", exact: true }).click();
    await expect(page.getByLabel("保存到书籍", { exact: true })).toHaveValue(bookId);
    await page.getByRole("textbox", { name: "材料标题", exact: true }).fill("补充文字页");
    await page.getByRole("textbox", { name: "日语正文", exact: true }).fill("これは{追加|ついか}した{本文|ほんぶん}です。");
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    await expect(page.getByRole("heading", { name: "补充文字页", exact: true })).toBeVisible();
    const secondId = await page.evaluate(() => location.hash.slice(1));
    const added = await getDocument(page, secondId);
    expect(added.bookId).toBe(bookId);
    expect(added.position).toBe(2);
    expect(added.sourceImageId).toBeNull();
    await page.reload();
    const navigation = page.getByRole("navigation", { name: "文章导航", exact: true });
    await expect(navigation.getByLabel("书籍文章", { exact: true })).toHaveValue(secondId);
    await navigation.getByRole("button", { name: "上一篇", exact: true }).click();
    await expect(page.getByRole("heading", { name: original.title, exact: true })).toBeVisible();
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    await expect(page.locator(".qa-group")).toHaveCount(originalDiscussion.groups.length);
    await expect(page.locator(".chat-message.user")).toContainText("转换书籍前的原有讨论");
  } finally {
    if (bookId) await removeTestBook(page, bookId);
    else if (firstId) {
      const response = await page.request.get(`/api/documents/${firstId}`);
      if (response.ok()) {
        const document = await response.json();
        await page.request.delete(`/api/documents/${firstId}`, { data: { revision: document.revision } });
      }
    }
    await page.request.post("/api/ai/logout");
  }
});

test("校对既有独立材料时新建并选择书籍，书名回车不提前保存且归书保留记录", async ({ page }, info) => {
  await enableTestAccount(page);
  let bookId;
  let documentId;
  const title = `校对归书-${info.project.name}`;
  try {
    let { document: original } = await createImageDocument(page);
    documentId = original.id;
    const discussionResponse = await page.request.post(`/api/documents/${documentId}/conversations`, {
      data: await discussionInput(page, documentId, "空", "校对归书前的独立讨论"),
    });
    expect(discussionResponse.status()).toBe(201);
    const discussion = await discussionResponse.json();
    original = await getDocument(page, documentId);
    await page.reload();
    await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
    const editor = page.locator(".editor-page");
    await openEditorDetails(page, ".editor-meta-details");
    const target = editor.getByLabel("保存到书籍", { exact: true });
    await expect(target).toHaveValue("");
    await editor.getByRole("button", { name: "新建书籍", exact: true }).click();
    const name = editor.getByRole("textbox", { name: "新书籍名称", exact: true });
    await name.fill(title);
    const unexpectedSaves = [];
    const preventPrematureSave = async (route) => {
      if (["POST", "PUT"].includes(route.request().method())) {
        unexpectedSaves.push(route.request().url());
        await route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "测试：书名回车不应保存材料。" }) });
      } else await route.continue();
    };
    const documentRoute = /\/api\/documents(?:\/[^/]+)?$/;
    await page.route(documentRoute, preventPrematureSave);
    try {
      await name.press("Enter");
      await expect(name).toHaveValue(title);
      await expect(editor.getByRole("button", { name: "创建并选中", exact: true })).toBeEnabled();
      expect(unexpectedSaves).toEqual([]);
      expect((await getDocument(page, documentId)).revision).toBe(original.revision);
    } finally {
      await page.unroute(documentRoute, preventPrematureSave);
    }
    await editor.getByRole("button", { name: "创建并选中", exact: true }).click();
    await expect(target).not.toHaveValue("");
    bookId = await target.inputValue();
    await expect(editor.getByRole("textbox", { name: "新书籍名称", exact: true })).toHaveCount(0);
    // Creating/selecting a parent is separate from saving the current page.
    expect((await getDocument(page, documentId)).bookId).toBeUndefined();
    const bookRoute = `**/api/books/${bookId}`;
    await page.route(bookRoute, (route) => route.fulfill({
      status: 503, contentType: "application/json", body: JSON.stringify({ error: "测试：目录暂时不可用。" }),
    }));
    try {
      await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
      await expect(page.getByRole("heading", { name: original.title, exact: true })).toBeVisible();
      await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "打开所属书籍", exact: true })).toBeVisible();
      await page.reload();
      await expect(page.getByRole("heading", { name: original.title, exact: true })).toBeVisible();
      await expect(page.getByRole("article", { name: "日语原文", exact: true }).locator("rt")).toHaveCount(7);
      await expect(page.getByRole("button", { name: "打开所属书籍", exact: true })).toBeVisible();
    } finally {
      await page.unroute(bookRoute);
    }
    await page.getByRole("button", { name: "打开所属书籍", exact: true }).click();
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
    await page.getByRole("button", { name: `打开第 1 篇：${original.title}`, exact: true }).click();
    await expect(page.getByRole("navigation", { name: "文章导航", exact: true })).toBeVisible();
    const saved = await getDocument(page, documentId);
    expect(saved.id).toBe(original.id);
    expect(saved.bookId).toBe(bookId);
    expect(saved.position).toBe(1);
    expect(saved.blocks).toEqual(original.blocks);
    expect(saved.sourceImageId).toBe(original.sourceImageId);
    expect(saved.recognition).toEqual(original.recognition);
    expect(saved.revision).toBe(original.revision + 1);
    const conversations = await (await page.request.get(`/api/documents/${documentId}/conversations`)).json();
    expect(conversations.conversations).toEqual([discussion]);
    await page.reload();
    await expect(page.getByRole("navigation", { name: "文章导航", exact: true }).getByLabel("书籍文章", { exact: true })).toHaveValue(documentId);
    await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
    await expect(page.getByLabel("保存到书籍", { exact: true })).toHaveCount(0);
  } finally {
    if (bookId) await removeTestBook(page, bookId);
    else if (documentId) {
      const response = await page.request.get(`/api/documents/${documentId}`);
      if (response.ok()) {
        const document = await response.json();
        await page.request.delete(`/api/documents/${documentId}`, { data: { revision: document.revision } });
      }
    }
    await page.request.post("/api/ai/logout");
  }
});

test("上传与后台任务分开显示真实进度，模型不报虚假百分比且支持减少动态效果", async ({ page }, info) => {
  await enableTestAccount(page); await openImageImport(page);
  await setImageControls({ delayMs: 2500 });
  let releaseUpload;
  const gate = new Promise((resolve) => { releaseUpload = resolve; });
  await page.route("**/api/image-tasks/*/items/*/image", async (route) => { await gate; await route.continue(); });
  try {
    await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(imagePath);
    await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeDisabled();
    await expect(page.locator(".image-file-status")).toContainText(/正在上传|正在确认保存/);
    await page.screenshot({ path: `artifacts/design-2026-10-28/import-upload-${info.project.name}.png`, fullPage: true, animations: "disabled" });
    releaseUpload();
    const id = await submitImageTask(page), detail = page.getByRole("region", { name: "任务状态", exact: true });
    const currentImageStep = detail.locator('.task-current:not([data-task-phase="segment"])');
    await expect(currentImageStep).toContainText("识别正文");
    await expect(detail.getByRole("progressbar")).toHaveCount(0);
    await expect(detail).toContainText("任务已提交，可以离开此页面");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await detail.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
    await page.screenshot({ path: `artifacts/design-2026-10-28/import-recognize-${info.project.name}.png`, fullPage: true, animations: "disabled" });
    await expect(currentImageStep).toContainText("生成注音");
    await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/design-2026-10-28/import-progress-${info.project.name}.png`, fullPage: true, animations: "disabled" });
    const done = await waitTask(page, id);
    expect(Date.parse(done.completedAt) - Date.parse(done.startedAt)).toBeGreaterThanOrEqual(5000);
    await expect(detail).toBeVisible();
    await openTaskResult(page, id);
    await expect(page.getByRole("button", { name: "保存并阅读", exact: true })).toBeEnabled();
  } finally { releaseUpload(); }
});
