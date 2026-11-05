import {test,expect} from "@playwright/test";
import {parseText} from "../../shared/document.mjs";
import {applySentenceBoundaries,blocksToHtml} from "../../shared/article-html.mjs";

const createdAt="2026-11-04T10:00:00Z";
async function fixture(page) {
  const state={calls:[],task:{id:"prepare-14",type:"preparation",title:"十四元気茶",status:"running",state:"running",version:3,documentId:"doc",createdAt,updatedAt:createdAt,canRetry:false,canDelete:false,progress:{completed:1,total:3},steps:[{id:"correction",title:"PDF 第105页 · 正文校对",status:"running",execution:{providerId:"api_base",model:"test-model",role:"correction",queueMs:1200,elapsedMs:2000}},{id:"segment",title:"分句",status:"dependency_wait"}]}};
  await page.route("**/api/**",async(route)=>{
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice(4),method=request.method();
    let body={};try{body=request.postDataJSON() || {};}catch{}
    state.calls.push({path,method,body,search:url.search});
    const send=(value,status=200)=>route.fulfill({status,json:value});
    if(path==="/session")return send({user:{id:"user",username:"reader",isAdmin:false},needsSetup:false});
    if(path==="/documents")return send({documents:state.document ? [state.document] : []});
    if(path==="/books")return send({books:state.book ? [state.book] : []});
    if(path==="/books/book" && method==="GET")return send(state.book);
    if(path==="/books/book" && method==="DELETE"){state.book=null;return send({ok:true});}
    if(path==="/documents/article" && method==="GET")return send(state.document);
    if(path==="/documents/article" && method==="DELETE"){state.document=null;return send({ok:true});}
    if(path==="/documents/article/conversations")return send({conversations:[]});
    if(path==="/tasks")return send({tasks:url.searchParams.get("type")==="image" ? [] : [state.task],total:1,counts:{active:0,archived:0}});
    if(path==="/tasks/prepare-14" && method==="GET")return send(state.task);
    if(path==="/tasks/prepare-14/retry"){
      if(body.version!==state.task.version)return send({error:"任务已更新"},409);
      state.task={...state.task,status:"running",state:"running",version:state.task.version+1,canDelete:false,canRetry:false};return send(state.task);
    }
    if(path==="/tasks/prepare-14" && method==="DELETE")return send({ok:true});
    if(path==="/imports/imp" && method==="GET")return send({id:"imp",title:"原始 PDF 草稿",status:"staged",detectedType:"scan_pdf",allowedTypes:["scan_pdf","text_pdf"],context:{bookId:null,targetId:null},chapterAttempted:true,chapterProcessing:{status:"done",type:"scan_pdf",completedPages:10,totalPages:10},chapters:[{id:"chapter",title:"十四元気茶",startPage:1,endPage:10,needsReview:false}],files:[{id:"file",name:"original.pdf"}]});
    return send({error:`Missing fixture ${method} ${path}`},404);
  });
  return state;
}
async function openShelf(page) {
  const toggle=page.getByRole("button",{name:"打开书架",exact:true});
  if(await toggle.isVisible())await toggle.click();
}

