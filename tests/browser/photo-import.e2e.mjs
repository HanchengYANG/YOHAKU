import { test, expect } from "@playwright/test";
import sharp from "sharp";

// Photo import (§4.1) against an in-memory import API. Each picture is uploaded
// as soon as it is chosen; the server draft is then edited picture by picture.
async function photoFixture(page, { books = [{ id: "bk", title: "读书笔记", pages: [] }], suggestedType = null, failAppendOnce = false, savedDraft = null } = {}) {
  const colors = ["#d9c7a3", "#a3c2d9", "#c9d9a3", "#d9a3b8"];
  const pngs = await Promise.all(colors.map((background) => sharp({ create: { width: 300, height: 400, channels: 3, background } }).png().toBuffer()));
  const state = { calls: [], next: 0, failAppend: failAppendOnce, draft: null };
  const file = () => { const n = ++state.next; return { id: `f${n}`, name: `photo-${n}.png`, type: "photo", previewUrl: `/fixture/photo-${n}.png` }; };
  if (savedDraft) state.draft = { title: savedDraft.title, files: Array.from({ length: savedDraft.count }, file) };
  const present = () => ({ id: "imp", title: state.draft.title, status: "staged", detectedType: "photo", allowedTypes: ["photo", "screenshot"],
    ...(suggestedType ? { suggestedType } : {}), files: state.draft.files, context: { bookId: null, targetId: null }, createdAt: "2026-11-07T08:00:00Z" });
  const multipart = (request) => request.postDataBuffer()?.toString("latin1") || "";
  const uploadedCount = (request) => (multipart(request).match(/filename="/g) || []).length;
  await page.route(/\/fixture\/photo-(\d+)\.png/, (route) => {
    const n = Number(route.request().url().match(/photo-(\d+)\.png/)[1]);
    return route.fulfill({ contentType: "image/png", body: pngs[(n - 1) % pngs.length] });
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request(), url = new URL(request.url()), path = url.pathname.slice(4), method = request.method();
    let input = null; try { input = request.postDataJSON(); } catch { /* multipart */ }
    state.calls.push({ path, method, input });
    const respond = (value, status = 200) => route.fulfill({ status, json: value });
    if (path === "/session") return respond({ user: { id: "user", username: "reader", isAdmin: false }, needsSetup: false });
    if (path === "/documents") return respond({ documents: [] });
    if (path === "/books" && method === "GET") return respond({ books });
    if (path === "/books" && method === "POST") return respond({ id: "new-book", title: input.title, pages: [], revision: 1 }, 201);
    if (path.startsWith("/tasks") || path.startsWith("/image-tasks")) return respond({ counts: {}, tasks: [] });
    if (path === "/imports" && method === "GET") return respond({ drafts: state.draft ? [present()] : [] });
    if (path === "/imports" && method === "POST") {
      const title = multipart(request).match(/name="title"\r\n\r\n([^\r]*)/)?.[1];
      state.draft = { title: Buffer.from(title || "", "latin1").toString("utf8"), files: Array.from({ length: uploadedCount(request) }, file) };
      return respond(present(), 201);
    }
    if (path === "/imports/imp" && method === "GET") return respond(present());
    if (path === "/imports/imp/files" && method === "POST") {
      if (state.failAppend) { state.failAppend = false; return respond({ error: "网络不稳定，请重试。" }, 503); }
      state.draft.files.push(...Array.from({ length: uploadedCount(request) }, file));
      return respond(present());
    }
    if (path === "/imports/imp/files" && method === "PUT") {
      state.draft.files = input.order.map((id) => state.draft.files.find((item) => item.id === id));
      return respond(present());
    }
    const match = path.match(/^\/imports\/imp\/files\/(f\d+)(\/rotate)?$/);
    if (match && method === "DELETE") { state.draft.files = state.draft.files.filter((item) => item.id !== match[1]); return respond(present()); }
    if (match?.[2]) {
      const item = state.draft.files.find((entry) => entry.id === match[1]);
      item.turns = (item.turns || 0) + input.turns;
      item.previewUrl = `${item.previewUrl.split("?")[0]}?v=${state.calls.length}`;
      return respond(present());
    }
    if (path === "/imports/imp/confirm") return respond({ id: "imp", documents: [{ id: "doc" }], firstDocumentId: "doc" }, 201);
    if (path === "/documents/doc") return respond({ id: "doc", title: "照片文章", kind: "article", sourceWorkflow: true, bodyHtml: "<p></p>", blocks: [], revision: 1, updatedAt: "2026-11-07T08:00:00Z" });
    if (path.startsWith("/documents/doc/")) return respond(path.endsWith("/conversations") ? { conversations: [] } : { sessionId: "s", pages: [], currentPage: null, index: 0, position: 0, complete: false, hasNext: false });
    return respond({ error: `Missing fixture ${method} ${path}` }, 404);
  });
  const calls = (method, path) => state.calls.filter((call) => call.method === method && call.path === path);
  return { state, calls, png: pngs[0] };
}
const picture = (png, name) => ({ name, mimeType: "image/png", buffer: png });
const thumbs = (page) => page.getByRole("list", { name: "照片顺序", exact: true }).getByRole("button", { name: /^第 \d+ 张照片$/ });

test("photos upload one by one, turn, move and delete, then go into the last book", { tag: "@phone" }, async ({ page }, info) => {
  const { calls, png } = await photoFixture(page);
  await page.addInitScript(() => localStorage.setItem("yohaku.photoTarget", "bk"));
  await page.goto("/");
  await page.getByLabel("拍照添加照片", { exact: true }).setInputFiles(picture(png, "first.png"));
  const photos = page.getByRole("region", { name: "拍照添加", exact: true });
  await expect(photos).toBeVisible();
  await page.getByLabel("从相册选择", { exact: true }).setInputFiles([picture(png, "second.png"), picture(png, "third.png")]);
  await expect(thumbs(page)).toHaveCount(3);
  expect(calls("POST", "/imports")).toHaveLength(1);
  expect(calls("POST", "/imports/imp/files")).toHaveLength(2);
  const title = page.getByLabel("标题", { exact: true });
  await expect(title).toHaveValue("");
  const placeholder = await title.getAttribute("placeholder");
  expect(placeholder).toMatch(/^\d+月\d+日 · 照片$/);
  await expect(page.getByRole("button", { name: /^来源类型：照片/ })).toBeVisible();
  await expect(page.getByLabel("放进", { exact: true })).toHaveValue("bk");
  await page.screenshot({ path: `artifacts/photo-import-${info.project.name}.png` });

  await thumbs(page).nth(1).click();
  const sheet = page.getByRole("dialog", { name: "第 2 张照片", exact: true });
  await sheet.getByRole("button", { name: "向右转", exact: true }).click();
  await expect.poll(() => calls("POST", "/imports/imp/files/f2/rotate").map((call) => call.input)).toEqual([{ turns: 1 }]);
  await sheet.getByRole("button", { name: "前移", exact: true }).click();
  await expect.poll(() => calls("PUT", "/imports/imp/files").map((call) => call.input.order)).toEqual([["f2", "f1", "f3"]]);
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await thumbs(page).nth(2).click();
  await page.getByRole("dialog", { name: "第 3 张照片", exact: true }).getByRole("button", { name: "删除", exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
  expect(calls("DELETE", "/imports/imp/files/f3")).toHaveLength(1);

  await page.getByRole("button", { name: "完成 · 2 张", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已添加，正在识别", exact: true })).toBeVisible();
  expect(calls("POST", "/imports/imp/confirm")[0].input).toEqual({ type: "photo", title: placeholder, bookId: "bk" });
  await expect(page.getByRole("button", { name: "再拍一篇", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "查看进度", exact: true }).click();
  await expect(page).toHaveURL(/#doc$/);
});

test("pictures chosen on the add page go to the photo page and keep a suggested screenshot type until changed", async ({ page }) => {
  const { calls, png } = await photoFixture(page, { suggestedType: "screenshot" });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "打开书架", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByLabel("上传或粘贴来源文件").evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "pasted.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, clipboardData: transfer }));
  }, [...png]);
  await expect(thumbs(page)).toHaveCount(1);
  const type = page.getByRole("button", { name: /^来源类型：/ });
  await expect(type).toHaveText("截图");
  await type.click();
  await expect(type).toHaveText("照片");
  await expect(page.getByLabel("放进", { exact: true })).toHaveValue("article");
  await page.getByLabel("标题", { exact: true }).fill("课本第 3 课");
  await page.getByRole("button", { name: "完成 · 1 张", exact: true }).click();
  await expect(page.getByRole("heading", { name: "已添加，正在识别", exact: true })).toBeVisible();
  expect(calls("POST", "/imports/imp/confirm")[0].input).toEqual({ type: "photo", title: "课本第 3 课" });
});

test("an unfinished photo draft continues on the photo page", async ({ page }) => {
  await photoFixture(page, { savedDraft: { title: "上次的照片", count: 2 } });
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "打开书架", exact: true });
  if (await toggle.isVisible()) await toggle.click();
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("button", { name: /^继续导入：上次的照片/ }).click();
  await expect(page.getByRole("region", { name: "拍照添加", exact: true })).toBeVisible();
  await expect(thumbs(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "完成 · 2 张", exact: true })).toBeEnabled();
});

test("a failed upload stays as a picture that can be retried before finishing", async ({ page }) => {
  const { calls, png } = await photoFixture(page, { failAppendOnce: true });
  await page.goto("/");
  await page.getByLabel("拍照添加照片", { exact: true }).setInputFiles(picture(png, "first.png"));
  await expect(thumbs(page)).toHaveCount(1);
  await page.getByLabel("从相册选择", { exact: true }).setInputFiles(picture(png, "second.png"));
  await expect(page.getByRole("alert")).toContainText("网络不稳定");
  await expect(page.getByRole("button", { name: "完成 · 2 张", exact: true })).toBeDisabled();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(thumbs(page)).toHaveCount(2);
  await expect(page.getByRole("button", { name: "完成 · 2 张", exact: true })).toBeEnabled();
  expect(calls("POST", "/imports/imp/files")).toHaveLength(2);
});

test("a long press enters sorting and dragging a photo saves the new order", async ({ page }) => {
  const { calls, png } = await photoFixture(page);
  await page.goto("/");
  await page.getByLabel("拍照添加照片", { exact: true }).setInputFiles(picture(png, "first.png"));
  await page.getByLabel("从相册选择", { exact: true }).setInputFiles([picture(png, "second.png"), picture(png, "third.png")]);
  await expect(thumbs(page)).toHaveCount(3);
  const center = async (index) => { const box = await thumbs(page).nth(index).boundingBox(); return [box.x + box.width / 2, box.y + box.height / 2]; };
  const [x0, y0] = await center(0);
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.waitForTimeout(600); await page.mouse.up();
  await expect(page.getByRole("status").filter({ hasText: "拖动照片调整顺序" })).toBeVisible();
  const [x2, y2] = await center(2);
  await page.mouse.move(x0, y0); await page.mouse.down(); await page.mouse.move(x2, y2, { steps: 6 }); await page.mouse.up();
  await expect.poll(() => calls("PUT", "/imports/imp/files").map((call) => call.input.order)).toEqual([["f2", "f3", "f1"]]);
  await page.getByRole("button", { name: "完成排序", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "拖动照片调整顺序" })).toHaveCount(0);
});

test("a new book is created first when the photos go into a new book", async ({ page }) => {
  const { calls, png } = await photoFixture(page);
  await page.goto("/");
  await page.getByLabel("拍照添加照片", { exact: true }).setInputFiles(picture(png, "first.png"));
  await expect(thumbs(page)).toHaveCount(1);
  await page.getByLabel("放进", { exact: true }).selectOption("new");
  const finish = page.getByRole("button", { name: "完成 · 1 张", exact: true });
  await expect(finish).toBeDisabled();
  await page.getByLabel("新书籍名称", { exact: true }).fill("旅行日记");
  await finish.click();
  await expect(page.getByRole("heading", { name: "已添加，正在识别", exact: true })).toBeVisible();
  expect(calls("POST", "/books")[0].input).toEqual({ title: "旅行日记" });
  expect(calls("POST", "/imports/imp/confirm")[0].input).toMatchObject({ bookId: "new-book" });
});
