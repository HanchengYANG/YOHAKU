import { test, expect } from "@playwright/test";
import sharp from "sharp";
import { randomUUID } from "node:crypto";
import { parseText } from "../../shared/document.mjs";
import { applySentenceBoundaries, blocksToHtml } from "../../shared/article-html.mjs";
import { ensureOwnerSession } from "./session.mjs";
import { discardFixtureTasks } from "./image-task-fixture.mjs";

let cookies = [];
test.beforeEach(async ({ page }) => {
  if (cookies.length) await page.context().addCookies(cookies);
  await ensureOwnerSession(page.request);
  cookies = await page.context().cookies();
  expect((await page.request.post("/api/ai/login", { data:{} })).ok()).toBe(true);
  expect((await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code")).ok()).toBe(true);
});

async function remove(page, id) {
  const response = await page.request.get(`/api/documents/${id}`);
  if (response.ok()) await page.request.delete(`/api/documents/${id}`, {data:{revision:(await response.json()).revision}});
}
const inputFor = page => page.getByRole("textbox", {name:"日语正文",exact:true});
test("追加任务的校对页能删除目标整篇文章并返回书籍，其他文章保留并重新排序",async({page},info)=>{
  const bookResponse=await page.request.post("/api/books",{data:{title:`删除文章书籍 ${info.project.name}`}});
  expect(bookResponse.ok()).toBe(true);
  const book=await bookResponse.json(), articles=[];
  let taskId;
  try {
    for(let index=1;index<=2;index++) {
      const html=applySentenceBoundaries(blocksToHtml(parseText(`保存的第${index}篇正文。`)),[`保存的第${index}篇正文。`]);
      const response=await page.request.post("/api/documents",{data:{title:`保留与删除 ${index}`,kind:"book",orientation:"horizontal",bookId:book.id,bodyHtml:html}});
      expect(response.ok()).toBe(true);articles.push(await response.json());
    }
    let response=await page.request.post("/api/image-tasks",{data:{idempotencyKey:randomUUID(),title:"待追加图片",bookId:book.id,targetId:articles[0].id}});
    expect(response.ok()).toBe(true);
    let task=await response.json();taskId=task.id;
    const itemId=randomUUID();
    response=await page.request.post(`/api/image-tasks/${task.id}/items`,{data:{version:task.version,items:[{id:itemId,name:"追加原图.png"}]}});
    expect(response.ok()).toBe(true);task=await response.json();
    const bytes=await sharp({create:{width:160,height:220,channels:3,background:"#ddd"}}).png().toBuffer();
    response=await page.request.post(`/api/image-tasks/${task.id}/items/${itemId}/image`,{multipart:{image:{name:"追加原图.png",mimeType:"image/png",buffer:bytes}}});
    expect(response.ok()).toBe(true);task=await response.json();
    expect((await page.request.post(`/api/image-tasks/${task.id}/submit`,{data:{version:task.version}})).status()).toBe(202);
    await expect.poll(async()=>{
      const current=await page.request.get(`/api/image-tasks/${task.id}`);
      expect(current.ok()).toBe(true);return(await current.json()).state;
    }).toBe("ready");
    await page.goto(`/#tasks/${task.id}`);
    await page.getByRole("button",{name:"开始校对",exact:true}).click();
    await expect(page.locator(".editor-page")).toBeVisible();
    await expect(inputFor(page)).not.toHaveValue("");
    const deleteArticle=page.getByRole("button",{name:"删除整篇文章",exact:true});
    await expect(deleteArticle).toBeEnabled();
    const deleted=page.waitForResponse(result=>result.request().method()==="DELETE"&&new URL(result.url()).pathname===`/api/documents/${articles[0].id}`);
    await deleteArticle.click();
    await page.getByRole("dialog",{name:"删除整篇文章",exact:true}).getByRole("button",{name:"删除整篇文章",exact:true}).click();
    expect((await deleted).status()).toBe(204);
    await expect(page.locator(".editor-page")).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`#book/${book.id}$`));
    expect((await page.request.get(`/api/documents/${articles[0].id}`)).status()).toBe(404);
    const remaining=await(await page.request.get(`/api/books/${book.id}`)).json();
    expect(remaining.pages.map(article=>article.id)).toEqual([articles[1].id]);
    expect(remaining.pages[0].position).toBe(1);
    const retainedTask=await page.request.get(`/api/image-tasks/${task.id}`);
    expect(retainedTask.ok()).toBe(true);
    expect((await retainedTask.json()).appliedDocumentId).toBeNull();
  } finally {
    if(taskId)discardFixtureTasks([taskId]);
    for(const article of articles)await remove(page,article.id);
    const current=await page.request.get(`/api/books/${book.id}`);
    if(current.ok())await page.request.delete(`/api/books/${book.id}`,{data:{revision:(await current.json()).revision}});
  }
});
