import { test, expect } from "@playwright/test";
import { ensureOwnerSession } from "./session.mjs";
import { selectionFor, selectArticleText } from "./article-selection.mjs";
import { openDocumentChat } from "./chat-controls.mjs";

async function fixture(page,title) {
  await ensureOwnerSession(page.request);
  await page.request.post("/api/ai/login",{data:{}});
  await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code");
  const response=await page.request.post("/api/documents",{data:{title,kind:"article",orientation:"horizontal",
    bodyHtml:'<p data-paragraph-id="stream-p"><span data-sentence-id="stream-s"><ruby>背中<rt>せなか</rt></ruby>を撫でる風。庭の木々を眺める。</span></p>'}});
  expect(response.status()).toBe(201);const document=await response.json();
  const ask=async(quote,question)=>{
    const answer=await page.request.post(`/api/documents/${document.id}/conversations`,{data:{operation:"custom",question,selection:selectionFor(document,quote)}});
    expect(answer.ok()).toBe(true);return answer.json();
  };
  const a=await ask("背中","已有解释，保留阅读位置。".repeat(65));
  const b=await ask("庭","庭的已有讨论");
  await page.goto(`/#${document.id}`);
  const article=page.getByRole("article",{name:"日语原文",exact:true});await expect(article).toBeVisible();
  return {document,conversation:b,groupA:a.groups[0].id,groupB:b.groups.at(-1).id,article};
}
const control=(page,data)=>page.request.post("/__test/chat-stream",{data});
async function clean(page,document) {
  await control(page,{action:"reset"});
  await page.goto("/");
  await expect.poll(async()=>{const result=await (await page.request.get("/api/ai/status")).json();return result.runtime?.busy;}).toBe(false);
  const current=await page.request.get(`/api/documents/${document.id}`);
  if(current.ok()) await page.request.delete(`/api/documents/${document.id}`,{data:{revision:(await current.json()).revision}});
}

test("流式回答在完成前可见，收起恢复、切换片段、失败重试保持原组与阅读位置",async({page},info)=>{
  const f=await fixture(page,`流式追问 ${info.project.name}`), chat=page.getByLabel("原文 AI 讨论",{exact:true});
  const partial=chat.locator('[data-stream-state="streaming"]'), messages=chat.locator(".chat-messages");
  const text="这是尚未结束的流式回答。🙂新文字会持续出现，完整回答尚未保存。\n\n"+
    "后续解释分段到达，用来验证持续显示和阅读位置。\n\n".repeat(18)+"**回答已完整结束**。[资料](https://www.jpf.go.jp/)";
  const history=async()=> (await (await page.request.get(`/api/documents/${f.document.id}/conversations`)).json()).conversations[0];
  try {
    await f.article.locator(`mark[data-qa-group-ids="${f.groupA}"]`).click();
    await messages.evaluate(element=>{
      window.chatStreamLengths=[];
      const observer=new MutationObserver(()=>{
        const text=element.querySelector('[data-stream-state="streaming"] .chat-markdown')?.textContent;
        if(text) window.chatStreamLengths.push(Array.from(text).length);
      });
      observer.observe(element,{subtree:true,childList:true,characterData:true});
    });
    await control(page,{text,hold:true,prefixLength:45});
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("试一次逐字显示");
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect(partial).toContainText("这是尚未结束的流式回答");
    await expect(partial).not.toContainText("回答已完整结束");
    expect((await history()).messages).toHaveLength(4);
    expect(await page.evaluate(()=>new Set(window.chatStreamLengths).size)).toBeGreaterThan(1);
    await page.screenshot({path:`artifacts/chat-stream-typing-${info.project.name}.png`});
    await messages.evaluate(element=>element.scrollTop=120);
    const top=await messages.evaluate(element=>element.scrollTop);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await openDocumentChat(page); await expect(partial).toContainText("这是尚未结束");
    expect(await messages.evaluate(element=>element.scrollTop)).toBe(top);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await selectArticleText(page,"風");
    const blocked=page.getByRole("dialog",{name:"划词提问",exact:true});
    await expect(blocked).toContainText("正在回答上一问");
    for(const name of ["翻译","解释语法","自定义问题"]) await expect(blocked.getByRole("button",{name,exact:true})).toBeDisabled();
    await blocked.getByRole("button",{name:"关闭划词提问",exact:true}).click();
    await f.article.locator(`mark[data-qa-group-ids="${f.groupB}"]`).click();
    await expect(partial).toHaveCount(0); await expect(chat).toContainText("庭的已有讨论");
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toBeDisabled();
    await expect(chat.getByRole("button",{name:"发送问题",exact:true})).toBeDisabled();
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await f.article.locator(`mark[data-qa-group-ids="${f.groupA}"]`).click();
    await expect(partial).toContainText("这是尚未结束");
    await messages.evaluate(element=>element.scrollTop=120);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await control(page,{action:"release"});
    await expect.poll(async()=>(await history()).messages.length).toBe(6);
    await openDocumentChat(page);
    await expect(partial).toHaveCount(0);
    expect(await messages.evaluate(element=>element.scrollTop)).toBe(120);
    await expect(chat.locator(".chat-message.assistant strong")).toHaveText("回答已完整结束");
    expect((await history()).messages.at(-1).groupId).toBe(f.groupA);
    await page.screenshot({path:`artifacts/chat-stream-${info.project.name}.png`});
    await control(page,{text:"这段回答会中途中断，已经收到的文字只能作为未完成内容显示。后续永远不会完成。",hold:true,fail:true,prefixLength:27});
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("失败后保留这一问");
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect(partial).toContainText("这段回答会中途中断");
    await control(page,{action:"release"});
    await expect(chat.getByRole("alert")).toContainText("流式回答中途中断");
    await expect(chat.getByLabel("AI 未完成的回答",{exact:true})).toContainText("这段回答会中途中断");
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("失败后保留这一问");
    expect((await history()).messages).toHaveLength(6);
    await control(page,{action:"reset"});
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect.poll(async()=>(await history()).messages.length).toBe(8);
    await expect(chat.locator('[data-stream-state="incomplete"]')).toHaveCount(0);
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("");
  } finally {await clean(page,f.document);}
});

