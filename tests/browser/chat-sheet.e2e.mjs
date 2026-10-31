import { test, expect } from "@playwright/test";
import { ensureOwnerSession } from "./session.mjs";
import { selectArticleText, selectionFor } from "./article-selection.mjs";
import { openDocumentChat } from "./chat-controls.mjs";

async function fixture(page, title) {
  await ensureOwnerSession(page.request);
  expect((await page.request.post("/api/ai/login",{data:{}})).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
  const response=await page.request.post("/api/documents",{data:{title,kind:"article",orientation:"horizontal",
    bodyHtml:'<p data-paragraph-id="chat-first"><span data-sentence-id="chat-s-first"><ruby>背中<rt>せなか</rt></ruby>を撫でる風。庭の木々を眺める。</span></p>'+
      Array.from({length:35},(_,i)=>`<p data-paragraph-id="chat-p-${i}"><span data-sentence-id="chat-s-${i}">静かな部屋で、本の続きをゆっくり読む。</span></p>`).join("")}});
  expect(response.status()).toBe(201);const document=await response.json();
  const ask=async(quote,question)=>{
    const result=await page.request.post(`/api/documents/${document.id}/conversations`,{data:{operation:"custom",question,selection:selectionFor(document,quote)}});
    expect(result.ok()).toBe(true);return result.json();
  };
  const first=await ask("背中","A 首问"); const groupA=first.groups[0].id;
  let history=await ask("庭","B 首问"); const groupB=history.groups.find(item=>item.id!==groupA).id;
  let gate=null,notify=null;
  const decorate=item=>({...item,messages:item.messages.map((message,index)=>index===1?{...message,content:Array.from({length:24},(_,i)=>`段落 ${i+1}。这是一段较长的语法解释，用来检查消息滚动位置和引用展开状态。`).join("\n\n")}:message)});
  await page.route(`**/api/documents/${document.id}/conversations`,async route=>{
    if(route.request().method()==="GET") return route.fulfill({json:{conversations:[decorate(history)]}});
    const result=await route.fetch({headers:{...route.request().headers(),accept:"application/json"}});history=await result.json();await route.fulfill({response:result,json:decorate(history)});
  });
  await page.route(`**/api/conversations/${history.id}/messages`,async route=>{
    const result=await route.fetch({headers:{...route.request().headers(),accept:"application/json"}});history=await result.json();
    const held=gate;gate=null;if(held){notify?.();await held;}
    await route.fulfill({response:result,json:decorate(history)});
  });
  await page.goto(`/#${document.id}`);
  await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
  return {document,groupA,groupB,history:()=>history,hold:()=>{
    let release;gate=new Promise(resolve=>{release=resolve;});
    const held=new Promise(resolve=>{notify=resolve;});return {held,release};
  }};
}
async function remove(page, id) {
  const response=await page.request.get(`/api/documents/${id}`);
  if(response.ok()) await page.request.delete(`/api/documents/${id}`,{data:{revision:(await response.json()).revision}});
}
async function touchSwipe(page, locator, distance) {
  const box=await locator.boundingBox(), x=box.x+box.width/2,y=box.y+box.height/2;
  const cdp=await page.context().newCDPSession(page);
  try {
    await cdp.send("Input.dispatchTouchEvent",{type:"touchStart",touchPoints:[{x,y}]});
    for(let i=1;i<=12;i++) await cdp.send("Input.dispatchTouchEvent",{type:"touchMove",touchPoints:[{x,y:y+distance*i/12}]});
    await cdp.send("Input.dispatchTouchEvent",{type:"touchEnd",touchPoints:[]});
  } finally {await cdp.detach();}
}
const snapshot=chat=>chat.evaluate(element=>({
  group:element.querySelector("select")?.value,
  draft:element.querySelector("textarea").value,
  top:element.querySelector(".chat-messages").scrollTop,
  details:[...element.querySelectorAll("details[open][data-chat-detail]")].map(node=>node.dataset.chatDetail),
}));

test("手机上下划原位恢复，键盘避让，收起期间返回回答不会跳到末尾",async({page},info)=>{
  test.skip(info.project.name!=="phone","手机触摸手势");
  const f=await fixture(page,"手机原位恢复");
  const chat=page.getByLabel("原文 AI 讨论",{exact:true});
  try {
    await page.evaluate(()=>scrollTo(0,650));const readingTop=await page.evaluate(()=>scrollY);
    await touchSwipe(page,page.getByRole("button",{name:"上划恢复对话",exact:true}),-110);
    await expect(chat).toBeVisible();await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    for(const width of [320,360,390,430]) {
      await page.setViewportSize({width,height:844});
      const box=await chat.evaluate(element=>({width:element.offsetWidth,ratio:element.querySelector(".chat-messages").clientHeight/element.clientHeight,overflow:document.documentElement.scrollWidth>innerWidth}));
      expect(box.width).toBe(width);expect(box.ratio).toBeGreaterThanOrEqual(.65);expect(box.overflow).toBe(false);
    }
    await page.setViewportSize({width:390,height:844});
    await chat.getByRole("combobox",{name:"追问目标"}).selectOption(f.groupA);
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("A 草稿");
    await chat.getByRole("combobox",{name:"追问目标"}).selectOption(f.groupB);
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("B 草稿");
    await chat.locator(".chat-group-contexts > summary").click();
    await chat.locator(".chat-answer-sources > summary").first().click();
    await chat.locator(".chat-messages").evaluate(element=>element.scrollTop=320);
    const before=await snapshot(chat);expect(before.top).toBe(320);
    await touchSwipe(page,chat.locator(".chat-drag-handle"),40);
    await expect(chat).toBeVisible();await expect(chat).toHaveCSS("transform","none");
    await touchSwipe(page,chat.locator(".chat-drag-handle"),110);
    await expect(chat).toBeHidden();expect(Math.abs(await page.evaluate(()=>scrollY)-readingTop)).toBeLessThan(2);
    await page.evaluate(()=>scrollBy(0,50));await expect(chat).toBeHidden();
    await page.screenshot({path:"artifacts/chat-sheet-collapsed.png",fullPage:false});
    const handle=page.getByRole("button",{name:"上划恢复对话",exact:true});
    await touchSwipe(page,handle,-35);await expect(chat).toBeHidden();
    await touchSwipe(page,handle,-110);await expect(chat).toBeVisible();await expect(chat).toHaveCSS("transform","none");
    expect(await snapshot(chat)).toEqual(before);
    expect(await page.evaluate(()=>document.activeElement.tagName)).not.toBe("TEXTAREA");
    await page.screenshot({path:"artifacts/chat-sheet-restored.png",fullPage:false});
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("一\n二\n三\n四\n五\n六");
    expect((await chat.getByRole("textbox",{name:"向 AI 提问"}).boundingBox()).height).toBe(110);
    await page.evaluate(()=>{
      Object.defineProperties(visualViewport,{height:{configurable:true,value:430},offsetTop:{configurable:true,value:15}});
      visualViewport.dispatchEvent(new Event("resize"));
    });
    await expect.poll(async()=>Math.round((await chat.boundingBox()).y+(await chat.boundingBox()).height)).toBe(445);
    const input=await chat.getByRole("textbox",{name:"向 AI 提问"}).boundingBox();
    const send=await chat.getByRole("button",{name:"发送问题",exact:true}).boundingBox();
    expect(input.y+input.height).toBeLessThanOrEqual(445);expect(send.y+send.height).toBeLessThanOrEqual(445);
    await page.screenshot({path:"artifacts/chat-sheet-keyboard.png",fullPage:false});
    await page.evaluate(()=>{delete visualViewport.height;delete visualViewport.offsetTop;visualViewport.dispatchEvent(new Event("resize"));});
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("继续问 B");
    const waiting=f.hold();
    try {
      await chat.getByRole("button",{name:"发送问题",exact:true}).click();await waiting.held;
      expect(await page.evaluate(()=>document.activeElement.getAttribute("aria-label"))).toBe("关闭 AI 讨论");
      await chat.locator(".chat-messages").evaluate(element=>element.scrollTop=220);
      const pendingBefore=await snapshot(chat),count=await chat.locator(".chat-message.assistant").count();
      await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();waiting.release();
      await expect(chat.locator(".chat-message.assistant")).toHaveCount(count+1);
      await touchSwipe(page,handle,-110);await expect(chat).toBeVisible();
      expect(await snapshot(chat)).toEqual(pendingBefore);
      expect(f.history().messages.at(-1).groupId).toBe(f.groupB);
    } finally {waiting.release();}
  } finally {await remove(page,f.document.id);}
});

test("三个入口、失败草稿与阅读校对共享状态，刷新清除会话草稿",async({page},info)=>{
  const f=await fixture(page,`问答入口 ${info.project.name}`);
  const chat=page.getByLabel("原文 AI 讨论",{exact:true});
  const article=page.getByRole("article",{name:"日语原文",exact:true});
  try {
    const mark=id=>article.locator(`mark[data-qa-group-ids="${id}"]`).first();
    await mark(f.groupA).click();await expect(chat.locator(".chat-message.user")).toHaveCount(1);
    await expect(chat.getByRole("combobox",{name:"追问目标"})).toHaveCount(0);
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("A 的独立草稿");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await mark(f.groupB).click();await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("B 的独立草稿");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    const freshRoute=`**/api/documents/${f.document.id}/conversations`;
    const failCreate=route=>route.request().method()==="POST"
      ? route.fulfill({status:503,json:{error:"测试：新问题暂未发送成功"}}) : route.fallback();
    await page.route(freshRoute,failCreate);
    await selectArticleText(page,"木々");
    const popup=page.getByRole("dialog",{name:"划词提问",exact:true});
    await popup.getByRole("button",{name:"自定义问题",exact:true}).click();
    await popup.getByRole("textbox",{name:"选区自定义问题"}).fill("木々在这里是什么意思？");
    await popup.getByRole("button",{name:"发送",exact:true}).click();
    await expect(chat.getByRole("alert")).toContainText("新问题暂未发送成功");
    await expect(chat.locator(".chat-user-text")).toHaveText("木々在这里是什么意思？");
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("");
    expect(f.history().groups).toHaveLength(2);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();await openDocumentChat(page);
    await expect(chat.locator(".chat-user-text")).toHaveText("木々在这里是什么意思？");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    if(info.project.name==="phone") {
      await openDocumentChat(page);
      await expect(chat.getByRole("alert")).toContainText("新问题暂未发送成功");
      await expect(chat.getByRole("button",{name:"重试",exact:true})).toBeVisible();
      await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    }
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(article).toBeVisible();await openDocumentChat(page);
    await expect(chat.getByRole("alert")).toContainText("新问题暂未发送成功");
    await expect(chat.locator(".chat-user-text")).toHaveText("木々在这里是什么意思？");
    await page.unroute(freshRoute,failCreate);
    await chat.getByRole("button",{name:"重试",exact:true}).click();
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(1);
    const fresh=f.history().groups.at(-1).id;expect([f.groupA,f.groupB]).not.toContain(fresh);
    await expect(chat.locator(".qa-group.active")).toHaveAttribute("data-qa-group-id",fresh);
    const failedRoute=`**/api/conversations/${f.history().id}/messages`;
    await page.route(failedRoute,route=>route.fulfill({status:503,json:{error:"测试：回答暂时失败"}}));
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("失败也应保留这个问题");
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect(chat.getByRole("alert")).toContainText("回答暂时失败");
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("失败也应保留这个问题");
    await page.unroute(failedRoute);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await mark(f.groupA).click();await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("A 的独立草稿");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"校对文字与注音",exact:true}).click();
    // Existing words remain usable in the editor, with the same in-memory
    // session as the reader and no change to the article's dirty state.
    if(info.project.name==="phone") await openDocumentChat(page);
    else {
      const input=page.getByRole("textbox",{name:"日语正文",exact:true});
      await input.evaluate(element=>{element.focus();element.setSelectionRange(0,2);});await input.press("Shift");
      await page.getByRole("button",{name:/查看此处记录/}).click();
    }
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("A 的独立草稿");
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("校对页继续保留的草稿");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(article).toBeVisible();await mark(f.groupA).click();
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("校对页继续保留的草稿");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();await page.reload();
    await openDocumentChat(page);await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("");
    await chat.getByRole("button",{name:"更多对话操作",exact:true}).click();page.once("dialog",dialog=>dialog.accept());
    await chat.getByRole("button",{name:"删除文章对话",exact:true}).click();
    await expect(chat.locator(".chat-message")).toHaveCount(0);
    await expect.poll(()=>page.evaluate(()=>document.activeElement.getAttribute("aria-label"))).toBe("更多对话操作");
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await expect(article).toBeVisible();
    await expect(article.locator("mark[data-qa-group-ids]")).toHaveCount(0);
    await openDocumentChat(page);await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("");
  } finally {await remove(page,f.document.id);}
});
