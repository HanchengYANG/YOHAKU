// Real HTTP, uploads, SQLite and browser sessions; AI replies are explicit doubles.
import { test, expect } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import sharp from "sharp";
import { ensureOwnerSession } from "./session.mjs";
import { parseText } from "../../shared/document.mjs";
import { bodyText, bodyRanges, blocksToHtml } from "../../shared/article-html.mjs";

const controlFile = new URL("../../artifacts/ai-e2e-data/image-runtime-controls.json", import.meta.url);
let cookies = [], imageA, imageB;
const activeTasks = new Set();
const controls = (value = {}) => writeFile(controlFile, JSON.stringify({ ocrFailures: 0, annotationFailures: 0, delayMs: 0, ...value }));

test.beforeAll(async () => {
  imageA = await sharp({ create: { width: 540, height: 720, channels: 3, background: "#f3eee3" } }).png().toBuffer();
  imageB = await sharp({ create: { width: 620, height: 430, channels: 3, background: "#dce6d9" } }).png().toBuffer();
});
test.beforeEach(async ({ page }) => {
  if (cookies.length) await page.context().addCookies(cookies);
  await ensureOwnerSession(page.request); cookies = await page.context().cookies();
  const statusResponse = await page.request.get("/api/ai/status");
  expect(statusResponse.ok()).toBe(true);
  if (!(await statusResponse.json()).connected) {
    // Some task tests deliberately leave backend work running. Reuse the shared
    // connected fixture instead of issuing an authorization-management request.
    await expect.poll(async () => (await (await page.request.get("/api/ai/status")).json()).runtime.busy).toBe(false);
    expect((await page.request.post("/api/ai/login", { data: {} })).ok()).toBe(true);
    expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
  }
  await controls();
});
test.afterEach(async ({ page }) => {
  // Only clean up this test's work, preserving all other accounts and tasks.
  for (const id of activeTasks) {
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        const response = await page.request.get(`/api/image-tasks/${id}`);
        if (!response.ok()) break;
        const task = await response.json();
        if (task.appliedDocumentId || ["ready", "cancelled"].includes(task.state)) break;
        const cancelled = await page.request.post(`/api/image-tasks/${id}/cancel`, { data: { version: task.version } });
        if (cancelled.status() !== 409) break;
      }
    } catch { /* A test may have deliberately closed its page or logged out. */ }
  }
  activeTasks.clear();
  await controls();
  const current = await page.request.get("/api/ai/status").catch(() => null);
  if (current?.ok()) await expect.poll(async () => {
    const response = await page.request.get("/api/ai/status");
    return !response.ok() || !(await response.json()).runtime.busy;
  }).toBe(true);
});