async function bookNavigationFixture(page,{failUnknown=false,delayChapter=false}={}) {
  await fixture(page);
  const blocks=parseText("本文を読む。"),bodyHtml=applySentenceBoundaries(blocksToHtml(blocks),["本文を読む。"]);
  const documents=[{id:"a1",title:"同书第一章",bookId:"a"},{id:"a2",title:"同书第二章",bookId:"a"},{id:"b1",title:"另一书第一章",bookId:"b"}].map(item=>({...item,preview:"本文を読む。",blocks,bodyHtml,revision:1,kind:"article",updatedAt:createdAt}));
  const books=[{id:"a",title:"原来的书",pages:documents.slice(0,2)},{id:"b",title:"另一本书",pages:documents.slice(2)}];
  let reads=0,releaseKnown,releaseUnknown,releaseChapter,finishKnown;
  const known=new Promise(resolve=>releaseKnown=resolve),unknown=new Promise(resolve=>releaseUnknown=resolve),chapter=new Promise(resolve=>releaseChapter=resolve),knownReturned=new Promise(resolve=>finishKnown=resolve);
  await page.route("**/api/**",async route=>{
    const path=new URL(route.request().url()).pathname;
    if(path==="/api/documents")return route.fulfill({json:{documents}});
    if(path==="/api/books")return route.fulfill({json:{books}});
    const document=documents.find(item=>path===`/api/documents/${item.id}`);
    if(document){if(delayChapter&&document.id==="a2")await chapter;return route.fulfill({json:document});}
    if(path.endsWith("/conversations"))return route.fulfill({json:{conversations:[]}});
    if(path==="/api/books/a"){
      if(++reads>1){await known;try{return await route.fulfill({json:books[0]});}finally{finishKnown();}}
      return route.fulfill({json:books[0]});
    }
    if(path==="/api/books/b"){
      await unknown;
      return route.fulfill(failUnknown ? {status:503,json:{error:"目录请求失败"}} : {json:books[1]});
    }
    return route.fallback();
  });
  return {releaseKnown,releaseUnknown,releaseChapter,knownReturned};
}

test("chapter navigation keeps the known table of contents during refresh and rejects a late response from another book",async({page})=>{
  const gates=await bookNavigationFixture(page,{delayChapter:true});
  try{
    await page.goto("/#a1");
    const selector=page.getByLabel("书籍文章",{exact:true});
    await expect(selector.locator("option")).toHaveCount(2);
    await selector.selectOption("a2");
    await expect(selector).toHaveValue("a2");
    await expect(selector.locator("option")).toHaveCount(2);
    gates.releaseChapter();
    await expect(page.getByRole("heading",{name:"同书第二章",exact:true})).toBeVisible();
    await expect(selector).toHaveValue("a2");
    await expect(selector.locator("option")).toHaveCount(2);
    await expect(page.getByText(/目录暂未加载/)).toHaveCount(0);
    await page.evaluate(()=>location.hash="b1");
    await expect(page.getByRole("heading",{name:"另一书第一章",exact:true})).toBeVisible();
    await expect(page.getByText("正在加载目录…",{exact:true})).toBeVisible();
    await expect(selector).toHaveCount(0);
    gates.releaseUnknown();
    await expect(selector.locator("option")).toHaveCount(1);
    await expect(page.getByRole("button",{name:"返回书籍：另一本书",exact:true})).toBeVisible();
    gates.releaseKnown();
    await gates.knownReturned;
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(selector).toHaveValue("b1");
    await expect(page.getByRole("button",{name:"返回书籍：原来的书",exact:true})).toHaveCount(0);
  }finally{gates.releaseKnown();gates.releaseUnknown();gates.releaseChapter();}
});

test("an unknown book directory reports failure only after its request fails",async({page})=>{
  const gates=await bookNavigationFixture(page,{failUnknown:true});
  try{
    await page.goto("/#b1");
    await expect(page.getByText("正在加载目录…",{exact:true})).toBeVisible();
    await expect(page.getByText(/目录暂未加载/)).toHaveCount(0);
    gates.releaseUnknown();
    await expect(page.getByText(/目录暂未加载/)).toBeVisible();
    await expect(page.getByText("正在加载目录…",{exact:true})).toHaveCount(0);
  }finally{gates.releaseKnown();gates.releaseUnknown();}
});