test("完成消息在传输中丢失时核对服务器记录，恢复完整回答而不重复问答",async({page},info)=>{
  const f=await fixture(page,`流式终态丢失 ${info.project.name}`), chat=page.getByLabel("原文 AI 讨论",{exact:true});
  try {
    await page.route(`**/api/conversations/${f.conversation.id}/messages`,async(route)=>{
      const response=await route.fetch({headers:{...route.request().headers(),accept:"application/json"}});
      expect(response.ok()).toBe(true);const saved=await response.json();
      const body=[{type:"start",groupId:f.groupA,question:saved.messages.at(-2).content,operation:"followup",conversation:{...saved,messages:saved.messages.slice(0,-2)}},
        {type:"delta",delta:"终态消息到达前，客户端只收到这段文字"}]
        .map(event=>`data: ${JSON.stringify(event)}\n\n`).join("");
      await route.fulfill({status:200,contentType:"text/event-stream",body});
    });
    await f.article.locator(`mark[data-qa-group-ids="${f.groupA}"]`).click();
    await chat.getByRole("textbox",{name:"向 AI 提问"}).fill("终态丢失后恢复这一问");
    await chat.getByRole("button",{name:"发送问题",exact:true}).click();
    await expect(chat.locator(".chat-message.assistant").last()).toContainText("终态丢失后恢复这一问");
    await expect(chat.locator(".chat-message.user")).toHaveCount(2);
    await expect(chat.locator(".chat-message.assistant")).toHaveCount(2);
    await expect(chat.locator("[data-stream-state]")).toHaveCount(0);
    await expect(chat.getByRole("alert")).toHaveCount(0);
    await expect(chat.getByRole("textbox",{name:"向 AI 提问"})).toHaveValue("");
  } finally {await clean(page,f.document);}
});

test("新选区流式提问仅显示本次讨论，完成后替换临时消息且保留引用与来源",async({page},info)=>{
  const f=await fixture(page,`流式新选区 ${info.project.name}`), chat=page.getByLabel("原文 AI 讨论",{exact:true});
  try {
    await page.emulateMedia({reducedMotion:"reduce"});
    await control(page,{text:"这是新选区的增量解释，先显示已生成的部分，不等待整篇回答。\n\n**完整的新选区解释**。",hold:true,prefixLength:22});
    await selectArticleText(page,"風");
    const popup=page.getByRole("dialog",{name:"划词提问",exact:true});
    await popup.getByRole("button",{name:"自定义问题",exact:true}).click();
    await popup.getByRole("textbox",{name:"选区自定义问题"}).fill("风在这里怎么理解？");
    await popup.getByRole("button",{name:"发送",exact:true}).click();
    const partial=chat.getByLabel("AI 正在回答",{exact:true});
    await expect(partial).toContainText("这是新选区的增量解释");
    await expect(chat.locator(".chat-message.user")).toHaveCount(1);
    await expect(chat.locator(".chat-message.user")).toContainText("风在这里怎么理解？");
    await expect(chat).not.toContainText("庭的已有讨论");
    await chat.locator(".chat-group-contexts > summary").click();
    await expect(chat.locator(".chat-group-contexts blockquote")).toHaveText("風");
    await control(page,{action:"release"});
    await expect(chat.locator(".chat-message.assistant strong")).toHaveText("完整的新选区解释");
    await expect(partial).toHaveCount(0);await expect(chat.locator(".chat-message.user")).toHaveCount(1);
    await chat.locator(".chat-answer-sources > summary").click();
    await expect(chat.getByRole("link",{name:"日语学习测试来源",exact:true})).toHaveAttribute("href","https://www.jpf.go.jp/");
    const saved=(await (await page.request.get(`/api/documents/${f.document.id}/conversations`)).json()).conversations[0];
    expect(saved.groups).toHaveLength(3);expect(saved.messages).toHaveLength(6);
    expect(saved.groups.at(-1).selection.text).toBe("風");
    expect(saved.messages.at(-1).groupId).toBe(saved.groups.at(-1).id);
  } finally {await clean(page,f.document);}
});