const photo = (name, buffer = imageA) => ({ name, mimeType: "image/png", buffer });
async function openImport(page) {
  await page.goto("/#tasks");
  await page.getByRole("region", { name: "图片任务", exact: true }).getByRole("button", { name: "导入图片", exact: true }).click();
  await expect(page.getByRole("heading", { name: "导入照片或截图", exact: true })).toBeVisible();
}
async function upload(page, files) {
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(files);
  await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
  return page.evaluate(() => location.hash.slice(7));
}
async function state(page, id) {
  const response = await page.request.get(`/api/image-tasks/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function submit(page, id) {
  activeTasks.add(id);
  await page.getByRole("button", { name: "识别并注音", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`#tasks/${id}$`));
  await expect(page.getByRole("region", { name: "任务状态", exact: true })).toBeVisible();
}
async function removeDocument(page, id) {
  if (!id) return;
  const response = await page.request.get(`/api/documents/${id}`);
  if (response.ok()) await page.request.delete(`/api/documents/${id}`, { data: { revision: (await response.json()).revision } });
}
async function saveAndRead(page) {
  await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
  await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
  const id = await page.evaluate(() => location.hash.slice(1));
  return (await page.request.get(`/api/documents/${id}`)).json();
}

// The second browser context uses a separate website login, not shared local state.
test("A上传后退出，B从同一草稿继续上传并提交，刷新后校对保存整批", async ({ page, browser }, info) => {
  await openImport(page);
  await page.getByLabel("新文章标题", { exact: true }).fill(`跨设备任务 ${info.project.name}`);
  const id = await upload(page, photo("设备A第一张.png"));
  const first = await state(page, id);
  expect(first.state).toBe("draft"); expect(first.items).toHaveLength(1);
  const secondContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319", viewport: info.project.name === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1000 }, isMobile: info.project.name === "phone", hasTouch: info.project.name === "phone", locale: "zh-CN" });
  let documentId;
  try {
    await ensureOwnerSession(secondContext.request);
    expect((await page.request.post("/api/session/logout", { data: {} })).ok()).toBe(true);
    cookies = [];
    await page.close();
    const other = await secondContext.newPage();
    await other.goto("/#tasks");
    const card = other.locator(`[data-task-id="${id}"]`);
    await card.getByRole("button", { name: "继续上传", exact: true }).click();
    await expect(other.getByLabel("新文章标题", { exact: true })).toHaveValue(`跨设备任务 ${info.project.name}`);
    await expect(other.locator(".source-sort-card[data-sort-image-id]")).toHaveCount(1);
    await upload(other, [photo("设备B第二张.png", imageB), photo("设备B第三张.png")]);
    const draft = await state(other, id);
    expect(draft.items).toHaveLength(3);
    expect(draft.items[0].imageId).toBe(first.items[0].imageId);
    await submit(other, id);
    await other.reload();
    await expect.poll(async () => (await state(other, id)).state).toBe("ready");
    await expect(other.getByRole("button", { name: "开始校对", exact: true })).toBeVisible();
    await expect(other.locator(".task-item-list li")).toHaveCount(3);
    expect(await other.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await other.screenshot({ path: `artifacts/image-task-status-${info.project.name}.png`, fullPage: true });
    await other.getByRole("button", { name: "开始校对", exact: true }).click();
    await expect(other.getByRole("textbox", { name: "日语正文", exact: true })).toBeVisible();
    const saved = await saveAndRead(other); documentId = saved.id;
    expect(saved.sourceImages.map((image) => image.id)).toEqual(draft.items.map((item) => item.imageId));
    expect((await state(other, id)).appliedDocumentId).toBe(saved.id);
    await other.goto(`/#tasks/${id}`);
    await expect(other.getByRole("button", { name: "打开文章", exact: true })).toBeVisible();
    await other.getByRole("button", { name: "打开文章", exact: true }).click();
    await expect(other.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
  } finally {
    if (documentId) {
      const stored = await secondContext.request.get(`/api/documents/${documentId}`);
      if (stored.ok()) await secondContext.request.delete(`/api/documents/${documentId}`, { data: { revision: (await stored.json()).revision } });
    }
    await secondContext.close();
  }
});

test("整批识别失败也可保留原图手动录入并保存，刷新能找回结果", async ({ page }, info) => {
  await controls({ ocrFailures: "permanent" });
  await openImport(page);
  const id = await upload(page, photo(`手动兜底-${info.project.name}.png`));
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 30000 }).toBe("needs_attention");
  await page.reload();
  await page.getByRole("button", { name: "手动录入正文", exact: true }).click();
  const input = page.getByRole("textbox", { name: "日语正文", exact: true });
  await expect(input).toHaveValue("");
  await input.fill("手で入力した日本語です。");
  const saved = await saveAndRead(page);
  try {
    expect(bodyText(saved.bodyHtml)).toBe("手で入力した日本語です。");
    expect(saved.sourceImages).toHaveLength(1);
    expect(bodyRanges(saved.bodyHtml).sources[0].id).toBe(saved.sourceImages[0].id);
    await page.reload();
    await expect(page.getByRole("article", { name: "日语原文", exact: true })).toContainText("手で入力した日本語です。");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await removeDocument(page, saved.id); }
});

test("注音持续失败可手工补充读音，识别正文与原图继续保留", async ({ page }, info) => {
  await controls({ annotationFailures: "permanent" });
  await openImport(page);
  const id = await upload(page, photo(`手动注音-${info.project.name}.png`));
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 30000 }).toBe("needs_attention");
  await page.getByRole("button", { name: "先校对正文／手动注音", exact: true }).click();
  await page.getByRole("tab", { name: /^注音校正/ }).click();
  const source = page.getByRole("textbox", { name: "选择要标注的字词", exact: true });
  await source.evaluate((element) => { const start = element.value.indexOf("背中"); element.focus(); element.setSelectionRange(start, start + 2); element.dispatchEvent(new Event("select", { bubbles: true })); });
  await source.press("Shift");
  await expect(page.locator(".selection-label")).toContainText("背中");
  await page.getByRole("textbox", { name: "假名读音", exact: true }).fill("せなか");
  await page.getByRole("button", { name: "添加注音", exact: true }).click();
  const saved = await saveAndRead(page);
  try {
    expect(saved.sourceImages).toHaveLength(1);
    const ruby = saved.blocks.flatMap((block) => block.segments).find((segment) => segment.text === "背中");
    expect(ruby.reading).toBe("せなか"); expect(ruby.origin).toBe("manual");
  } finally { await removeDocument(page, saved.id); }
});