test("unified task entry stays visible with zero active tasks and filters task types",async({page},info)=>{
  const state=await fixture(page);await page.goto("/#tasks");
  await expect(page.getByRole("heading",{name:"任务与导入草稿",exact:true})).toBeVisible();
  await openShelf(page);
  await expect(page.getByRole("button",{name:"任务与导入草稿",exact:true})).toBeVisible();
  if(info.project.name==="phone")await page.getByRole("button",{name:"任务与导入草稿",exact:true}).click();
  await expect(page.getByRole("article").filter({hasText:"十四元気茶"})).toContainText("正文准备");
  await page.getByLabel("任务类型",{exact:true}).selectOption("image");
  await expect(page.getByRole("article").filter({hasText:"十四元気茶"})).toHaveCount(0);
  expect(state.calls.some(call=>call.path==="/tasks" && call.search.includes("type=image"))).toBe(true);
  await page.getByRole("tab",{name:"已归档",exact:true}).click();
  await expect.poll(()=>state.calls.some(call=>call.search.includes("scope=archived"))).toBe(true);
  await page.screenshot({path:`artifacts/unified-tasks-list-${info.project.name}.png`,fullPage:true});
});

for(const target of ["task","book","article"])test(`${target} deletion uses an accessible page dialog for cancel, Escape and keyboard confirmation`,async({page},info)=>{
  const state=await fixture(page);
  let nativeDialogs=0;
  page.on("dialog",async dialog=>{nativeDialogs++;await dialog.dismiss();});
  let trigger,deletePath,dialogName,scopeText,confirmLabel;
  if(target==="task"){
    state.task={...state.task,status:"failed",state:"failed",canDelete:true};
    await page.goto("/#tasks/prepare-14");
    trigger=page.getByRole("button",{name:"删除任务",exact:true});deletePath="/tasks/prepare-14";
    dialogName="删除任务";scopeText="文章、原始文件和原页预览会保留";confirmLabel="删除任务";
  }else if(target==="book"){
    state.book={id:"book",title:"待删除的测试书",revision:7,pages:[{id:"a",title:"第一篇",charCount:1,rubyCount:0},{id:"b",title:"第二篇",charCount:1,rubyCount:0}]};
    await page.goto("/#book/book");
    trigger=page.getByRole("button",{name:"删除书籍",exact:true});deletePath="/books/book";
    dialogName="删除书籍";scopeText="全部 2 篇文章";confirmLabel="删除书籍";
  }else{
    const blocks=parseText("本文を読む。");
    state.document={id:"article",title:"待删除的测试文章",preview:"本文を読む。",revision:9,kind:"article",orientation:"horizontal",blocks,bodyHtml:applySentenceBoundaries(blocksToHtml(blocks),["本文を読む。"]),updatedAt:createdAt};
    await page.goto("/#article");
    trigger=page.getByRole("button",{name:"删除材料",exact:true});deletePath="/documents/article";
    dialogName="删除整篇文章";scopeText="正文和讨论将一起删除";confirmLabel="删除整篇文章";
  }
  const deletions=()=>state.calls.filter(call=>call.path===deletePath&&call.method==="DELETE");
  const dialog=page.getByRole("dialog",{name:dialogName,exact:true});
  await trigger.click();
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(scopeText);
  await expect(dialog).toContainText("无法撤销");
  await expect(dialog.getByRole("button",{name:"取消",exact:true})).toBeFocused();
  expect(deletions()).toEqual([]);
  await dialog.getByRole("button",{name:"取消",exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(deletions()).toEqual([]);
  await trigger.click();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(deletions()).toEqual([]);
  await trigger.click();
  await page.keyboard.press("Tab");
  await expect(dialog.getByRole("button",{name:confirmLabel,exact:true})).toBeFocused();
  await page.keyboard.press("Tab");
  await expect.poll(()=>dialog.evaluate(element=>element.contains(document.activeElement))).toBe(true);
  await dialog.getByRole("button",{name:confirmLabel,exact:true}).focus();
  await page.screenshot({path:`artifacts/${target}-delete-confirmation-${info.project.name}.png`,fullPage:true});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.keyboard.press("Enter");
  await expect(dialog).toHaveCount(0);
  await expect.poll(()=>deletions().length).toBe(1);
  expect(deletions()[0].body).toEqual(target==="task" ? {version:3} : {revision:target==="book" ? 7 : 9});
  expect(nativeDialogs).toBe(0);
});

test("preparation detail shows dependency and execution states without running delete or cancel",async({page},info)=>{
  const state=await fixture(page);state.task.canDelete=true;
  await page.goto("/#tasks/prepare-14");
  const detail=page.getByRole("region",{name:"任务状态",exact:true});
  await expect(detail).toContainText("PDF 第105页");
  await expect(detail).toContainText("等待依赖");
  await expect(detail.getByRole("button",{name:"删除任务",exact:true})).toHaveCount(0);
  await expect(detail.getByRole("button",{name:/取消|停止任务/})).toHaveCount(0);
  await expect(detail).toContainText("排队 1 秒");
  await expect(detail).toContainText("执行 2 秒");
  await page.screenshot({path:`artifacts/unified-task-detail-${info.project.name}.png`,fullPage:true});
});

test("timeout task retries only via server capability and latest version",async({page})=>{
  const state=await fixture(page);state.task={...state.task,status:"timeout",state:"timeout",canRetry:true,canDelete:true,error:"远端步骤执行超时，成功校对已保留。",steps:[{id:"correct",title:"正文校对",status:"completed"},{id:"segment",title:"分句",status:"timeout",error:"执行超过180秒"}]};
  await page.goto("/#tasks/prepare-14");
  await expect(page.getByRole("button",{name:"删除任务",exact:true})).toBeVisible();
  await expect(page.getByRole("region",{name:"任务状态",exact:true})).toContainText("成功校对已保留");
  await page.getByRole("button",{name:"重试失败步骤",exact:true}).click();
  await expect(page.getByRole("button",{name:"重试失败步骤",exact:true})).toHaveCount(0);
  expect(state.calls.filter(call=>call.path.endsWith("/retry")).map(call=>call.body)).toEqual([{version:3}]);
  await expect(page.getByRole("button",{name:"删除任务",exact:true})).toHaveCount(0);
});

test("file task continues the exact persisted PDF draft and chapter review",async({page})=>{
  const state=await fixture(page);state.task={...state.task,type:"import",title:"原始 PDF 草稿",documentId:null,importId:"imp",status:"requires_review",state:"requires_review",canOpenResult:true};
  await page.goto("/#tasks/prepare-14");
  await page.getByRole("button",{name:"继续导入",exact:true}).click();
  await expect(page.getByRole("region",{name:"统一导入",exact:true})).toBeVisible();
  await expect(page.getByLabel("章节 1 标题",{exact:true})).toHaveValue("十四元気茶");
  await expect(page.getByLabel("作为书籍导入",{exact:true})).toBeChecked();
  await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeEnabled();
});

test("PDF task pages stay collapsed until opened and retain individual errors",async({page})=>{
  const state=await fixture(page);state.task.steps[0].children=[{id:"page105",title:"PDF 第105页",page:105,status:"completed"},{id:"page106",title:"PDF 第106页",page:106,status:"failed",error:"此页 OCR 失败，前一页已保留"}];
  await page.goto("/#tasks/prepare-14");
  await expect(page.getByText("此页 OCR 失败，前一页已保留",{exact:true})).not.toBeVisible();
  await page.getByText("查看子步骤（2）",{exact:true}).click();
  await expect(page.getByText("此页 OCR 失败，前一页已保留",{exact:true})).toBeVisible();
});

test("manual image annotation remains active while the native failed checkpoint is retained",async({page})=>{
  const state=await fixture(page);state.task={...state.task,type:"image",state:"needs_attention",status:"running",canReview:true,canRetry:true,canDelete:true,items:[{id:"photo1",name:"原图",status:"failed",error:"上次注音失败"}],counts:{total:1,uploaded:1,completed:0},steps:[{id:"manual:photo1",step:"annotate",status:"running"}]};
  await page.goto("/#tasks/prepare-14");
  const detail=page.getByRole("region",{name:"任务状态",exact:true});
  await expect(detail).toContainText("当前手动注音仍在后台执行");
  await expect(detail.getByRole("button",{name:/校对|重试|删除任务/})).toHaveCount(0);
});
