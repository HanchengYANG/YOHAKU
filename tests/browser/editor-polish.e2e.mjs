import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { parseText } from "../../shared/document.mjs";
import { applySentenceBoundaries, blocksToHtml, bodyRanges, bodyText, appendImageBodyHtml, sourceBodyHtml } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";

let cookies = [];
test.beforeEach(async ({ page }) => {
  if (cookies.length) await page.context().addCookies(cookies);
  await ensureOwnerSession(page.request);
  cookies = await page.context().cookies();
  expect((await page.request.post("/api/ai/login", { data:{} })).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
});

async function fixture(page, suffix, withQuestion = true) {
  const content = "{背中|せなか}を撫でる風。背中をもう一度読む。\n" + Array.from({length:28}, (_,i) => `第${i+1}段の言葉を読む。何気ない時間にも、小さな発見がある。`).join("\n");
  const plain = bodyText(blocksToHtml(parseText(content)));
  const html = applySentenceBoundaries(blocksToHtml(parseText(content)), plain.split(/(?<=。)/));
  const created = await page.request.post("/api/documents", {data:{title:`編集高亮 ${suffix}`,kind:"article",orientation:"horizontal",bodyHtml:html,content}});
  expect(created.ok()).toBe(true);
  let document = await created.json();
  if (withQuestion) {
    const end = 2;
    const response = await page.request.post(`/api/documents/${document.id}/conversations`, {data:{operation:"translation",selection:{start:0,end,text:plain.slice(0,end),bodyHash:document.bodyHash,
      sentenceIds:bodyRanges(document.bodyHtml).sentences.filter(range=>range.start<end&&range.end>0).map(range=>range.id)}}});
    expect(response.ok()).toBe(true);
    document = await (await page.request.get(`/api/documents/${document.id}`)).json();
  }
  await page.goto(`/#${document.id}`);
  await page.getByRole("button", {name:"校对文字与注音",exact:true}).click();
  await expect(page.getByRole("textbox", {name:"日语正文",exact:true})).toBeVisible();
  return document;
}
async function remove(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  if (response.ok()) await page.request.delete(`/api/documents/${id}`, {data:{revision:(await response.json()).revision}});
}
const inputFor = page => page.getByRole("textbox", {name:"日语正文",exact:true});
const dimensions = page => page.locator(".body-editor").evaluate(root => {
  const input=root.querySelector("textarea"), mirror=root.querySelector(".body-editor-mirror");
  return {nativeHeight:input.scrollHeight, mirrorHeight:mirror.scrollHeight,nativeWidth:input.clientWidth,mirrorWidth:mirror.clientWidth,
    font:getComputedStyle(input).font,mirrorFont:getComputedStyle(mirror).font};
});

test("真实编辑面的高亮与输入字体、换行和滚动对齐，记录入口不抢编辑点击", async ({page}, info) => {
  const document = await fixture(page,info.project.name);
  try {
    const input=inputFor(page);
    await expect(page.locator(".editor-structure-preview")).toHaveCount(0);
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).toHaveCount(1);
    await expect.poll(async()=>{const d=await dimensions(page);return Math.abs(d.nativeHeight-d.mirrorHeight);}).toBeLessThanOrEqual(1);
    const original=await dimensions(page);
    expect(original.nativeWidth).toBe(original.mirrorWidth);
    expect(original.font).toBe(original.mirrorFont);
    const mark=page.locator(".body-editor-part[data-qa-group-ids]").first();
    const rect=await mark.boundingBox();
    const beforeRecords=await input.boundingBox();
    await page.mouse.click(rect.x+1,rect.y+rect.height/2);
    await expect(page.locator(".editor-chat-overlay")).toHaveCount(0);
    await expect(page.getByRole("button",{name:/查看此处记录/})).toBeVisible();
    const afterRecords=await input.boundingBox();
    expect(afterRecords.y).toBeCloseTo(beforeRecords.y,1);
    expect(afterRecords.height).toBeCloseTo(beforeRecords.height,1);
    await page.getByRole("button",{name:/查看此处记录/}).click();
    await expect(page.locator(".editor-chat-overlay")).toBeVisible();
    await page.locator(".editor-chat-overlay").getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    const id=await mark.getAttribute("data-sentence-ids");
    const hoverRect=await mark.boundingBox();
    await page.mouse.move(hoverRect.x+3,hoverRect.y+hoverRect.height/2);
    await expect.poll(()=>page.locator(".body-editor-part.sentence-hover").count()).toBeGreaterThan(0);
    const hoveredIds=await page.locator(".body-editor-part.sentence-hover").evaluateAll(nodes=>nodes.map(node=>node.dataset.sentenceIds));
    expect(hoveredIds.every(value=>value===id)).toBe(true);
    await input.evaluate(element=>{element.scrollTop=500;element.dispatchEvent(new Event("scroll",{bubbles:true}));});
    const scroll=await input.evaluate(element=>element.scrollTop);
    await expect(page.locator(".body-editor-mirror")).toHaveCSS("transform",`matrix(1, 0, 0, 1, 0, ${-scroll})`);
    await input.evaluate(element=>{element.style.fontSize="20px";});
    await expect.poll(async()=>{const d=await dimensions(page);return d.font===d.mirrorFont&&Math.abs(d.nativeHeight-d.mirrorHeight)<=1;}).toBe(true);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/editor-polish-${info.project.name}.png`,fullPage:true});
  } finally {await remove(page,document.id);}
});

test("日语和中文合成输入按一次编辑提交，撤销重做与取消保留完整正文及读音", async ({page}, info) => {
  const document=await fixture(page,`IME ${info.project.name}`,false);
  try {
    const input=inputFor(page), original=await input.inputValue();
    const cdp=await page.context().newCDPSession(page);
    for (const [composition,committed] of [["にほん","日本語"],["zhongwen","中文"]]) {
      await input.evaluate(element=>{element.focus();element.setSelectionRange(0,0);});
      await cdp.send("Input.imeSetComposition",{text:composition,selectionStart:composition.length,selectionEnd:composition.length});
      await expect(page.locator(".body-editor")).toHaveAttribute("data-composing","true");
      await cdp.send("Input.insertText",{text:committed});
      await expect(input).toHaveValue(committed+original);
      await expect(page.locator(".body-editor")).not.toHaveAttribute("data-composing","true");
      await page.getByRole("button",{name:"撤销",exact:true}).click();
      await expect(input).toHaveValue(original);
      await page.getByRole("button",{name:"重做",exact:true}).click();
      await expect(input).toHaveValue(committed+original);
      await page.getByRole("button",{name:"撤销",exact:true}).click();
    }
    // The second occurrence is distinct, and a cross-paragraph replacement
    // follows native UTF-16 selection rather than matching a repeated string.
    const second=original.indexOf("背中",2), end=original.indexOf("第2段");
    await input.evaluate((element,{start,end})=>{element.focus();element.setSelectionRange(start,end);}, {start:second,end});
    await page.keyboard.insertText("跨段校对\n");
    await expect(input).toHaveValue(original.slice(0,second)+"跨段校对\n"+original.slice(end));
    await page.getByRole("button",{name:"撤销",exact:true}).click();
    await expect(input).toHaveValue(original);
    await input.press("End");await page.keyboard.insertText("取消修改");
    page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const stored=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(stored.bodyHtml).toBe(document.bodyHtml);
    expect(stored.blocks.flatMap(block=>block.segments).find(segment=>segment.text==="背中")?.reading).toBe("せなか");
  } finally {await remove(page,document.id);}
});

test("编辑面重新划词建立新问答组并保留标记，未保存正文不会误发选区", async ({page},info)=>{
  const document=await fixture(page,`new group ${info.project.name}`,false);
  try {
    const input=inputFor(page), original=await input.inputValue();
    await input.evaluate(element=>{element.focus();element.setSelectionRange(0,2);element.dispatchEvent(new Event("select",{bubbles:true}));});
    await input.press("Shift");
    const question=page.getByRole("group",{name:"选区提问",exact:true});
    await expect(question).toBeVisible();
    await question.getByRole("button",{name:"翻译",exact:true}).click();
    const overlay=page.locator(".editor-chat-overlay");
    await expect(overlay.locator(".chat-message.assistant")).toHaveCount(1);
    await overlay.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).toHaveCount(1);
    const afterQuestion=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(bodyRanges(afterQuestion.bodyHtml).qa).toHaveLength(1);
    await input.fill(original+"未保存");
    await input.evaluate(element=>{element.focus();element.setSelectionRange(0,2);element.dispatchEvent(new Event("select",{bubbles:true}));});
    await input.press("Shift");
    await question.getByRole("button",{name:"翻译",exact:true}).click();
    await expect(page.locator(".editor-message")).toContainText("尚未保存");
    const history=await(await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    expect(history.conversations[0].groups).toHaveLength(1);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    expect(bodyRanges((await(await page.request.get(`/api/documents/${document.id}`)).json()).bodyHtml).qa).toHaveLength(1);
  }finally{await remove(page,document.id);}
});

test("编辑器新增与删除问答后取消，阅读面立即同步已保存的标记", async ({page},info)=>{
  const document=await fixture(page,`cancel QA ${info.project.name}`,false);
  try {
    const input=inputFor(page);
    await input.evaluate(element=>{element.focus();element.setSelectionRange(0,2);});
    await input.press("Shift");
    await page.getByRole("group",{name:"选区提问",exact:true}).getByRole("button",{name:"翻译",exact:true}).click();
    const overlay=page.locator(".editor-chat-overlay");
    await expect(overlay.locator(".chat-message.assistant")).toHaveCount(1);
    await overlay.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).toHaveCount(1);
    await page.getByRole("button",{name:"取消",exact:true}).click();
    const article=page.getByRole("article",{name:"日语原文",exact:true});
    await expect(article.locator("mark[data-qa-group-ids]")).toHaveCount(1);
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    await input.evaluate(element=>{element.focus();element.setSelectionRange(0,0);});
    await input.press("Shift");
    await page.getByRole("button",{name:/查看此处记录/}).click();
    await expect(overlay.locator(".chat-message.assistant")).toHaveCount(1);
    page.once("dialog",dialog=>dialog.accept());
    await overlay.getByRole("button",{name:"删除文章对话",exact:true}).click();
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).toHaveCount(0);
    await overlay.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(article).toBeVisible();
    await expect(article.locator("mark[data-qa-group-ids]")).toHaveCount(0);
  }finally{await remove(page,document.id);}
});

test("自定义问题确认输入法候选时不会提前发送", async ({page},info)=>{
  const document=await fixture(page,`custom IME ${info.project.name}`,false);
  try {
    const input=inputFor(page);
    await input.evaluate(element=>{element.focus();element.setSelectionRange(0,2);});
    await input.press("Shift");
    await page.getByRole("group",{name:"选区提问",exact:true}).getByRole("button",{name:"自定义问题",exact:true}).click();
    const question=page.getByRole("textbox",{name:"选区自定义问题",exact:true});
    await question.focus();
    const cdp=await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition",{text:"せつめい",selectionStart:4,selectionEnd:4});
    await question.dispatchEvent("keydown",{key:"Enter",code:"Enter",keyCode:229,isComposing:true});
    expect((await(await page.request.get(`/api/documents/${document.id}/conversations`)).json()).conversations).toEqual([]);
    await expect(page.locator(".editor-chat-overlay")).toHaveCount(0);
    await cdp.send("Input.insertText",{text:"説明してください"});
    await expect(question).toHaveValue("説明してください");
    await question.press("Enter");
    await expect(page.locator(".editor-chat-overlay .chat-message.assistant")).toHaveCount(1);
  }finally{await remove(page,document.id);}
});

test("图片按钮排序保持当前图文配对，首尾禁用并适配手机紧凑缩略图", async ({page},info)=>{
  const created=await imagePairFixture(page,`排序 ${info.project.name}`,8);
  const imageIds=created.imageIds;
  let document=created.document;
  try {
    const secondStart=bodyRanges(document.bodyHtml).sources.find(range=>range.id===imageIds[1]).start;
    const qa=await page.request.post(`/api/documents/${document.id}/conversations`,{data:{operation:"translation",selection:{start:secondStart,end:secondStart+2,text:"同じ",bodyHash:document.bodyHash,
      sentenceIds:bodyRanges(document.bodyHtml).sentences.filter(range=>range.start<secondStart+2&&range.end>secondStart).map(range=>range.id)}}});
    expect(qa.ok()).toBe(true);
    document=await(await page.request.get(`/api/documents/${document.id}`)).json();
    const secondText=bodyText(sourceBodyHtml(document.bodyHtml,imageIds[1]));
    await page.goto(`/#${document.id}`);
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    const input=inputFor(page), sorter=page.locator(".source-image-sorter");
    const card=id=>sorter.locator(`[data-sort-image-id="${id}"]`);
    const moveBefore=sorter.getByRole("button",{name:"前移当前照片",exact:true});
    const moveAfter=sorter.getByRole("button",{name:"后移当前照片",exact:true});
    await expect(moveBefore).toBeDisabled();
    await expect(moveAfter).toBeEnabled();
    await card(imageIds[1]).click();
    await expect(input).toHaveValue(secondText);
    await expect(page.locator(".body-editor-part[data-qa-group-ids]")).toHaveCount(1);
    await expect(page.locator(".body-editor-part.active-source")).toHaveCount(0);
    await expect(page.getByRole("textbox",{name:"假名读音",exact:true})).toHaveCount(0);
    await page.getByRole("tab",{name:/^注音校正/}).click();
    const annotation=page.getByRole("textbox",{name:"选择要标注的字词",exact:true});
    await expect(annotation).toHaveValue(secondText);
    await annotation.evaluate(element=>{element.focus();element.setSelectionRange(0,2);element.dispatchEvent(new Event("select",{bubbles:true}));});
    await annotation.press("Shift");
    await page.getByRole("textbox",{name:"假名读音",exact:true}).fill("おんなじ");
    await page.getByRole("button",{name:"添加注音",exact:true}).click();
    await page.getByRole("tab",{name:"正文编辑",exact:true}).click();
    await expect(input).toHaveValue(secondText);
    const press=async button=>info.project.use.hasTouch?button.tap():button.click();
    const order=()=>sorter.locator("button[data-sort-image-id]").evaluateAll(nodes=>nodes.map(node=>node.dataset.sortImageId));
    await expect(moveBefore).toBeEnabled();
    await press(moveBefore);
    const expected=[imageIds[1],imageIds[0],...imageIds.slice(2)];
    await expect.poll(order).toEqual(expected);
    await expect(card(imageIds[1])).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(secondText);
    await expect(moveBefore).toBeDisabled();
    await expect(moveAfter).toBeEnabled();
    await press(moveAfter);
    await expect.poll(order).toEqual(imageIds);
    await press(moveBefore);
    await expect.poll(order).toEqual(expected);
    await expect(sorter.locator(".source-sort-toggle,.source-sort-ghost")).toHaveCount(0);
    await expect(card(imageIds[1])).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(secondText);
    if(info.project.use.hasTouch) {
      const sizes=await sorter.locator("button[data-sort-image-id]").evaluateAll(nodes=>nodes.map(node=>({w:node.getBoundingClientRect().width,h:node.getBoundingClientRect().height})));
      expect(sizes.every(size=>size.w>=44&&size.w<=60&&size.h>=44)).toBe(true);
      await expect(sorter.locator(".source-sort-card-label").first()).toBeHidden();
      await expect(moveBefore).toHaveCSS("min-height","44px");
    }
    await card(imageIds[7]).click();
    await expect(moveAfter).toBeDisabled();
    await expect(moveBefore).toBeEnabled();
    await card(imageIds[1]).click();
    await expect(moveBefore).toBeDisabled();
    const saved=page.waitForResponse(response=>response.request().method()==="PUT"&&new URL(response.url()).pathname===`/api/documents/${document.id}`);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const reopened=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(reopened.sourceImages.map(image=>image.id)).toEqual(expected);
    expect(bodyText(reopened.bodyHtml)).toBe(expected.map(id=>bodyText(sourceBodyHtml(document.bodyHtml,id))).join(""));
    expect(htmlToReading(reopened.bodyHtml,imageIds[0])).toBe("おなじ");
    expect(htmlToReading(reopened.bodyHtml,imageIds[1])).toBe("おんなじ");
    expect(bodyRanges(reopened.bodyHtml).qa.map(range=>range.id)).toEqual(bodyRanges(document.bodyHtml).qa.map(range=>range.id));
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/editor-image-pairs-${info.project.name}.png`,fullPage:true});
  } finally {if(document)await remove(page,document.id);}
});

function htmlToReading(html,id) {
  return sourceBodyHtml(html,id).match(/<rt>([^<]+)<\/rt>/)?.[1];
}


async function imagePairFixture(page,suffix,count=3) {
  const imageIds=[],buffers=[];
  let html;
  for(let index=0;index<count;index++) {
    const buffer=await sharp({create:{width:160,height:220,channels:3,background:{r:220+index,g:225,b:215}}}).png().toBuffer();
    buffers.push(buffer);
    const response=await page.request.post("/api/images",{multipart:{image:{name:`pair-${index+1}.png`,mimeType:"image/png",buffer}}});
    expect(response.ok()).toBe(true);
    const image=await response.json();imageIds.push(image.id);
    const recognized=await page.request.post(`/api/images/${image.id}/recognize`,{data:{engine:"llm"}});
    expect(recognized.ok(),await recognized.text()).toBe(true);
    const part=blocksToHtml(parseText(`{同じ|おなじ}言葉。第${index+1}枚目。`),{sourceImageId:image.id});
    html=html?appendImageBodyHtml(html,part):part;
  }
  html=applySentenceBoundaries(html,bodyText(html).split(/(?<=。)/));
  const response=await page.request.post("/api/documents",{data:{title:`图片 ${suffix}`,kind:"article",orientation:"horizontal",bodyHtml:html,sourceImages:imageIds.map(id=>({id}))}});
  expect(response.ok(),await response.text()).toBe(true);
  return {document:await response.json(),imageIds,buffers};
}

test("删除图片与正文可撤销重做及取消，保护旋转并保留其他图片注音和全部讨论",async({page},info)=>{
  const created=await imagePairFixture(page,`删除 ${info.project.name}`);
  const {imageIds,buffers}=created;
  let document=created.document;
  try {
    for(const id of imageIds.slice(0,2)) {
      const start=bodyRanges(document.bodyHtml).sources.find(range=>range.id===id).start;
      const response=await page.request.post(`/api/documents/${document.id}/conversations`,{data:{operation:"translation",selection:{start,end:start+2,text:"同じ",bodyHash:document.bodyHash,
        sentenceIds:bodyRanges(document.bodyHtml).sentences.filter(range=>range.start<start+2&&range.end>start).map(range=>range.id)}}});
      expect(response.ok(),await response.text()).toBe(true);
      document=await(await page.request.get(`/api/documents/${document.id}`)).json();
    }
    const retainedQa=bodyRanges(document.bodyHtml).qa.find(range=>range.start===0).id;
    const deletedQa=bodyRanges(document.bodyHtml).qa.find(range=>range.start>0).id;
    const originalHistory=await(await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    const originalImage=await(await page.request.get(`/api/images/${imageIds[1]}`)).json();
    const imageMutations=[];
    page.on("request",request=>{if(request.method()!=="GET"&&/\/api\/images\/[^/]+(?:\/rotate)?$/.test(new URL(request.url()).pathname))imageMutations.push(request.method());});
    await page.goto(`/#${document.id}`);
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    const sorter=page.locator(".source-image-sorter"), input=inputFor(page);
    const card=id=>sorter.locator(`button[data-sort-image-id="${id}"]`);
    const removeImage=id=>sorter.locator(`[data-sort-item-id="${id}"]`).getByRole("button",{name:/^移除/});
    const rotate=page.getByRole("button",{name:"向左旋转90°",exact:true});
    const picture=page.getByRole("img",{name:"用于校对正文和注音的日语原图",exact:true});
    const undo=page.getByRole("button",{name:"撤销",exact:true}), redo=page.getByRole("button",{name:"重做",exact:true});
    const secondText=bodyText(sourceBodyHtml(document.bodyHtml,imageIds[1]));
    await card(imageIds[1]).click();
    await expect(input).toHaveValue(secondText);
    await input.fill(secondText+"校正。");
    await expect(rotate).toBeEnabled();await rotate.click();
    await undo.click();
    await expect(input).toHaveValue(secondText);
    await expect(picture).toHaveAttribute("style",/rotate\(-90deg\)/);
    await redo.click();
    await expect(input).toHaveValue(secondText+"校正。");
    await expect(picture).toHaveAttribute("style",/rotate\(-90deg\)/);
    await undo.click();
    await page.getByRole("tab",{name:/^注音校正/}).click();
    const annotation=page.getByRole("textbox",{name:"选择要标注的字词",exact:true});
    await annotation.evaluate(element=>{element.focus();element.setSelectionRange(0,2);element.dispatchEvent(new Event("select",{bubbles:true}));});
    await annotation.press("Shift");
    await page.getByRole("textbox",{name:"假名读音",exact:true}).fill("仮の読み");
    await page.getByRole("tab",{name:"批量注音",exact:true}).click();
    await page.getByRole("textbox",{name:"要标注的词语",exact:true}).fill("同じ");
    await page.getByRole("button",{name:"查找位置",exact:true}).click();
    await page.getByRole("textbox",{name:"批量假名读音",exact:true}).fill("仮の読み");
    await page.getByRole("tab",{name:"正文编辑",exact:true}).click();
    await removeImage(imageIds[1]).click();
    await expect(card(imageIds[1])).toHaveCount(0);
    await expect(card(imageIds[2])).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(bodyText(sourceBodyHtml(document.bodyHtml,imageIds[2])));
    await expect(page.locator(".qa-orphan-warning")).toHaveText("1 组讨论对应的文字已移除。记录会保留，保存后解除正文关联；撤销或取消校对可恢复。");
    expect(await page.locator(".qa-orphan-warning").textContent()).not.toContain(deletedQa);
    expect(imageMutations).toEqual([]);
    await expect(rotate).toBeEnabled();await rotate.click();
    page.once("dialog",dialog=>dialog.dismiss());await undo.click();
    await expect(card(imageIds[1])).toHaveCount(0);
    await expect(card(imageIds[2])).toHaveAttribute("aria-pressed","true");
    await expect(picture).toHaveAttribute("style",/rotate\(-90deg\)/);
    page.once("dialog",dialog=>dialog.accept());await undo.click();
    await expect(card(imageIds[1])).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(secondText);
    await expect(rotate).toBeEnabled();
    await expect(picture).toHaveAttribute("style",/rotate\(-90deg\)/);
    await expect(page.locator(".qa-orphan-warning")).toHaveCount(0);
    await page.getByRole("tab",{name:/^注音校正/}).click();
    await expect(page.getByRole("textbox",{name:"假名读音",exact:true})).toHaveValue("");
    await page.getByRole("tab",{name:"批量注音",exact:true}).click();
    await expect(page.getByRole("textbox",{name:"要标注的词语",exact:true})).toHaveValue("");
    await expect(page.getByRole("textbox",{name:"批量假名读音",exact:true})).toHaveCount(0);
    await page.getByRole("tab",{name:"正文编辑",exact:true}).click();
    page.once("dialog",dialog=>dialog.accept());await redo.click();
    await expect(card(imageIds[1])).toHaveCount(0);
    page.once("dialog",dialog=>dialog.accept());await page.getByRole("button",{name:"取消",exact:true}).click();
    const cancelled=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(cancelled.bodyHtml).toBe(document.bodyHtml);
    expect(cancelled.sourceImages.map(image=>image.id)).toEqual(imageIds);
    expect(await(await page.request.get(`/api/images/${imageIds[1]}`)).json()).toEqual(originalImage);
    expect(await(await page.request.get(`/api/images/${imageIds[1]}/raw`)).body()).toEqual(buffers[1]);
    expect(imageMutations).toEqual([]);
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    await card(imageIds[1]).click();await removeImage(imageIds[1]).click();
    await expect(card(imageIds[2])).toHaveAttribute("aria-pressed","true");
    await removeImage(imageIds[2]).click();
    await expect(card(imageIds[0])).toHaveAttribute("aria-pressed","true");
    await expect(removeImage(imageIds[0])).toBeEnabled();
    await expect(sorter.getByText("至少保留一张图片",{exact:true})).toHaveCount(0);
    await removeImage(imageIds[0]).click();
    await expect(sorter).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page.locator(".preview-panel")).toHaveAttribute("aria-label","阅读预览");
    await undo.click();
    await expect(card(imageIds[0])).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(bodyText(sourceBodyHtml(document.bodyHtml,imageIds[0])));
    const saved=page.waitForResponse(response=>response.request().method()==="PUT"&&new URL(response.url()).pathname===`/api/documents/${document.id}`);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const persisted=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(persisted.sourceImages.map(image=>image.id)).toEqual([imageIds[0]]);
    expect(bodyText(persisted.bodyHtml)).toBe(bodyText(sourceBodyHtml(document.bodyHtml,imageIds[0])));
    expect(htmlToReading(persisted.bodyHtml,imageIds[0])).toBe("おなじ");
    expect(bodyRanges(persisted.bodyHtml).qa.map(range=>range.id)).toEqual([retainedQa]);
    const history=await(await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    expect(history.conversations.flatMap(conversation=>conversation.messages).length).toBe(originalHistory.conversations.flatMap(conversation=>conversation.messages).length);
    const groups=history.conversations.flatMap(conversation=>conversation.groups);
    expect(groups.find(group=>group.id===deletedQa).orphaned).toBe(true);
    expect(groups.find(group=>group.id===retainedQa).orphaned).toBe(false);
    for(let index=1;index<imageIds.length;index++)expect(await(await page.request.get(`/api/images/${imageIds[index]}/raw`)).body()).toEqual(buffers[index]);
    expect(imageMutations).toEqual([]);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {await remove(page,document.id);}
});

test("唯一图片可移除并撤销重做或取消，补正文保存后保持无图片文章",async({page},info)=>{
  const created=await imagePairFixture(page,`最后图片 ${info.project.name}`,1);
  const [imageId]=created.imageIds;
  const original=created.document;
  try {
    const response=await page.request.post(`/api/documents/${original.id}/conversations`,{data:{operation:"translation",selection:{start:0,end:2,text:"同じ",bodyHash:original.bodyHash,
      sentenceIds:bodyRanges(original.bodyHtml).sentences.filter(range=>range.start<2&&range.end>0).map(range=>range.id)}}});
    expect(response.ok(),await response.text()).toBe(true);
    const document=await(await page.request.get(`/api/documents/${original.id}`)).json();
    const records=await(await page.request.get(`/api/documents/${original.id}/conversations`)).json();
    const input=inputFor(page), sorter=page.locator(".source-image-sorter");
    const removeImage=()=>sorter.getByRole("button",{name:/^移除/});
    const undo=page.getByRole("button",{name:"撤销",exact:true}), redo=page.getByRole("button",{name:"重做",exact:true});
    const edit=async()=>{
      await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
      await expect(removeImage()).toBeEnabled();
      await expect(removeImage()).toHaveAttribute("title","移除此图片及对应正文");
    };
    await page.goto(`/#${document.id}`);
    await edit();
    await removeImage().click();
    await expect(sorter).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(page.locator(".preview-panel")).toHaveAttribute("aria-label","阅读预览");
    await expect(page.getByRole("img",{name:"用于校对正文和注音的日语原图",exact:true})).toHaveCount(0);
    await expect(page.getByRole("button",{name:"保存并阅读",exact:true})).toBeDisabled();
    await undo.click();
    await expect(sorter.locator(`[data-sort-image-id="${imageId}"]`)).toHaveAttribute("aria-pressed","true");
    await expect(input).toHaveValue(bodyText(document.bodyHtml));
    await expect(page.locator(".qa-orphan-warning")).toHaveCount(0);
    await redo.click();
    await expect(sorter).toHaveCount(0);
    await expect(input).toHaveValue("");
    page.once("dialog",dialog=>dialog.accept());
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    const cancelled=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(cancelled.bodyHtml).toBe(document.bodyHtml);
    expect(cancelled.sourceImages.map(image=>image.id)).toEqual([imageId]);

    await edit();
    await removeImage().click();
    const replacement="最後の写真を外した後の本文。";
    await input.fill(replacement);
    const saved=page.waitForResponse(result=>result.request().method()==="PUT"&&new URL(result.url()).pathname===`/api/documents/${document.id}`);
    await page.getByRole("button",{name:"保存并阅读",exact:true}).click();
    expect((await saved).ok()).toBe(true);
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    await page.reload();
    const reopened=await(await page.request.get(`/api/documents/${document.id}`)).json();
    expect(reopened.sourceImages).toEqual([]);
    expect(reopened.sourceImageId).toBeNull();
    expect(reopened.recognition).toBeNull();
    expect(bodyText(reopened.bodyHtml)).toBe(replacement);
    expect(bodyRanges(reopened.bodyHtml).sources).toEqual([]);
    expect(await(await page.request.get(`/api/images/${imageId}/raw`)).body()).toEqual(created.buffers[0]);
    const history=await(await page.request.get(`/api/documents/${document.id}/conversations`)).json();
    expect(history.conversations.flatMap(item=>item.messages).length).toBe(records.conversations.flatMap(item=>item.messages).length);
    expect(history.conversations.flatMap(item=>item.groups).every(group=>group.orphaned)).toBe(true);
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    await expect(sorter).toHaveCount(0);
    await expect(input).toHaveValue(replacement);
    await expect(page.getByRole("img",{name:"用于校对正文和注音的日语原图",exact:true})).toHaveCount(0);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  } finally {await remove(page,original.id);}
});
