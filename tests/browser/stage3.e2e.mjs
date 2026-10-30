import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import sharp from "sharp";
import { bodyRanges, bodyText, sourceBodyHtml } from "../../shared/article-html.mjs";
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
    await chat.getByRole("button", { name: "关闭 AI 讨论", exact: true }).click();
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
    await expect(page.locator(".qa-orphan-warning")).toContainText("1 组讨论对应的文字已移除。记录会保留");
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

test("图片文字 pair 追加同篇文章、逐图编辑与按钮排序，保存重开保留来源和注音", async ({page},info)=>{
  const sources=[];
  let id, firstPairText;
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
        await page.getByRole("button",{name:"继续添加图片",exact:true}).click();
        await expect(page.getByRole("combobox",{name:"追加正文方式",exact:true})).toHaveCount(0);
      }
      await page.getByLabel("选择日语图片",{exact:true}).setInputFiles({name:`来源${index}.png`,mimeType:"image/png",buffer:bytes});
      await page.getByRole("button",{name:"识别并注音",exact:true}).click();
      await expect(page.getByRole("textbox",{name:"日语正文",exact:true})).toBeVisible();
      if(index===1) {
        const title=page.getByRole("textbox",{name:"材料标题"});
        if(!await title.isVisible()) await page.locator(".editor-meta-details > summary").click();
        await title.fill(`多图文章 ${info.project.name}`);
      }
      const response=page.waitForResponse((response)=>/\/sentences$/.test(new URL(response.url()).pathname));
      await page.getByRole("button",{name:"保存并阅读"}).click();
      if(response) expect((await response).ok()).toBe(true);
      await expect(page.getByRole("button",{name:"重新分句",exact:true})).toBeEnabled();
      const nextId=await page.evaluate(()=>location.hash.slice(1));
      if(id) expect(nextId).toBe(id); else id=nextId;
      if(index===1) {
        firstPairText=bodyText((await current(page,id)).bodyHtml);
      }
    }
    let saved=await current(page,id);
    expect(saved.sourceImages).toHaveLength(2);
    const sourceIds=saved.sourceImages.map(source=>source.id);
    const secondPairText=bodyText(sourceBodyHtml(saved.bodyHtml,sourceIds[1]));
    expect(bodyText(sourceBodyHtml(saved.bodyHtml,sourceIds[0]))).toBe(firstPairText);
    expect(bodyText(saved.bodyHtml)).toBe(firstPairText+secondPairText);
    expect(new Set(bodyRanges(saved.bodyHtml).sources.map((source)=>source.id)).size).toBe(2);
    for(let i=0;i<2;i++) {
      const raw=await page.request.get(`/api/images/${saved.sourceImages[i].id}/raw`);
      expect(await raw.body()).toEqual(sources[i]);
      expect(saved.sourceImages[i].recognition).toBeTruthy();
    }
    const selectedText=bodyText(saved.bodyHtml).slice(0,2);
    const question=await page.request.post(`/api/documents/${id}/conversations`,{data:{operation:"translation",selection:{start:0,end:2,text:selectedText,bodyHash:saved.bodyHash,
      sentenceIds:bodyRanges(saved.bodyHtml).sentences.filter(range=>range.start<2&&range.end>0).map(range=>range.id)}}});
    expect(question.ok()).toBe(true);
    saved=await current(page,id);
    const groupId=bodyRanges(saved.bodyHtml).qa[0].id;
    const readings=saved.blocks.flatMap(block=>block.segments).filter(segment=>segment.reading).map(segment=>[segment.text,segment.reading,segment.origin]).sort();
    await page.reload();
    await page.getByRole("button",{name:"校对文字与注音"}).click();
    const first=page.locator(`.source-sort-card[data-sort-image-id="${sourceIds[0]}"]`);
    const second=page.locator(`.source-sort-card[data-sort-image-id="${sourceIds[1]}"]`);
    const input=page.getByRole("textbox",{name:"日语正文",exact:true});
    const moveBefore=page.getByRole("button",{name:"前移当前照片",exact:true});
    const moveAfter=page.getByRole("button",{name:"后移当前照片",exact:true});
    await expect(moveBefore).toBeDisabled();
    await expect(moveAfter).toBeEnabled();
    await second.click();
    await expect(input).toHaveValue(secondPairText);
    await expect(page.locator(".body-editor-part.active-source")).toHaveCount(0);
    await expect(page.getByRole("region",{name:"原图对照",exact:true}).getByRole("img")).toHaveAttribute("src",new RegExp(sourceIds[1]));
    await first.click();
    await expect(input).toHaveValue(firstPairText);
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).not.toHaveCount(0);
    await expect(page.getByText("在上方选中字词，为它标注读音",{exact:true})).toHaveCount(0);
    await expect(page.locator(".sentence-boundary")).toHaveCount(0);
    const corrected=firstPairText+"校正した。";
    await input.fill(corrected);
    await second.click();
    await expect(input).toHaveValue(secondPairText);
    await first.click();
    await expect(input).toHaveValue(corrected);
    await moveAfter.click();
    await expect(page.locator(".source-sort-list button[data-sort-image-id]").first()).toHaveAttribute("data-sort-image-id",sourceIds[1]);
    await expect(first).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(corrected);
    await expect(moveAfter).toBeDisabled();
    await expect(moveBefore).toBeEnabled();
    await page.getByRole("button",{name:"全文检查",exact:true}).click();
    const full=page.getByRole("dialog",{name:"全文检查",exact:true});
    const fullSources=await full.locator("[data-source-image-id]").evaluateAll(nodes=>[...new Set(nodes.map(node=>node.dataset.sourceImageId))]);
    expect(fullSources).toEqual([sourceIds[1],sourceIds[0]]);
    await expect(full.locator(`[data-qa-group-ids~="${groupId}"]`)).not.toHaveCount(0);
    await full.getByRole("button",{name:"关闭全文检查",exact:true}).click();
    const persisted=page.waitForResponse(response=>response.request().method()==="PUT"&&new URL(response.url()).pathname===`/api/documents/${id}`);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();
    expect((await persisted).ok()).toBe(true);
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const reordered=await current(page,id);
    expect(reordered.sourceImages.map(source=>source.id)).toEqual([sourceIds[1],sourceIds[0]]);
    expect(bodyText(reordered.bodyHtml)).toBe(secondPairText+corrected);
    expect(bodyRanges(reordered.bodyHtml).qa.map(range=>range.id)).toContain(groupId);
    expect(reordered.blocks.flatMap(block=>block.segments).filter(segment=>segment.reading).map(segment=>[segment.text,segment.reading,segment.origin]).sort()).toEqual(readings);
    await page.reload();
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    await expect(input).toHaveValue(secondPairText);
    await expect(page.locator(".source-sort-list button[data-sort-image-id]").first()).toHaveAttribute("data-sort-image-id",sourceIds[1]);
    await page.screenshot({path:`artifacts/stage3-multi-image-${info.project.name}.png`,fullPage:true});
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  }finally{if(id)await remove(page,id);}
});

