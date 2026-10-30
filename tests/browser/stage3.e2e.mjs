import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { bodyRanges, bodyText } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";
import { selectArticleText } from "./article-selection.mjs";

let cookies = [];
test.beforeEach(async ({ page }) => {
  if (cookies.length) await page.context().addCookies(cookies);
  await ensureOwnerSession(page.request);
  cookies = await page.context().cookies();
  expect((await page.request.post("/api/ai/login", { data: {} })).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
});
const calls = async () => JSON.parse(await readFile(new URL("../../artifacts/ai-e2e-data/runtime-calls.json", import.meta.url), "utf8"));
async function current(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  expect(response.ok()).toBe(true);
  return response.json();
}
async function importText(page, suffix) {
  await page.goto("/");
  await expect(page.locator(".main-panel")).toBeVisible();
  const shelf = page.getByRole("button", { name: "打开书架", exact: true });
  if (await shelf.isVisible()) await shelf.click();
  await page.getByRole("button", { name: "导入文字", exact: true }).click();
  await page.getByRole("textbox", { name: "材料标题" }).fill(`第三阶段验收 ${suffix}`);
  await page.getByRole("textbox", { name: "日语正文" }).fill("遠い空を見ている。\n\n背中を撫でる風。誰にも送らない秘密の末尾。 ");
  const segmented = page.waitForResponse((response) => /\/sentences$/.test(new URL(response.url()).pathname));
  await page.getByRole("button", { name: "保存并阅读" }).click();
  expect((await segmented).ok()).toBe(true);
  await expect(page.getByRole("button", { name: "重新分句", exact: true })).toBeEnabled();
  return current(page, await page.evaluate(() => location.hash.slice(1)));
}
async function remove(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  if (response.ok()) expect((await page.request.delete(`/api/documents/${id}`, {data:{revision:(await response.json()).revision}})).status()).toBe(204);
}

test("划词不发模型请求，快捷问答只送选区句子，校对与重分句保留持久问答及来源", async ({ page }, info) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const document = await importText(page, info.project.name);
  try {
    const beforeSelection = (await calls()).filter((call) => call.type === "chat").length;
    await selectArticleText(page, "背中");
    const popup = page.getByRole("dialog", { name: "划词提问" });
    await expect(popup).toBeVisible();
    expect((await calls()).filter((call) => call.type === "chat")).toHaveLength(beforeSelection);
    await popup.getByRole("button", { name: "翻译", exact: true }).click();
    const chat = page.getByRole("region", { name: "原文 AI 讨论", exact: true });
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(1);
    await expect(chat.getByRole("link", { name: "日语学习测试来源" })).toHaveAttribute("href", "https://www.jpf.go.jp/");
    const sent = (await calls()).filter((call) => call.type === "chat").at(-1);
    expect(sent.webSearch).toBe(true);
    expect(sent.prompt).toContain("背中を撫でる風。");
    expect(sent.prompt).not.toContain("誰にも送らない秘密の末尾");
    expect(sent.prompt).not.toContain("遠い空を見ている");
    let saved = await current(page, document.id);
    expect(bodyRanges(saved.bodyHtml).qa).toHaveLength(1);
    const history = await (await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    const conversationId = history.conversations[0].id;
    const groupId = history.conversations[0].groups[0].id;
    await chat.getByRole("button", { name: "关闭 AI 讨论" }).click();
    await page.getByRole("button", { name: "校对文字与注音" }).click();
    const body = page.getByRole("textbox", { name: "日语正文", exact: true });
    const original = await body.inputValue();
    const beforeEdit = (await calls()).filter((call) => call.type === "sentences").length;
    await body.fill(original.replace("背中", "背筋"));
    await page.getByRole("button", { name: "保存并阅读" }).click();
    await expect(page.getByRole("article", { name: "日语原文" })).toBeVisible();
    expect((await calls()).filter((call) => call.type === "sentences")).toHaveLength(beforeEdit);
    saved = await current(page, document.id);
    expect(bodyRanges(saved.bodyHtml).sentences.map((sentence) => sentence.id)).toEqual(bodyRanges(document.bodyHtml).sentences.map((sentence) => sentence.id));
    expect(bodyRanges(saved.bodyHtml).qa[0].id).toBe(groupId);
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    await expect(chat.locator(".qa-group-heading")).toContainText("原引用文字已修改");
    await expect(chat.locator(".qa-group blockquote")).toHaveText("背中");
    await chat.getByRole("textbox", { name: "向 AI 提问" }).fill("继续解释这个词。");
    await chat.getByRole("button", { name: "发送问题", exact: true }).click();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    expect((await calls()).filter((call) => call.type === "chat").at(-1).prompt).toContain('"selectedText":"背中"');
    const resegmented = page.waitForResponse((response) => /\/sentences$/.test(new URL(response.url()).pathname));
    await page.getByRole("button", { name: "重新分句", exact: true }).click();
    expect((await resegmented).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "重新分句", exact: true })).toBeEnabled();
    const restructured = await current(page, document.id);
    expect(bodyText(restructured.bodyHtml)).toBe(bodyText(saved.bodyHtml));
    expect(bodyRanges(restructured.bodyHtml).qa[0].id).toBe(groupId);
    await page.reload();
    await page.getByRole("button", { name: "对话记录", exact: true }).click();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    const after = await (await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    expect(after.conversations[0].id).toBe(conversationId);
    await page.screenshot({path:`artifacts/stage3-persistent-chat-${info.project.name}.png`,fullPage:true});
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(errors).toEqual([]);
  } finally { await remove(page, document.id); }
});