test("任务可停止后续处理，已上传原图可直接转为手动录入", async ({ page }, info) => {
  await controls({ delayMs: 1200 });
  await openImport(page);
  const id = await upload(page, [photo(`停止-1-${info.project.name}.png`), photo(`停止-2-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await page.getByRole("button", { name: "停止后续处理", exact: true }).click();
  await expect.poll(async () => (await state(page, id)).state).toBe("cancelled");
  const stopped = await state(page, id);
  expect(stopped.counts.uploaded).toBe(2);
  await page.reload();
  await page.getByRole("button", { name: /手动录入正文|先校对正文／手动注音/ }).click();
  await expect(page.getByRole("textbox", { name: "日语正文", exact: true })).toBeVisible();
  expect(await page.getByAltText("用于校对正文和注音的日语原图", { exact: true }).count()).toBe(1);
  const current = await state(page, id);
  expect(current.state).toBe("cancelled"); expect(current.resultVersion).toBeTruthy();
  await expect.poll(async () => (await (await page.request.get("/api/ai/status")).json()).runtime.busy).toBe(false);
  const afterLateResult = await state(page, id);
  expect(afterLateResult.version).toBe(current.version);
  expect(afterLateResult.resultVersion).toBe(current.resultVersion);
  expect(afterLateResult.counts.completed).toBe(current.counts.completed);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/image-task-manual-${info.project.name}.png`, fullPage: true });
});

test("另一设备提交时保留本机未接纳文件，可另建草稿而不重传原图", async ({ page, browser }, info) => {
  await controls({ delayMs: 800 });
  await openImport(page);
  const id = await upload(page, photo(`已上传-${info.project.name}.png`));
  const existing = await state(page, id);
  const otherContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319", storageState: await page.context().storageState(), viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: "zh-CN" });
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const reserved = new Promise((resolve) => { reached = resolve; });
  try {
    const other = await otherContext.newPage();
    await other.goto(`/#tasks/${id}`);
    await expect(other.getByLabel("选择日语图片", { exact: true })).toBeVisible();
    await other.route(`**/api/image-tasks/${id}/items`, async (route) => { reached(); await held; await route.continue(); });
    await other.getByLabel("选择日语图片", { exact: true }).setInputFiles(photo(`本机保留-${info.project.name}.png`, imageB));
    await reserved;
    await submit(page, id);
    release();
    await expect(other.getByRole("button", { name: "将未上传图片另建草稿", exact: true })).toBeVisible();
    await expect(other.getByLabel("选择日语图片", { exact: true })).toBeDisabled();
    expect((await state(page, id)).items.map((item) => item.imageId)).toEqual(existing.items.map((item) => item.imageId));
    await other.getByRole("button", { name: "将未上传图片另建草稿", exact: true }).click();
    await expect(other.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
    const nextId = await other.evaluate(() => location.hash.slice(7));
    expect(nextId).not.toBe(id);
    const next = await state(other, nextId);
    expect(next.items).toHaveLength(1); expect(next.items[0].name).toBe(`本机保留-${info.project.name}.png`);
    expect(next.items[0].imageId).not.toBe(existing.items[0].imageId);
    expect((await state(page, id)).items).toHaveLength(1);
  } finally { release(); await otherContext.close(); }
});

test("创建草稿响应迟到不会在登录失效后导航或继续上传", async ({ page }, info) => {
  await openImport(page);
  let release, created;
  const held = new Promise((resolve) => { release = resolve; });
  let reached;
  const committed = new Promise((resolve) => { reached = resolve; });
  await page.route("**/api/image-tasks", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch(); created = await response.json(); reached();
    await held; await route.fulfill({ response });
  });
  let reservationRequests = 0;
  page.on("request", (request) => { if (/\/api\/image-tasks\/[^/]+\/items$/.test(new URL(request.url()).pathname)) reservationRequests++; });
  await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(photo(`迟到草稿-${info.project.name}.png`));
  await committed;
  const originalHash = await page.evaluate(() => location.hash);
  expect((await page.request.post("/api/session/logout", { data: {} })).ok()).toBe(true);
  cookies = [];
  await page.evaluate(() => window.dispatchEvent(new Event("yohaku:session-expired")));
  await expect(page.locator(".account-gate")).toBeVisible();
  const finished = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === "/api/image-tasks");
  release(); await finished;
  await expect(page.locator(".account-gate")).toBeVisible();
  expect(await page.evaluate(() => location.hash)).toBe(originalHash);
  expect(await page.evaluate(() => location.hash)).not.toContain(created.id);
  expect(reservationRequests).toBe(0);
});