test("正文直接编辑不展示交界选项，保留稳定ID且分句失败可重试", async ({page},info)=>{
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
    await expect(page.locator(".sentence-boundary")).toHaveCount(0);
    await body.focus();
    await page.keyboard.insertText("新しい");
    await page.getByRole("button",{name:"保存并阅读"}).click();
    await expect(page.getByRole("article",{name:"日语原文"})).toBeVisible();
    const saved=await current(page,document.id);
    expect(bodyText(saved.bodyHtml)).toBe(original.slice(0,boundary)+"新しい"+original.slice(boundary));
    expect(bodyRanges(saved.bodyHtml).sentences.map(sentence=>sentence.id)).toEqual(bodyRanges(document.bodyHtml).sentences.map(sentence=>sentence.id));
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

test("编辑器删除对话后撤销和重做保留文字且不会恢复失效问答标记", async ({page},info)=>{
  const document=await importText(page,`删除后编辑历史 ${info.project.name}`);
  try {
    await selectArticleText(page,"背中");
    await page.getByRole("dialog",{name:"划词提问"}).getByRole("button",{name:"翻译",exact:true}).click();
    const chat=page.getByRole("region",{name:"原文 AI 讨论",exact:true});
    await expect(chat.locator(".qa-group")).toHaveCount(1);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    const body=page.getByRole("textbox",{name:"日语正文",exact:true});
    const original=await body.inputValue();
    const middle=original.replace("遠い","広い"), newest=original.replace("遠い","青い");
    await body.fill(middle);
    await body.fill(newest);
    await page.getByRole("button",{name:"撤销",exact:true}).click();
    await expect(body).toHaveValue(middle);
    const structure=page.locator(".body-editor-mirror");
    const qaStart=original.indexOf("背中");
    await body.evaluate((element,at)=>{
      element.focus({preventScroll:true});element.setSelectionRange(at,at);
      element.dispatchEvent(new KeyboardEvent("keyup",{key:"ArrowRight",bubbles:true}));
    },qaStart);
    await page.getByRole("button",{name:/查看此处记录/}).click();
    const overlay=page.locator(".editor-chat-overlay");
    await expect(overlay.locator(".qa-group")).toHaveCount(1);
    page.once("dialog",dialog=>dialog.accept());
    await overlay.getByRole("button",{name:"删除文章对话",exact:true}).click();
    await expect(structure.locator("[data-qa-group-ids]")).toHaveCount(0);
    await overlay.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"撤销",exact:true}).click();
    await expect(body).toHaveValue(original);
    await expect(structure.locator("[data-qa-group-ids]")).toHaveCount(0);
    await page.getByRole("button",{name:"重做",exact:true}).click();
    await expect(body).toHaveValue(middle);
    await expect(structure.locator("[data-qa-group-ids]")).toHaveCount(0);
    await page.getByRole("button",{name:"重做",exact:true}).click();
    await expect(body).toHaveValue(newest);
    await expect(structure.locator("[data-qa-group-ids]")).toHaveCount(0);
    const response=page.waitForResponse(response=>response.request().method()==="PUT"&&new URL(response.url()).pathname===`/api/documents/${document.id}`);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const saved=await current(page,document.id);
    expect(bodyText(saved.bodyHtml)).toBe(newest);
    expect(bodyRanges(saved.bodyHtml).qa).toHaveLength(0);
    expect((await(await page.request.get(`/api/documents/${document.id}/conversations`)).json()).conversations).toEqual([]);
  } finally {await remove(page,document.id);}
});

