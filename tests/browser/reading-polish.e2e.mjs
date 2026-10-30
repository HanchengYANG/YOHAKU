import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { bodyRanges, bodyText } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";
import { selectArticleText } from "./article-selection.mjs";

test("同句跨来源和注音整体悬停，高亮完整包注音，重复词位置与正文滚动保持正确", async ({page}, info) => {
  await ensureOwnerSession(page.request);
  expect((await page.request.post("/api/ai/login",{data:{}})).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
  const pixels = await sharp({create:{width:20,height:30,channels:3,background:"#e2ebdb"}}).png().toBuffer();
  const sources=[];
  for (let i=0;i<2;i++) {
    const response=await page.request.post("/api/images",{multipart:{image:{name:`reading-${i}.png`,mimeType:"image/png",buffer:pixels}}});
    expect(response.status()).toBe(201);
    const image=(await response.json()).id;
    expect((await page.request.post(`/api/images/${image}/recognize`,{data:{engine:"llm"}})).ok()).toBe(true);
    sources.push(image);
  }
  const bodyHtml=`<p data-paragraph-id="reading-p1"><span data-sentence-id="reading-s1"><span data-source-image-id="${sources[0]}"><ruby>背中<rt>せなか</rt></ruby>を読むと、</span><span data-source-image-id="${sources[1]}"><ruby>朝<rt>あさ</rt></ruby>の光が窓に差し込んだ。</span></span></p>`
    + `<p data-paragraph-id="reading-p2"><span data-sentence-id="reading-s2"><ruby>背中<rt>せなか</rt></ruby>をもう一度読む。</span></p>`
    + Array.from({length:24},(_,i)=>`<p data-paragraph-id="reading-long-${i}"><span data-sentence-id="reading-long-s-${i}">静かな部屋で、本の続きをゆっくり読む。</span></p>`).join("");
  const response=await page.request.post("/api/documents",{data:{title:`阅读高亮 ${info.project.name}`,kind:"article",orientation:"horizontal",bodyHtml,sourceImages:sources.map(id=>({id}))}});
  expect(response.status()).toBe(201); const document=await response.json();
  const text=bodyText(document.bodyHtml);
  try {
    const createGroup=async(start,question)=>{
      const end=start+2;
      const result=await page.request.post(`/api/documents/${document.id}/conversations`,{data:{operation:"custom",question,selection:{start,end,text:text.slice(start,end),bodyHash:document.bodyHash,sentenceIds:bodyRanges(document.bodyHtml).sentences.filter(s=>s.start<end&&s.end>start).map(s=>s.id)}}});
      expect(result.ok()).toBe(true);return result.json();
    };
    const first=await createGroup(0,"第一个背中"); const groupA=first.groups[0].id;
    const second=await createGroup(text.indexOf("背中",2),"第二个背中"); const groupB=second.groups.find(g=>g.id!==groupA).id;
    await page.goto(`/#${document.id}`);
    const article=page.getByRole("article",{name:"日语原文",exact:true});
    await expect(article.locator(".article-qa-highlight").first()).toBeAttached();
    if (info.project.name === "desktop") {
      await article.locator("rt").first().hover();
      const sentence=article.locator('[data-sentence-id="reading-s1"]');
      await expect.poll(()=>sentence.evaluateAll(nodes=>nodes.every(node=>node.classList.contains("sentence-hovered")))).toBe(true);
      await expect(article.locator('[data-highlight-sentence-id="reading-s1"].active').first()).toHaveCSS("background-color","rgb(238, 235, 226)");
      await expect(article.locator('[data-highlight-sentence-id="reading-s2"].active')).toHaveCount(0);
    }
    const covered=await article.evaluate(root=>[...root.querySelectorAll('mark[data-qa-group-ids]')].every(mark=>{
      const rt=mark.closest("ruby")?.querySelector("rt");if(!rt)return true;
      const reading=rt.getBoundingClientRect();
      return [...root.querySelectorAll(".article-qa-highlight")].some(decoration=>{
        const box=decoration.getBoundingClientRect();return box.top<=reading.top&&box.bottom>=reading.bottom&&box.left<=reading.left+1&&box.right>=reading.right-1;
      });
    }));
    expect(covered).toBe(true);
    const chat=page.getByRole("region",{name:"原文 AI 讨论",exact:true});
    await article.locator(`mark[data-qa-group-ids="${groupB}"]`).first().click();
    await expect(chat.locator(".chat-message.user")).toContainText("第二个背中");
    await expect(chat.locator(".chat-message.user")).toHaveCount(1);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    await selectArticleText(page,"背中",0);
    await expect(page.getByRole("dialog",{name:"划词提问"})).toBeVisible();
    await expect(chat).toHaveCount(0);
    await page.getByRole("button",{name:"关闭划词提问"}).click();
    await page.evaluate(()=>getSelection().removeAllRanges());
    if (info.project.name === "desktop") {
      const mark=article.locator(`mark[data-qa-group-ids="${groupA}"]`).first();
      await mark.focus(); await mark.press("Enter");
      await expect(chat.locator(".chat-message.user")).toContainText("第一个背中");
      await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
      await page.getByRole("slider",{name:"阅读字号"}).fill("34");
      await expect(article.locator(".article-body")).toHaveCSS("font-size","34px");
      await page.emulateMedia({reducedMotion:"reduce"});
      await expect(article.locator(".article-sentence-highlight").first()).toHaveCSS("transition-duration","0s");
    }
    await page.evaluate(()=>scrollTo(0,600));
    const before=await page.evaluate(()=>({top:scrollY,width:document.querySelector(".article-body").clientWidth}));
    await page.getByRole("button",{name:"对话记录",exact:true}).evaluate(button=>button.click());
    await expect(chat).toBeVisible();
    expect(await page.evaluate(()=>({top:scrollY,width:document.querySelector(".article-body").clientWidth}))).toEqual(before);
    await chat.locator(".chat-messages").evaluate(element=>{element.scrollTop=0;});
    expect(await page.evaluate(()=>scrollY)).toBe(before.top);
    await chat.getByRole("button",{name:"关闭 AI 讨论",exact:true}).click();
    expect(await page.evaluate(()=>scrollY)).toBe(before.top);
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:`artifacts/reading-polish-${info.project.name}.png`,fullPage:true});
  } finally {
    const current=await page.request.get(`/api/documents/${document.id}`);
    if(current.ok()) await page.request.delete(`/api/documents/${document.id}`,{data:{revision:(await current.json()).revision}});
  }
});