test("删除选区即时提示游离，撤销取消恢复标记，保存后仍能追问及手动删除会话", async ({page}, info) => {
  const document = await importText(page, `游离 ${info.project.name}`);
  try {
    await selectArticleText(page, "背中");
    await page.getByRole("dialog", {name:"划词提问"}).getByRole("button",{name:"解释语法",exact:true}).click();
    const chat = page.getByRole("region", {name:"原文 AI 讨论"});
    await expect(chat.locator(".qa-group")).toHaveCount(1);
    await chat.getByRole("button",{name:"关闭 AI 讨论"}).click();
    const saved = await current(page,document.id);
    await page.getByRole("button",{name:"校对文字与注音"}).click();
    const body = page.getByRole("textbox",{name:"日语正文",exact:true});
    const original = await body.inputValue();
    await body.fill(original.replace("背中", ""));
    await expect(page.locator(".qa-orphan-warning")).toContainText("1 个问答组");
    await page.getByRole("button",{name:"撤销",exact:true}).click();
    await expect(body).toHaveValue(original);
    await expect(page.locator(".qa-orphan-warning")).toHaveCount(0);
    page.once("dialog",(dialog)=>dialog.accept());
    await page.getByRole("button",{name:"取消",exact:true}).click();
    expect((await current(page,document.id)).bodyHtml).toBe(saved.bodyHtml);
    await page.getByRole("button",{name:"校对文字与注音"}).click();
    await body.fill(original.replace("背中", ""));
    await page.getByRole("button",{name:"保存并阅读"}).click();
    await page.getByRole("button",{name:"对话记录",exact:true}).click();
    await expect(chat.locator(".qa-group-heading")).toContainText("游离／原文关联已删除");
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("原引用已经删掉，请继续解释。");
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    const snapshot = (await calls()).filter((call)=>call.type === "chat").at(-1);
    expect(snapshot.prompt).toContain('"selectedText":"背中"');
    page.once("dialog",(dialog)=>dialog.accept());
    await chat.getByRole("button",{name:"删除文章对话",exact:true}).click();
    await expect(chat.locator(".qa-group")).toHaveCount(0);
    expect((await (await page.request.get(`/api/documents/${document.id}/conversations`)).json()).conversations).toEqual([]);
    expect(bodyRanges((await current(page,document.id)).bodyHtml).qa).toHaveLength(0);
  } finally {await remove(page,document.id);}
});