test("部分手动补录后保留空图为待录入，空图不能请求注音", async ({ page }, info) => {
  await controls({ ocrFailures: "permanent" });
  await openImport(page);
  const id = await upload(page, [photo(`已补录-${info.project.name}.png`), photo(`仍待录入-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 30000 }).toBe("needs_attention");
  await page.getByRole("button", { name: "手动录入正文", exact: true }).click();
  const input = page.getByRole("textbox", { name: "日语正文", exact: true });
  await input.fill("第一张手工录入的正文。");
  const queue = page.getByRole("region", { name: "图片顺序", exact: true });
  await queue.locator(".source-sort-card").nth(1).click();
  await expect(input).toHaveValue("");
  await expect(queue.locator(".source-sort-item-status")).toHaveText(["待录入正文"]);
  await expect(page.getByText("有 1 张图片尚未录入正文。保存时会保留原图并标为待录入，也可逐张补录或移除。", { exact: true })).toBeVisible();
  await page.getByRole("tab", { name: /^注音校正/ }).click();
  await expect(page.getByRole("button", { name: "生成缺失注音", exact: true })).toBeDisabled();
  const saved = await saveAndRead(page);
  try {
    expect(saved.sourceImages).toHaveLength(2);
    expect(saved.sourceImages[0].manualRequired).toBe(false);
    expect(saved.sourceImages[1].manualRequired).toBe(true);
    await page.reload();
    await page.getByRole("button", { name: "校对文字与注音", exact: true }).click();
    await expect(page.getByRole("region", { name: "图片顺序", exact: true }).locator(".source-sort-item-status")).toContainText("待录入正文");
  } finally { await removeDocument(page, saved.id); }
});

test("目标版本冲突后继续校对再另存，保留最新手工内容及来源且移除旧问答标记", async ({ page }, info) => {
  const imageResponse = await page.request.post("/api/images", { multipart: { image: { name: `旧图-${info.project.name}.png`, mimeType: "image/png", buffer: imageA } } });
  expect(imageResponse.ok()).toBe(true);
  const oldImage = await imageResponse.json();
  expect((await page.request.post(`/api/images/${oldImage.id}/recognize`, { data: { engine: "llm" } })).ok()).toBe(true);
  const content = "{背中|せなか}を読む。";
  const creation = await page.request.post("/api/documents", { data: { title: `冲突原文章 ${info.project.name}`, kind: "article", orientation: "horizontal", content,
    bodyHtml: blocksToHtml(parseText(content), { sourceImageId: oldImage.id }), sourceImages: [{ id: oldImage.id }] } });
  expect(creation.ok()).toBe(true);
  let original = await creation.json(), copyId;
  try {
    expect((await page.request.post(`/api/documents/${original.id}/sentences`, { data: { revision: original.revision, bodyHash: original.bodyHash } })).ok()).toBe(true);
    original = await (await page.request.get(`/api/documents/${original.id}`)).json();
    const sentence = bodyRanges(original.bodyHtml).sentences[0];
    expect((await page.request.post(`/api/documents/${original.id}/conversations`, { data: { operation: "translation", selection: { start: 0, end: 2, text: "背中", bodyHash: original.bodyHash, sentenceIds: [sentence.id] } } })).ok()).toBe(true);
    original = await (await page.request.get(`/api/documents/${original.id}`)).json();
    expect(bodyRanges(original.bodyHtml).qa.length).toBeGreaterThan(0);
    await openImport(page);
    await page.getByLabel("图片所属文章", { exact: true }).selectOption(original.id);
    const id = await upload(page, photo(`新图-${info.project.name}.png`, imageB));
    await submit(page, id);
    await expect.poll(async () => (await state(page, id)).state).toBe("ready");
    await page.getByRole("button", { name: "开始校对", exact: true }).click();
    const input = page.getByRole("textbox", { name: "日语正文", exact: true });
    await input.fill("冲突前的手工校对。");
    const changed = await page.request.put(`/api/documents/${original.id}`, { data: { ...original, title: `其他设备已修改 ${info.project.name}` } });
    expect(changed.ok()).toBe(true);
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    await expect(page.getByRole("button", { name: "另存为新文章", exact: true })).toBeVisible();
    await expect(input).toHaveValue("冲突前的手工校对。");
    await input.fill("冲突之后继续手工校对的最新版。");
    await page.getByRole("button", { name: "另存为新文章", exact: true }).click();
    await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
    copyId = await page.evaluate(() => location.hash.slice(1));
    expect(copyId).not.toBe(original.id);
    const copy = await (await page.request.get(`/api/documents/${copyId}`)).json();
    expect(bodyText(copy.bodyHtml)).toContain("冲突之后继续手工校对的最新版。");
    expect(bodyText(copy.bodyHtml)).toContain("背中を読む。");
    expect(copy.sourceImages).toHaveLength(2);
    expect(copy.blocks.flatMap((block) => block.segments).some((segment) => segment.text === "背中" && segment.reading === "せなか")).toBe(true);
    expect(bodyRanges(copy.bodyHtml).qa).toHaveLength(0);
    const unchanged = await (await page.request.get(`/api/documents/${original.id}`)).json();
    expect(unchanged.title).toBe(`其他设备已修改 ${info.project.name}`);
    expect(bodyRanges(unchanged.bodyHtml).qa.length).toBeGreaterThan(0);
    expect(bodyText(unchanged.bodyHtml)).not.toContain("冲突之后");
  } finally { await removeDocument(page, copyId); await removeDocument(page, original.id); }
});


test("同任务两设备不同校对稿保存冲突后，B可保留最新版另存且A原文不变", async ({ page, browser }, info) => {
  await openImport(page);
  const id = await upload(page, [photo(`共享任务-1-${info.project.name}.png`), photo(`共享任务-2-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state).toBe("ready");
  await page.getByRole("button", { name: "开始校对", exact: true }).click();
  const otherContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319", storageState: await page.context().storageState(),
    viewport: info.project.name === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: info.project.name === "phone", hasTouch: info.project.name === "phone", locale: "zh-CN", timezoneId: "Europe/Paris" });
  let savedA, copyId;
  try {
    const other = await otherContext.newPage();
    await other.goto(`/#tasks/${id}`);
    await other.getByRole("button", { name: "开始校对", exact: true }).click();
    const inputA = page.getByRole("textbox", { name: "日语正文", exact: true });
    const inputB = other.getByRole("textbox", { name: "日语正文", exact: true });
    await inputA.fill("A设备保留的日本語。");
    await inputB.fill("B设备第一版的日本語。");
    savedA = await saveAndRead(page);
    expect((await state(page, id)).appliedDocumentId).toBe(savedA.id);
    const rejected = other.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/image-tasks/${id}/apply`);
    await other.getByRole("button", { name: "保存并阅读", exact: true }).click();
    expect((await rejected).status()).toBe(409);
    await expect(inputB).toHaveValue("B设备第一版的日本語。");
    await expect(other.getByRole("button", { name: "另存为新文章", exact: true })).toBeVisible();
    await inputB.fill("B冲突后继续校对的日本語。");
    await other.getByRole("tab", { name: /^注音校正/ }).click();
    const source = other.getByRole("textbox", { name: "选择要标注的字词", exact: true });
    await source.evaluate((element) => { const start = element.value.indexOf("日本語"); element.focus(); element.setSelectionRange(start, start + 3); element.dispatchEvent(new Event("select", { bubbles: true })); });
    await source.press("Shift");
    await expect(other.locator(".selection-label")).toContainText("日本語");
    await other.getByRole("textbox", { name: "假名读音", exact: true }).fill("にほんご");
    await other.getByRole("button", { name: "添加注音", exact: true }).click();
    await other.getByRole("button", { name: "另存为新文章", exact: true }).click();
    await expect(other.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
    copyId = await other.evaluate(() => location.hash.slice(1));
    expect(copyId).not.toBe(savedA.id);
    const copy = await (await other.request.get(`/api/documents/${copyId}`)).json();
    expect(bodyText(copy.bodyHtml)).toContain("B冲突后继续校对的日本語。");
    expect(bodyText(copy.bodyHtml)).not.toContain("B设备第一版");
    const readings = copy.blocks.flatMap((block) => block.segments);
    expect(readings.some((segment) => segment.text === "日本語" && segment.reading === "にほんご" && segment.origin === "manual")).toBe(true);
    expect(readings.some((segment) => segment.origin === "generated" && segment.reading)).toBe(true);
    expect(copy.sourceImages.map((image) => image.id)).toEqual(savedA.sourceImages.map((image) => image.id));
    const original = await (await page.request.get(`/api/documents/${savedA.id}`)).json();
    expect(bodyText(original.bodyHtml)).toBe(bodyText(savedA.bodyHtml));
    expect(original.blocks.flatMap((block) => block.segments).filter((segment) => segment.reading).map(({ text, reading, origin }) => ({ text, reading, origin })))
      .toEqual(savedA.blocks.flatMap((block) => block.segments).filter((segment) => segment.reading).map(({ text, reading, origin }) => ({ text, reading, origin })));
    expect((await state(page, id)).appliedDocumentId).toBe(savedA.id);
  } finally { await removeDocument(page, copyId); await removeDocument(page, savedA?.id); await otherContext.close(); }
});