async function createUnsegmentedArticle(page, suffix) {
  const response = await page.request.post("/api/documents", { data: {
    title: `旧文章自动分句 ${suffix}`,
    kind: "article", orientation: "horizontal",
    content: `{古い|ふるい}資料を読む。\n\n次の句も読む。${suffix}の記録。`,
  } });
  expect(response.status()).toBe(201);
  const document = await response.json();
  expect(bodyRanges(document.bodyHtml).sentences).toHaveLength(0);
  return document;
}
const sentencePath = (id) => `/api/documents/${id}/sentences`;
const sentenceResponse = (id) => (response) => response.request().method() === "POST" && new URL(response.url()).pathname === sentencePath(id);

// These records intentionally bypass the import UI, as old saved articles do.
test("阅读旧文章立即初始化并保存分句，保留原文和注音，刷新不重复请求", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `首次 ${info.project.name}`);
  const requests = [];
  page.on("request", request => {
    if (request.method() === "POST" && new URL(request.url()).pathname === sentencePath(document.id)) requests.push(request.postDataJSON());
  });
  try {
    const response = page.waitForResponse(sentenceResponse(document.id));
    await page.goto(`/#${document.id}`);
    expect((await response).ok()).toBe(true);
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    const saved = await current(page, document.id);
    expect(saved.revision).toBeGreaterThan(document.revision);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(document.bodyHtml));
    expect(saved.content).toBe(document.content);
    expect(saved.blocks).toEqual(document.blocks);
    expect(bodyRanges(saved.bodyHtml).sentences.length).toBeGreaterThan(1);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({force:false,revision:document.revision,bodyHash:document.bodyHash});
    const modelCalls = (await calls()).filter(call => call.type === "sentences").length;
    await page.reload();
    await expect(page.getByRole("heading", {name:document.title,exact:true})).toBeVisible();
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    await page.waitForLoadState("networkidle");
    expect(requests).toHaveLength(1);
    expect((await calls()).filter(call => call.type === "sentences")).toHaveLength(modelCalls);
    const reopened = await current(page, document.id);
    expect(reopened.bodyHtml).toBe(saved.bodyHtml);
    expect(reopened.revision).toBe(saved.revision);
  } finally { await remove(page, document.id); }
});