test("多张来源图追加为同篇文章，保存重开、来源双向定位与原图像素保持", async ({page},info)=>{
  const sources=[];
  let id, finalSentenceId, finalSentenceText;
  try {
    for(let index=1;index<=2;index++) {
      const path = new URL(`../../artifacts/stage3-real-images/source-${index}.png`,import.meta.url);
      const bytes = existsSync(path) ? await readFile(path) : await sharp({create:{width:640,height:480,channels:3,background:index===1?"#fff":"#ccc"}}).png().toBuffer();
      sources.push(bytes);
      if(index===1){
        await page.goto("/");
        await expect(page.locator(".main-panel")).toBeVisible();
        if(await page.getByRole("button",{name:"打开书架",exact:true}).isVisible()) await page.getByRole("button",{name:"打开书架",exact:true}).click();
        await page.getByRole("button",{name:"导入图片",exact:true}).click();
      } else {
        await page.getByRole("button",{name:"追加来源图片",exact:true}).click();
        await page.getByRole("combobox",{name:"追加正文方式",exact:true}).selectOption("continue");
      }
      await page.getByLabel("选择日语图片",{exact:true}).setInputFiles({name:`来源${index}.png`,mimeType:"image/png",buffer:bytes});
      await page.getByRole("button",{name:"识别并注音",exact:true}).click();
      await expect(page.getByRole("textbox",{name:"日语正文",exact:true})).toBeVisible();
      if(index===1) await page.getByRole("textbox",{name:"材料标题"}).fill(`多图文章 ${info.project.name}`);
      const response=index===1 ? page.waitForResponse((response)=>/\/sentences$/.test(new URL(response.url()).pathname)) : null;
      await page.getByRole("button",{name:"保存并阅读"}).click();
      if(response) expect((await response).ok()).toBe(true);
      await expect(page.getByRole("button",{name:"重新分句",exact:true})).toBeEnabled();
      const nextId=await page.evaluate(()=>location.hash.slice(1));
      if(id) expect(nextId).toBe(id); else id=nextId;
      if(index===1) {
        const sentence=bodyRanges((await current(page,id)).bodyHtml).sentences.at(-1);
        finalSentenceId=sentence.id; finalSentenceText=sentence.text;
      }
    }
    const saved=await current(page,id);
    expect(saved.sourceImages).toHaveLength(2);
    expect(bodyRanges(saved.bodyHtml).sentences.find(sentence=>sentence.id===finalSentenceId)?.text).toContain(`${finalSentenceText}僕が生まれた日の空は`);
    expect(new Set(bodyRanges(saved.bodyHtml).sources.map((source)=>source.id)).size).toBe(2);
    for(let i=0;i<2;i++) {
      const raw=await page.request.get(`/api/images/${saved.sourceImages[i].id}/raw`);
      expect(await raw.body()).toEqual(sources[i]);
      expect(saved.sourceImages[i].recognition).toBeTruthy();
    }
    await page.reload();
    await page.getByRole("button",{name:"校对文字与注音"}).click();
    const second=page.getByRole("button",{name:"来源图 2",exact:true});
    await second.click();
    const preview=page.locator(".editor-structure-preview");
    await expect(preview.locator(`[data-source-image-id="${saved.sourceImages[1].id}"].active-source`).first()).toBeAttached();
    await expect(page.getByRole("region",{name:"原图对照",exact:true}).getByRole("img")).toHaveAttribute("src",new RegExp(saved.sourceImages[1].id));
    const details=page.locator(".editor-structure-preview");
    await details.locator("summary").click();
    await details.locator(`[data-source-image-id="${saved.sourceImages[0].id}"]`).first().click();
    await expect(page.getByRole("region",{name:"原图对照",exact:true}).getByRole("img")).toHaveAttribute("src",new RegExp(saved.sourceImages[0].id));
    await page.screenshot({path:`artifacts/stage3-multi-image-${info.project.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{if(id)await remove(page,id);}
});

test("句子交界可选择后句插入，普通编辑保持稳定ID，分句失败可重试", async ({page},info)=>{
  const document=await importText(page,`边界 ${info.project.name}`);
  try {
    const original=bodyText(document.bodyHtml);
    const boundary=original.indexOf("誰にも");
    const following=bodyRanges(document.bodyHtml).sentences.find((sentence)=>sentence.start===boundary);
    expect(following).toBeTruthy();
    await page.getByRole("button",{name:"校对文字与注音"}).click();
    const body=page.getByRole("textbox",{name:"日语正文",exact:true});
    await body.evaluate((element,at)=>{element.focus();element.setSelectionRange(at-1,at-1);},boundary);
    await body.press("ArrowRight");
    await expect(page.locator(".sentence-boundary")).toBeVisible();
    await page.getByRole("radio",{name:/后句/}).check();
    await body.focus();
    await page.keyboard.insertText("新しい");
    await page.getByRole("button",{name:"保存并阅读"}).click();
    await expect(page.getByRole("article",{name:"日语原文"})).toBeVisible();
    const saved=await current(page,document.id);
    expect(bodyRanges(saved.bodyHtml).sentences.find((sentence)=>sentence.text.includes("新しい誰にも"))?.id).toBe(following.id);
    const route=`**/api/documents/${document.id}/sentences`;
    await page.route(route,route=>route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"测试：分句未完成，请重试。"})}));
    await page.getByRole("button",{name:"重新分句",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("分句未完成");
    expect((await current(page,document.id)).bodyHtml).toBe(saved.bodyHtml);
    await page.unroute(route);
    const response=page.waitForResponse(response=>/\/sentences$/.test(new URL(response.url()).pathname));
    await page.getByRole("button",{name:"重新分句",exact:true}).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("button",{name:"重新分句",exact:true})).toBeEnabled();
    expect(bodyText((await current(page,document.id)).bodyHtml)).toBe(bodyText(saved.bodyHtml));
  } finally {await remove(page,document.id);}
});
