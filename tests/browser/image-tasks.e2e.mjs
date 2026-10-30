// Real HTTP, uploads, SQLite and browser sessions; AI replies are explicit doubles.
import { test, expect } from "@playwright/test";
import { readFile, writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { ensureOwnerSession } from "./session.mjs";
import { discardFixtureTasks } from "./image-task-fixture.mjs";
import { parseText } from "../../shared/document.mjs";
import { bodyText, bodyRanges, blocksToHtml, hasCompleteSentenceBoundaries } from "../../shared/article-html.mjs";

const controlFile = new URL("../../artifacts/ai-e2e-data/image-runtime-controls.json", import.meta.url);
let cookies = [], imageA, imageB;
const activeTasks = new Set();
const controls = async (value = {}) => {
  const temporary = new URL("./image-runtime-controls.tasks.tmp", controlFile);
  await writeFile(temporary, JSON.stringify({ ocrFailures: 0, annotationFailures: 0, delayMs: 0, ...value }));
  await rename(temporary, controlFile);
};
const runtimeCalls = async () => {
  try { return JSON.parse(await readFile(new URL("./runtime-calls.json", controlFile), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
};


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
  // Fixture teardown never bypasses product policy through a public route.
  discardFixtureTasks(activeTasks);
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
  const id = await page.evaluate(() => location.hash.slice(7));
  activeTasks.add(id);
  return id;
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
    expect(saved.title).toBe(`跨设备任务 ${info.project.name}`);
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
    cookies = await secondContext.cookies();
    await page.context().addCookies(cookies);
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

test("运行中禁止暂停和删除，只有出错暂停后才能人工处理或删除", async ({ page }, info) => {
  await controls({ ocrFailures: "permanent", delayMs: 500 });
  await openImport(page);
  const id = await upload(page, [photo(`出错-1-${info.project.name}.png`), photo(`出错-2-${info.project.name}.png`, imageB)]);
  await expect(page.getByRole("button", { name: "放弃导入草稿", exact: true })).toHaveCount(0);
  const draft = await state(page, id);
  expect(draft.canPause).toBe(false); expect(draft.canDelete).toBe(false);
  expect((await page.request.delete(`/api/image-tasks/${id}`, { data: { version: draft.version } })).status()).toBe(409);
  await submit(page, id);
  await expect(page.getByRole("button", { name: /手动录入正文|先校对正文／手动注音|开始校对/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "暂停任务", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "删除任务", exact: true })).toHaveCount(0);
  const processing = await state(page, id);
  expect(processing.canDelete).toBe(false); expect(processing.canPause).toBe(false);
  for (const operation of ["pause", "cancel"]) {
    expect((await page.request.post(`/api/image-tasks/${id}/${operation}`, { data: { version: processing.version } })).status()).toBe(409);
  }
  expect((await page.request.delete(`/api/image-tasks/${id}`, { data: { version: processing.version } })).status()).toBe(409);
  expect((await page.request.post(`/api/image-tasks/${id}/cancel`, { data: { version: processing.version, freezeResult: true } })).status()).toBe(409);
  expect((await page.request.post(`/api/images/${processing.items[0].imageId}/annotate`, { data: { content: "日本語" } })).status()).toBe(409);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 20000 }).toBe("needs_attention");
  const failed = await state(page, id);
  expect(failed.canDelete).toBe(true); expect(failed.canPause).toBe(false);
  expect(failed.counts.uploaded).toBe(2);
  await page.reload();
  await expect(page.getByRole("button", { name: "删除任务", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "手动录入正文", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "日语正文", exact: true })).toBeVisible();
  const current = await state(page, id);
  expect(current.state).toBe("needs_attention"); expect(current.resultVersion).toBeTruthy();
  expect(current.canDelete).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: `artifacts/image-task-manual-${info.project.name}.png`, fullPage: true });
  const leaveEditor = (dialog) => dialog.accept();
  page.on("dialog", leaveEditor);
  try { await page.getByRole("button", { name: "取消", exact: true }).click(); }
  finally { page.off("dialog", leaveEditor); }
  await expect(page.getByRole("region", { name: "任务状态", exact: true })).toBeVisible();
  page.once("dialog", (dialog) => { expect(dialog.message()).toContain("删除任务"); return dialog.accept(); });
  await page.getByRole("button", { name: "删除任务", exact: true }).click();
  await expect(page.getByRole("region", { name: "图片任务", exact: true })).toBeVisible();
  expect((await page.request.get(`/api/image-tasks/${id}`)).status()).toBe(404);
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
    activeTasks.add(nextId);
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
    const response = await route.fetch(); created = await response.json(); activeTasks.add(created.id); reached();
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
  await ensureOwnerSession(page.request); cookies = await page.context().cookies();
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

test("无当前任务隐藏入口，草稿具备可辨名称，保存后归档且可从导入页找回", async ({ page, browser }, info) => {
  // A separate real website account starts with no tasks; never remove the
  // shared fixture owner's history merely to obtain an empty-state assertion.
  const invitation = await page.request.post("/api/invitations", { data: {} });
  expect(invitation.ok()).toBe(true);
  const memberContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319",
    viewport: info.project.name === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: info.project.name === "phone", hasTouch: info.project.name === "phone", locale: "zh-CN", timezoneId: "Europe/Paris" });
  const owned = new Set();
  let savedId, secondSavedId;
  try {
    const registered = await memberContext.request.post("/api/accounts/register", { data: {
      username: `task_${info.project.name}_${Date.now().toString(36)}`,
      password: "fixture-task-account-password", inviteToken: (await invitation.json()).token,
    } });
    expect(registered.status()).toBe(201);
    const member = await memberContext.newPage();
    await member.goto("/");
    await expect(member.getByRole("region", { name: "阅读首页", exact: true })).toBeVisible();
    await expect(member.locator(".home-task-card")).toHaveCount(0);
    await expect(member.locator(".sidebar-task-link")).toHaveCount(0);

    const createEmpty = async () => {
      const response = await member.request.post("/api/image-tasks", { data: { idempotencyKey: randomUUID() } });
      expect(response.status()).toBe(201);
      const task = await response.json(); owned.add(task.id); return task;
    };
    const first = await createEmpty(), second = await createEmpty();
    await expect(member.locator(".home-task-card")).toBeVisible();
    await expect(member.locator(".sidebar-task-link")).toHaveCount(1);
    await member.locator(".home-task-card").click();
    const firstCard = member.locator(`[data-task-id="${first.id}"]`);
    const secondCard = member.locator(`[data-task-id="${second.id}"]`);
    await expect(firstCard).toBeVisible(); await expect(secondCard).toBeVisible();
    const firstName = await firstCard.locator(".task-title-button").innerText();
    const secondName = await secondCard.locator(".task-title-button").innerText();
    for (const name of [firstName, secondName]) {
      expect(name).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
      expect(name).toMatch(/#[A-Za-z0-9]{6,}/);
      expect(name).not.toMatch(/图片导入|图片文章|未命名任务/);
    }
    expect(firstName).not.toBe(secondName);

    await secondCard.getByRole("button", { name: "继续上传", exact: true }).click();
    await expect(member.getByRole("button", { name: "放弃导入草稿", exact: true })).toHaveCount(0);
    expect((await member.request.delete(`/api/image-tasks/${second.id}`, { data: { version: second.version } })).status()).toBe(409);
    await upload(member, photo("另一份独立材料.png"));
    await submit(member, second.id);
    await expect.poll(async () => (await state(member, second.id)).state).toBe("ready");
    const readySecond = await state(member, second.id);
    expect(readySecond.canDelete).toBe(false); expect(readySecond.canPause).toBe(false);
    await expect(member.getByRole("button", { name: "删除任务", exact: true })).toHaveCount(0);
    expect((await member.request.delete(`/api/image-tasks/${second.id}`, { data: { version: readySecond.version } })).status()).toBe(409);
    await member.getByRole("button", { name: "开始校对", exact: true }).click();
    secondSavedId = (await saveAndRead(member)).id;
    await member.goto("/#tasks");
    await firstCard.getByRole("button", { name: "继续上传", exact: true }).click();
    expect(await upload(member, [photo("森林散步第一页.png"), photo("森林散步第二页.png", imageB)])).toBe(first.id);
    await member.goto("/#tasks");
    await expect(firstCard.locator(".task-title-button")).toContainText("森林散步第一页.png");
    await expect(firstCard.locator(".task-title-button")).toContainText(/2\s*张/);
    await firstCard.getByRole("button", { name: "继续上传", exact: true }).click();
    await submit(member, first.id);
    await expect.poll(async () => (await state(member, first.id)).state).toBe("ready");
    await member.goto("/#tasks");
    await expect(firstCard.locator(".task-state")).toHaveText("待校对");
    await member.goto("/");
    await expect(member.locator(".home-task-card")).toBeVisible();
    await expect(member.locator(".sidebar-task-link")).toHaveCount(1);

    await member.goto(`/#tasks/${first.id}`);
    await member.getByRole("button", { name: "开始校对", exact: true }).click();
    const saved = await saveAndRead(member); savedId = saved.id;
    expect(saved.title).not.toMatch(/#|\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/);
    await expect(member.locator(".sidebar-task-link")).toHaveCount(0);
    await member.goto("/");
    await expect(member.getByRole("region", { name: "阅读首页", exact: true })).toBeVisible();
    await expect(member.locator(".home-task-card")).toHaveCount(0);
    await expect(member.locator(".sidebar-task-link")).toHaveCount(0);
    const active = await (await member.request.get("/api/image-tasks")).json();
    expect(active.activeCount).toBe(0); expect(active.total).toBe(0); expect(active.tasks).toEqual([]);

    await openImport(member);
    await member.getByRole("button", { name: "任务与归档", exact: true }).click();
    await member.getByRole("tab", { name: "已归档", exact: true }).click();
    await expect(firstCard).toBeVisible();
    await firstCard.getByRole("button", { name: "打开文章", exact: true }).click();
    await expect(member.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
    await member.goto(`/#tasks/${first.id}`);
    await expect(member.getByRole("button", { name: "打开文章", exact: true })).toBeVisible();
    const archived = await state(member, first.id);
    expect(archived.canDelete).toBe(false); expect(archived.canPause).toBe(false);
    await expect(member.getByRole("button", { name: "删除任务", exact: true })).toHaveCount(0);
    expect((await member.request.delete(`/api/image-tasks/${first.id}`, { data: { version: archived.version } })).status()).toBe(409);
    expect((await member.request.get(`/api/documents/${savedId}`)).ok()).toBe(true);
    expect(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally {
    discardFixtureTasks(owned);
    for (const documentId of [savedId, secondSavedId].filter(Boolean)) {
      const response = await memberContext.request.get(`/api/documents/${documentId}`);
      if (response.ok()) await memberContext.request.delete(`/api/documents/${documentId}`, { data: { revision: (await response.json()).revision } });
    }
    await memberContext.close();
  }
});

test("另一设备重试出错任务只补失败步骤，旧手动稿保存失败且内容保留", async ({ page, browser }, info) => {
  const cursor = (await runtimeCalls()).at(-1)?.sequence || 0;
  await controls({ annotationFailures: "permanent", delayMs: 50 });
  await openImport(page);
  const id = await upload(page, [photo(`继续-1-${info.project.name}.png`), photo(`继续-2-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 20000 }).toBe("needs_attention");
  const paused = await state(page, id);
  expect(paused.items[0].steps.recognize.state).toBe("succeeded");
  await page.getByRole("button", { name: "先校对正文／手动注音", exact: true }).click();
  const input = page.getByRole("textbox", { name: "日语正文", exact: true });
  const manualText = `出错后人工校对，需要手动保留的正文 ${info.project.name}。`;
  await input.fill(manualText);
  const fixed = await state(page, id);
  expect(fixed.resultVersion).toBeTruthy();

  const otherContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319", storageState: await page.context().storageState(),
    viewport: info.project.name === "phone" ? { width: 390, height: 844 } : { width: 1440, height: 1000 },
    isMobile: info.project.name === "phone", hasTouch: info.project.name === "phone", locale: "zh-CN", timezoneId: "Europe/Paris" });
  try {
    const other = await otherContext.newPage();
    await other.goto(`/#tasks/${id}`);
    await controls({ annotationFailures: "permanent", delayMs: 200 });
    await other.getByRole("button", { name: "重试失败步骤", exact: true }).click();
    const rejected = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/image-tasks/${id}/apply`);
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    const response = await rejected;
    expect(response.status()).toBe(409);
    expect((await response.json()).code).toBe("TASK_RESULT_STALE");
    await expect(input).toHaveValue(manualText);
    await expect(page.getByText(/请先手动复制留存/).first()).toBeVisible();
    await expect(page.getByRole("button", { name: "另存为新文章", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await state(other, id)).state, { timeout: 20000 }).toBe("needs_attention");
    const completed = await state(other, id);
    expect(completed.items[0].steps.recognize).toEqual(paused.items[0].steps.recognize);
    expect((await runtimeCalls()).filter((call) => call.sequence > cursor && call.phase === "recognize")).toHaveLength(2);
    await expect(input).toHaveValue(manualText);
    expect(completed.resultVersion).not.toBe(fixed.resultVersion);
    expect(completed.appliedDocumentId).toBeNull();
    const removed = await other.request.delete(`/api/image-tasks/${id}`, { data: { version: completed.version } });
    expect(removed.ok()).toBe(true);
    const deletedSave = page.waitForResponse((result) => result.request().method() === "POST" && new URL(result.url()).pathname === `/api/image-tasks/${id}/apply`);
    await page.getByRole("button", { name: "保存并阅读", exact: true }).click();
    const unavailable = await deletedSave;
    expect(unavailable.status()).toBe(404);
    expect((await unavailable.json()).code).toBe("TASK_UNAVAILABLE");
    await expect(input).toHaveValue(manualText);
    await expect(page.getByText("任务已删除或无法访问，当前编辑内容仍保留在本页。请手动复制留存，或通过导入文字新建文章。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "另存为新文章", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await otherContext.close(); }
});

test("另一设备也不能删除或暂停上传草稿，本机继续上传仍属于原任务", async ({ page, browser }, info) => {
  await openImport(page);
  const title = `草稿不能删除 ${info.project.name}`;
  await page.getByLabel("新文章标题", { exact: true }).fill(title);
  const id = await upload(page, photo(`本机已上传-${info.project.name}.png`));
  const original = await state(page, id);
  const otherContext = await browser.newContext({ baseURL: "http://127.0.0.1:4319", storageState: await page.context().storageState() });
  try {
    expect(original.canDelete).toBe(false); expect(original.canPause).toBe(false);
    expect((await otherContext.request.delete(`/api/image-tasks/${id}`, { data: { version: original.version } })).status()).toBe(409);
    for (const operation of ["pause", "cancel"]) {
      expect((await otherContext.request.post(`/api/image-tasks/${id}/${operation}`, { data: { version: original.version } })).status()).toBe(409);
    }
    await expect(page.getByRole("button", { name: "放弃导入草稿", exact: true })).toHaveCount(0);
    await page.getByLabel("选择日语图片", { exact: true }).setInputFiles(photo(`本机继续上传-${info.project.name}.png`, imageB));
    await expect(page.getByRole("button", { name: "识别并注音", exact: true })).toBeEnabled();
    expect(await page.evaluate(() => location.hash.slice(7))).toBe(id);
    const continued = await state(page, id);
    expect(continued.state).toBe("draft"); expect(continued.title).toBe(title);
    expect(continued.items.map((item) => item.name)).toEqual([`本机已上传-${info.project.name}.png`, `本机继续上传-${info.project.name}.png`]);
    expect(continued.items[0].imageId).toBe(original.items[0].imageId);
    expect(continued.counts.uploaded).toBe(2);
    await expect(page.getByRole("button", { name: "将本机图片另建草稿", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await otherContext.close(); }
});

test("全部图片识别注音后继续显示整批分句，分句完成才进入待校对", async ({ page }, info) => {
  const cursor = (await runtimeCalls()).at(-1)?.sequence || 0;
  const text = `整批分句等待${info.project.name}${Date.now()}。次の文です。`;
  await controls({ ocrText: text, sentenceDelayMs: 4000 });
  await openImport(page);
  const id = await upload(page, [photo(`分句-1-${info.project.name}.png`), photo(`分句-2-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await expect.poll(async () => {
    const task = await state(page, id);
    return task.counts.completed === 2 && task.segmentation.state === "running";
  }, { timeout: 20000 }).toBe(true);
  const segmenting = await state(page, id);
  expect(segmenting.phase).toBe("segment"); expect(segmenting.state).toBe("running");
  expect(segmenting.canReview).toBe(false); expect(segmenting.canDelete).toBe(false);
  expect((await page.request.get(`/api/image-tasks/${id}/result`)).status()).toBe(409);
  await page.reload();
  await expect(page.locator('[data-task-phase="segment"]')).toContainText("正在整批分句");
  await expect(page.getByRole("button", { name: "开始校对", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "删除任务", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 20000 }).toBe("ready");
  await expect(page.getByRole("button", { name: "开始校对", exact: true })).toBeVisible();
  const ready = await state(page, id);
  expect(ready.segmentation.state).toBe("succeeded"); expect(ready.segmentation.hasResult).toBe(true);
  const response = await page.request.get(`/api/image-tasks/${id}/result`);
  expect(response.ok()).toBe(true);
  const result = await response.json();
  expect(result.initializeSentences).toBe(false);
  expect(result.sourceImages).toHaveLength(2);
  expect(hasCompleteSentenceBoundaries(result.bodyHtml)).toBe(true);
  const calls = (await runtimeCalls()).filter((call) => call.sequence > cursor);
  expect(calls.filter((call) => call.phase === "recognize")).toHaveLength(2);
  expect(calls.filter((call) => call.phase === "annotate")).toHaveLength(2);
  const sentences = calls.filter((call) => call.phase === "sentences");
  expect(sentences).toHaveLength(1);
  expect(JSON.parse(sentences[0].prompt.split("\n输入正文：\n").at(-1))).toBe(bodyText(result.bodyHtml));
});

test("整批分句失败可删除或只重试分句，不重做成功的识别注音", async ({ page }, info) => {
  const cursor = (await runtimeCalls()).at(-1)?.sequence || 0;
  const text = `分句失败后重试${info.project.name}${Date.now()}。結果を保ちます。`;
  await controls({ ocrText: text, sentenceFailures: "permanent" });
  await openImport(page);
  const id = await upload(page, [photo(`重试分句-1-${info.project.name}.png`), photo(`重试分句-2-${info.project.name}.png`, imageB)]);
  await submit(page, id);
  await expect.poll(async () => (await state(page, id)).state, { timeout: 20000 }).toBe("needs_attention");
  const failed = await state(page, id);
  expect(failed.phase).toBe("segment"); expect(failed.segmentation.state).toBe("failed");
  expect(failed.counts.completed).toBe(2); expect(failed.canDelete).toBe(true);
  await page.reload();
  await expect(page.locator('[data-task-phase="segment"]')).toContainText("识别与注音结果已保留");
  await expect(page.getByRole("button", { name: "删除任务", exact: true })).toBeVisible();
  const beforeRetry = (await runtimeCalls()).filter((call) => call.sequence > cursor);
  const imageSteps = failed.items.map((item) => ({ recognize: item.steps.recognize, annotate: item.steps.annotate }));
  await controls({ ocrText: text });
  await page.getByRole("button", { name: "重试分句", exact: true }).click();
  await expect.poll(async () => (await state(page, id)).state, { timeout: 20000 }).toBe("ready");
  const ready = await state(page, id);
  expect(ready.items.map((item) => ({ recognize: item.steps.recognize, annotate: item.steps.annotate }))).toEqual(imageSteps);
  expect(ready.segmentation.state).toBe("succeeded");
  const afterRetry = (await runtimeCalls()).filter((call) => call.sequence > cursor);
  expect(afterRetry.filter((call) => call.type === "image")).toEqual(beforeRetry.filter((call) => call.type === "image"));
  expect(afterRetry.filter((call) => call.phase === "sentences")).toHaveLength(beforeRetry.filter((call) => call.phase === "sentences").length + 1);
});