test("旧文章自动分句失败保留已存正文，阅读仍可用且能手动重试", async ({page}, info) => {
  const document = await createUnsegmentedArticle(page, `失败 ${info.project.name}`);
  const routePattern = `**${sentencePath(document.id)}`;
  let attempts = 0;
  await page.route(routePattern, route => {
    attempts++;
    return route.fulfill({status:502,contentType:"application/json",body:JSON.stringify({error:"测试：旧文章分句暂不可用。"})});
  });
  try {
    await page.goto(`/#${document.id}`);
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("旧文章分句暂不可用");
    await expect(page.getByRole("button", {name:"初始化分句",exact:true})).toBeEnabled();
    await expect(page.getByRole("button", {name:"校对文字与注音",exact:true})).toBeEnabled();
    await page.waitForLoadState("networkidle");
    expect(attempts).toBe(1);
    const unchanged = await current(page, document.id);
    expect(unchanged.bodyHtml).toBe(document.bodyHtml);
    expect(unchanged.revision).toBe(document.revision);
    await page.unroute(routePattern);
    const retry = page.waitForResponse(sentenceResponse(document.id));
    await page.getByRole("button", {name:"初始化分句",exact:true}).click();
    expect((await retry).ok()).toBe(true);
    await expect(page.getByRole("button", {name:"重新分句",exact:true})).toBeEnabled();
    await expect(page.getByRole("alert")).toHaveCount(0);
    const saved = await current(page, document.id);
    expect(bodyText(saved.bodyHtml)).toBe(bodyText(document.bodyHtml));
    expect(saved.content).toBe(document.content);
    expect(bodyRanges(saved.bodyHtml).sentences.length).toBeGreaterThan(1);
  } finally { await page.unroute(routePattern); await remove(page, document.id); }
});

test("旧文章分句的迟到结果不覆盖其他文章，进入校对后仍能保存当前草稿", async ({page}, info) => {
  const first = await createUnsegmentedArticle(page, `切换 ${info.project.name}`);
  const second = await createUnsegmentedArticle(page, `目标 ${info.project.name}`);
  const editable = await createUnsegmentedArticle(page, `校对 ${info.project.name}`);
  let releaseFirst, releaseEdit;
  const firstHeld = new Promise(resolve => { releaseFirst = resolve; });
  const editHeld = new Promise(resolve => { releaseEdit = resolve; });
  let signalFirst, signalEdit;
  const firstStarted = new Promise(resolve => { signalFirst = resolve; });
  let signalFirstFinished;
  const firstFinished = new Promise(resolve => { signalFirstFinished = resolve; });
  const editStarted = new Promise(resolve => { signalEdit = resolve; });
  const firstPattern = `**${sentencePath(first.id)}`;
  const editPattern = `**${sentencePath(editable.id)}`;
  try {
    expect((await page.request.post(sentencePath(second.id), {data:{revision:second.revision,bodyHash:second.bodyHash,force:false}})).ok()).toBe(true);
    await page.route(firstPattern, async route => {
      const response = await route.fetch();
      signalFirst();
      await firstHeld;
      try { await route.fulfill({response}); }
      catch (error) { if (!route.request().failure()) throw error; }
      finally { signalFirstFinished(); }
    });
    await page.goto(`/#${first.id}`);
    await firstStarted;
    await page.evaluate(id => { location.hash = id; }, second.id);
    await expect(page.getByRole("heading", {name:second.title,exact:true})).toBeVisible();
    releaseFirst();
    await firstFinished;
    expect(bodyRanges((await current(page, first.id)).bodyHtml).sentences.length).toBeGreaterThan(1);
    await page.waitForLoadState("networkidle");
    await expect(page.getByRole("heading", {name:second.title,exact:true})).toBeVisible();
    await expect(page.getByRole("heading", {name:first.title,exact:true})).toHaveCount(0);
    await expect(page.getByRole("textbox", {name:"日语正文",exact:true})).toHaveCount(0);
    expect(await page.evaluate(() => location.hash.slice(1))).toBe(second.id);
    await page.route(editPattern, async route => {
      signalEdit();
      await editHeld;
      const response = await route.fetch();
      await route.fulfill({response});
    });
    await page.evaluate(id => { location.hash = id; }, editable.id);
    await editStarted;
    await page.getByRole("button", {name:"校对文字与注音",exact:true}).click();
    releaseEdit();
    const body = page.getByRole("textbox", {name:"日语正文",exact:true});
    await expect(body).toBeVisible();
    const changed = bodyText(editable.bodyHtml).replace("資料", "文章");
    await body.fill(changed);
    const save = page.waitForResponse(response => response.request().method() === "PUT" && new URL(response.url()).pathname === `/api/documents/${editable.id}`);
    await page.getByRole("button", {name:"保存并阅读",exact:true}).click();
    expect((await save).ok()).toBe(true);
    await expect(page.getByRole("heading", {name:editable.title,exact:true})).toBeVisible();
    await expect(page.getByRole("article", {name:"日语原文",exact:true})).toBeVisible();
    expect(bodyText((await current(page, editable.id)).bodyHtml)).toBe(changed);
  } finally {
    releaseFirst(); releaseEdit();
    await page.unroute(firstPattern); await page.unroute(editPattern);
    for (const document of [first, second, editable]) await remove(page, document.id);
  }
});
