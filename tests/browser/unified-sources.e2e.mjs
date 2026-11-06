import { test, expect } from "@playwright/test";
import { parseText } from "../../shared/document.mjs";
import { blocksToHtml, initializeSentenceBoundaries, bodyText } from "../../shared/article-html.mjs";
import sharp from "sharp";
import {mkdir,writeFile} from "node:fs/promises";
import {createServer} from "node:http";
const html = (text) => initializeSentenceBoundaries(blocksToHtml(parseText(text)),[text]);
const original = "今日は空を見た。";
async function showShelf(page) {
  await expect(page.getByRole("button",{name:"添加",exact:true})).toBeAttached();
  const toggle=page.getByRole("button",{name:"打开书架",exact:true});
  if(await toggle.isVisible())await toggle.click();
}
async function fixture(page, options = {}) {
  const source1 = {id:"s1",type:"photo",position:0,version:1,checked:false,status:"ready",processing:false,bodyHtml:html("写真の本文。"),preview:{type:"image",url:"/pixel.svg"},firstExtraction:{text:"写真の本文。",label:"AI 识别与校正结果"},changes:[],articleStart:0,...options.source1};
  let source2 = {id:"s2",type:"text",position:1,version:7,checked:true,status:"ready",processing:false,bodyHtml:html(original),preview:{type:"text",text:"保存された原文。"},firstExtraction:{text:original,label:"首次提取结果"},changes:[],articleStart:6,...options.source};
  let document = {id:"doc",title:"分页阅读资料",kind:"article",orientation:"horizontal",sourceWorkflow:true,bodyHtml:html(`写真の本文。${original}`),bodyHash:"hash",blocks:parseText(`写真の本文。${original}`),revision:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  const calls = [], saves = [];
  let chapterPolls = 0;
  const chapterProposal = [{id:"ch1",title:"第一章",startPage:2,endPage:8,needsReview:true,excluded:false},{id:"ch2",title:"付録",startPage:9,endPage:10,needsReview:true,excluded:false}];
  const importDraft = {id:"imp",title:"导入文字",detectedType:options.importType || "text",allowedTypes:options.importType === "screenshot" ? ["photo","screenshot"] : [options.importType || "text"],files:[{id:"file",name:"original.pdf"}],chapters:[],status:"staged",...options.draft};
  const proposedExclusions = [{page:1,startLine:1,endLine:2,reason:"重复页眉",text:"版権所有・学習資料",excluded:true},{page:3,startLine:8,endLine:10,reason:"与正文无关的广告",text:"関連図書のお知らせ",excluded:true},...(options.extraExclusions || [])];
  const pageAt = (index) => ({id:`p${index}`,index,ready:true,bodyHtml:options.emptyPublished && !index ? "<p></p>" : index ? html("次の読書ページ。") : source2.bodyHtml,sourceIds:index ? ["s1"] : ["s2"],start:index ? 20 : 6,end:index ? 30 : 6 + bodyText(source2.bodyHtml).length,
    ...(!index ? options.firstPage : {})});
  let currentIndex = 0;
  await page.route("**/pixel.svg", (route) => route.fulfill({contentType:"image/svg+xml",body:'<svg xmlns="http://www.w3.org/2000/svg" width="500" height="700"><rect width="500" height="700" fill="white"/><text x="50" y="50">original</text></svg>'}));
  await page.route("**/api/**", async (route) => {
    const request=route.request(),url=new URL(request.url()),path=url.pathname.slice(4),method=request.method();
    let input;try{input=request.postDataJSON();}catch{input={};}
    calls.push({path,method,input});
    const respond = (value,status=200) => route.fulfill({status,contentType:"application/json",body:JSON.stringify(value)});
    if(path==="/session")return respond({user:{id:"user",username:"reader",isAdmin:false},needsSetup:false});
    if(path==="/documents")return respond({documents:[{...document,charCount:20,rubyCount:0,preview:original}]});
    if(path==="/books")return respond({books:[]});
    if(path.startsWith("/image-tasks") || path==="/tasks")return respond({counts:{},activeCount:0,tasks:[]});
    if(path==="/documents/doc")return respond(document);
    if(path==="/documents/doc/conversations")return respond(method === "POST" ? {id:"conversation",documentId:"doc",messages:[],groups:[]} : {conversations:[]});
    if(path==="/documents/doc/reading-pages" || path==="/documents/doc/reading-session"){
      if(method==="POST" && input.active===false)return respond({sessionId:"test"});
      currentIndex=method==="POST" ? (input.index ?? currentIndex) : Number(url.searchParams.get("index") || currentIndex);
      if(options.empty)return respond({pages:[],currentPage:null,index:0,position:0,complete:true,totalPages:0,hasNext:false,processing:false});
      if(options.pendingNext && currentIndex > 0)return respond({pages:[pageAt(0)],currentPage:pageAt(0),index:0,position:0,complete:false,hasNext:true,processing:true});
      return respond({pages:[pageAt(0),pageAt(1)],currentPage:pageAt(currentIndex),index:currentIndex,position:currentIndex,hasNext:currentIndex===0,complete:false,processing:false});
    }
    if(path==="/documents/doc/sources")return respond({sources:[source1,source2,...(options.extraSources || [])]});
    if(path.startsWith("/documents/doc/sources/")){
      const id=path.split("/")[4],item=id==="s1" ? source1 : source2;
      if(method==="PUT") {saves.push(input);source2={...source2,bodyHtml:input.bodyHtml,version:8,checked:false};document={...document,revision:2};return respond(source2);}
      if(path.endsWith("/checked")){source2={...source2,checked:input.checked};return respond(source2);}
      return respond(item);
    }
    if(path==="/imports" && method==="GET")return respond({drafts:options.serverDrafts || []});
    if(path==="/imports" && method==="POST")return respond(importDraft);
    if(path==="/imports/imp/chapters"){
      Object.assign(importDraft,{title:input.title || importDraft.title,chapterAttempted:true});
      if(options.asyncChapters){importDraft.chapterProcessing={status:options.queuedChapters ? "queued" : "extracting",type:input.type,completedPages:0,totalPages:10};return respond(importDraft,202);}
      importDraft.chapters=chapterProposal;return respond(importDraft);
    }
    if(path==="/imports/imp" && method==="GET"){
      chapterPolls++;
      const chapterProcessing = options.keepExtracting || chapterPolls === 1 ? {status:"extracting",completedPages:3,totalPages:10}
        : chapterPolls === 2 ? {status:"proposing",completedPages:10,totalPages:10}
          : options.failChapters ? {status:"failed",completedPages:10,totalPages:10,error:"AI 分章失败，请对照原文件手工添加章节。"} : {status:"done",completedPages:10,totalPages:10};
      return respond({...importDraft,chapterProcessing:{...importDraft.chapterProcessing,...chapterProcessing},...(chapterProcessing.status === "done" ? {chapters:chapterProposal,exclusions:proposedExclusions} : {})});
    }
    if(path==="/imports/imp/confirm")return respond({id:"imp",documents:[document],firstDocumentId:"doc"});
    return respond({error:`Missing fixture route ${method} ${path}`},404);
  });
  return {calls,saves};
}

async function preparationFixture(page,{holdHeartbeat=false,unpublished=false}={}) {
  await fixture(page);
  const state={stage:"correct",percent:null,completed:1,total:null,ready:false,polls:0,releaseHeartbeat:null,diagnostics:null,error:null};
  const snapshot=()=>{
    const currentPage=unpublished&&!state.ready ? null : {id:"p0",index:0,ready:state.ready,bodyHtml:state.ready?(state.bodyHtml || html(original)):"",sourceIds:["s2"],start:6,end:6+original.length};
    const pages=[...(currentPage?[currentPage]:[]),...(state.extraPages || [])];
    return {pages,currentPage,index:0,position:0,complete:state.ready,...(state.ready?{totalPages:pages.length}:{}),hasNext:pages.length>1,processing:!state.ready,...(state.bodyHash?{bodyHash:state.bodyHash}:{}),
      ...(state.provisionalPreview?{provisionalPreview:state.provisionalPreview}:{}),
      preparation:{stage:state.ready?"ready":state.stage,percent:state.ready?100:state.percent,completed:state.completed,total:state.total},...(state.taskId?{taskId:state.taskId}:{}),...(state.diagnostics?{diagnostics:state.diagnostics}:{}),...(state.error?{error:state.error}:{})};
  };
  let firstHeartbeat=true;
  await page.route("**/api/documents/doc/reading-*",async(route)=>{
    const request=route.request();
    if(request.method()==="POST"){
      const input=request.postDataJSON();
      if(input.active===false)return route.fulfill({json:{sessionId:"test"}});
      if(holdHeartbeat&&firstHeartbeat){
        firstHeartbeat=false;const old=snapshot();
        await new Promise(resolve=>state.releaseHeartbeat=resolve);
        return route.fulfill({json:old});
      }
    }else state.polls++;
    return route.fulfill({json:snapshot()});
  });
  return state;
}

async function firstPublicationFixture(page,{holdReturningGet=false,lateDocuments=false}={}) {
  await fixture(page);
  const state={phase:"review",version:7,bodyHtml:html(original),events:[],documentReads:0,pendingDocuments:0,heldGet:false};
  const proposalHtml=html("AI 整段改写后的提议。");
  let releaseDocuments,releaseGet;
  const documentsGate=new Promise(resolve=>releaseDocuments=resolve),getGate=new Promise(resolve=>releaseGet=resolve);
  state.releaseDocuments=releaseDocuments;state.releaseGet=releaseGet;
  const record=(kind,data={})=>state.events.push({at:Date.now(),kind,...data});
  const source=()=>({id:"s2",type:"text",position:0,version:state.version,checked:false,status:state.phase==="review"?"requires_review":state.phase==="ready"?"ready":"pending",processing:state.phase==="segment",manual:state.version>7,
    bodyHtml:state.bodyHtml,preview:{type:"text",text:original},firstExtraction:{text:original},changes:[],articleStart:0,
    ...(state.phase==="review"?{proposal:{bodyHtml:proposalHtml}}:{})});
  const snapshot=()=>{
    const currentPage=state.phase==="ready"?{id:"first-published-page",index:0,ready:true,bodyHtml:state.bodyHtml,sourceIds:["s2"],start:0,end:bodyText(state.bodyHtml).length}:null;
    return {pages:currentPage?[currentPage]:[],currentPage,index:0,position:0,complete:!!currentPage,totalPages:currentPage?1:undefined,hasNext:false,processing:state.phase==="segment",bodyHash:`source-version-${state.version}`,taskId:"first-publication-task",
      preparation:{stage:state.phase==="ready"?"ready":state.phase==="review"?"correct":"segment",percent:state.phase==="ready"?100:null},
      diagnostics:{current:state.phase==="ready"?null:{state:state.phase==="review"?"requires_review":"queued",step:state.phase==="review"?"correct":"segment",source:{id:"s2",type:"text",label:"来源 1"}},recentFailures:[]},
      ...(state.phase==="review"?{error:"正文出现较大改动，请核对来源。"}:{})};
  };
  await page.route("**/api/documents/doc",async route=>{
    const reading=snapshot(),number=++state.documentReads;
    const value={id:"doc",title:"首次发布边界",kind:"article",sourceWorkflow:true,revision:state.version,bodyHtml:state.bodyHtml,blocks:parseText(bodyText(state.bodyHtml)),reading};
    record("document-start",{number,ready:!!reading.currentPage});
    if(lateDocuments&&number>1){state.pendingDocuments++;await documentsGate;}
    record("document-response",{number,ready:!!reading.currentPage});return route.fulfill({json:value});
  });
  await page.route("**/api/documents/doc/sources",route=>route.fulfill({json:{sources:[source()]}}));
  await page.route(/\/api\/documents\/doc\/sources\/s2(?:\/(?:edit|prepare|checked))?$/,route=>{
    const request=route.request();
    if(request.method()==="PUT"){
      state.bodyHtml=request.postDataJSON().bodyHtml;state.version++;state.phase="segment";record("manual-save",{version:state.version});
    }
    return route.fulfill({json:source()});
  });
  await page.route("**/api/documents/doc/reading-*",async route=>{
    const request=route.request(),input=request.method()==="POST"?request.postDataJSON():null;
    if(input?.active===false)return route.fulfill({json:{sessionId:"fixture"}});
    const value=snapshot(),kind=input?"heartbeat":"get";record(`${kind}-start`,{ready:!!value.currentPage,mode:input?.mode});
    if(!input&&holdReturningGet&&state.version>7&&!state.heldGet){state.heldGet=true;await getGate;}
    record(`${kind}-response`,{ready:!!value.currentPage,mode:input?.mode});return route.fulfill({json:value});
  });
  state.publish=()=>{state.phase="ready";record("publish-page-zero");};
  return state;
}

async function manuallyReviewFirstUnpublishedSource(page){
  await page.goto("/#doc");
  await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toContainText("正文出现较大改动");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await page.getByRole("button",{name:"核对并编辑此提议",exact:true}).click();
  await page.getByLabel("来源正文",{exact:true}).fill("ＩＭＣへようこそ。");
  await page.getByRole("button",{name:"保存正文",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"已保存，将仅补齐"})).toBeVisible();
  await page.getByRole("button",{name:"返回阅读",exact:true}).click();
  await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toContainText("等待分句");
}

test("first publication after manual review survives late empty document snapshots",async({page},info)=>{
  const state=await firstPublicationFixture(page,{lateDocuments:true});
  try{
    await manuallyReviewFirstUnpublishedSource(page);
    await expect.poll(()=>state.pendingDocuments).toBe(2);
    state.publish();await expect(page.getByLabel("日语原文")).toContainText("ＩＭＣへようこそ。");
    state.releaseDocuments();
    await expect.poll(()=>state.events.filter(event=>event.kind==="document-response").length).toBe(3);
    await expect(page.getByLabel("日语原文")).toContainText("ＩＭＣへようこそ。");
    await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toHaveCount(0);
  }finally{state.releaseDocuments();state.releaseGet();await info.attach("first-publication-events",{body:JSON.stringify(state.events,null,2),contentType:"application/json"});}
});

test("first publication after manual review recovers through heartbeat while its GET is hung",async({page},info)=>{
  const state=await firstPublicationFixture(page,{holdReturningGet:true});
  try{
    await manuallyReviewFirstUnpublishedSource(page);await expect.poll(()=>state.heldGet).toBe(true);
    state.publish();
    await expect(page.getByLabel("日语原文")).toContainText("ＩＭＣへようこそ。",{timeout:12000});
    expect(state.events.some(event=>event.kind==="heartbeat-response"&&event.mode==="reading"&&event.ready)).toBe(true);
    state.releaseGet();
    await expect(page.getByLabel("日语原文")).toContainText("ＩＭＣへようこそ。");
  }finally{state.releaseDocuments();state.releaseGet();await info.attach("first-publication-events",{body:JSON.stringify(state.events,null,2),contentType:"application/json"});}
});

test("reading preparation shows real progress then automatically displays the completed page",async({page},info)=>{
  const state=await preparationFixture(page);await page.goto("/#doc");
  const progress=page.getByRole("progressbar",{name:"当前阅读页准备进度",exact:true});
  await expect(progress).toBeVisible();await expect(progress).not.toHaveAttribute("aria-valuenow");
  await expect(page.getByLabel("日语原文")).toHaveCount(0);
  state.stage="annotate";state.percent=40;state.completed=400;state.total=1000;
  await expect(progress).toHaveAttribute("aria-valuenow","40");
  await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toContainText("正在注音");
  await page.screenshot({path:`artifacts/reading-progress-${info.project.name}.png`,fullPage:true});
  state.ready=true;
  await expect(page.getByLabel("日语原文")).toContainText(original);
  await expect(progress).toHaveCount(0);expect(state.polls).toBeGreaterThan(1);
});

test("an unpublished reading page shows a plain provisional preview during slow correction",async({page})=>{
  const state=await preparationFixture(page,{unpublished:true});
  const source={id:"s2",type:"screenshot",label:"图片 1"};
  state.diagnostics={current:{state:"running",step:"correct",source,elapsedMs:161000},recentFailures:[]};
  state.provisionalPreview={text:"走査した本文。\n<em>次の行</em>",truncated:true,source:{label:source.label}};
  await page.goto("/#doc");
  const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
  const preview=page.getByRole("region",{name:"已提取正文预览",exact:true});
  await expect(preparation).toContainText("正在校正正文");
  await expect(preparation).toHaveAttribute("aria-busy","true");
  await expect(preview).toBeVisible();
  await expect(preview).toContainText(source.label);
  await expect(preview).toContainText("准备完成后会自动显示正式阅读页");
  await expect(preview).toContainText("<em>次の行</em>…");
  await expect(preview.locator("em")).toHaveCount(0);
  expect(await preview.evaluate(element=>element.previousElementSibling?.getAttribute("aria-label"))).toBe("准备当前阅读页");
  await expect(page.getByLabel("日语原文")).toHaveCount(0);
  await expect(page.getByRole("button",{name:"对话记录",exact:true})).toHaveCount(0);
  await preview.evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  await expect(page.getByRole("dialog",{name:"划词提问",exact:true})).toHaveCount(0);

  state.ready=true;state.bodyHtml=html("校正された本文。");state.diagnostics.current=null;
  await expect(page.getByLabel("日语原文")).toContainText("校正された本文。");
  await expect(preview).toHaveCount(0);
});

test("image chapter heading starts a new visual line without changing reader offsets",async({page})=>{
  const lead="𠮷は",continuation="来た。",heading="次章",start=21;
  const bodyHtml=`<p data-paragraph-id="body"><span data-sentence-id="continuous"><span data-source-id="s1">${lead}</span><span data-source-id="s2">${continuation}</span></span><span data-sentence-id="chapter-heading"><span data-source-id="s3"><ruby data-origin="source">${heading}<rt>じしょう</rt></ruby></span></span></p>`;
  const state=await fixture(page,{firstPage:{bodyHtml,start,end:start+lead.length+continuation.length+heading.length,sourceIds:["s1","s2","s3"],headingSourceIds:["s3"]}});
  await page.goto("/#doc");
  const paragraph=page.getByLabel("日语原文").locator(".article-body > p");
  await expect(paragraph).toHaveCount(1);
  await expect(paragraph.locator("ruby rt")).toHaveText("じしょう");
  await page.evaluate(()=>document.fonts.ready);
  const boxes=await paragraph.evaluate(element=>{
    const character=(sourceId,fromEnd=false)=>{
      const source=element.querySelector(`[data-source-id="${sourceId}"]`);
      const text=document.createTreeWalker(source,NodeFilter.SHOW_TEXT).nextNode();
      const offset=fromEnd?text.length-1:0;
      const range=document.createRange();range.setStart(text,offset);range.setEnd(text,offset+1);
      return range.getBoundingClientRect().toJSON();
    };
    return {lead:character("s1",true),continuation:character("s2"),heading:character("s3")};
  });
  expect(Math.abs(boxes.lead.top-boxes.continuation.top)).toBeLessThan(2);
  expect(boxes.continuation.left).toBeGreaterThan(boxes.lead.left);
  expect(boxes.heading.top).toBeGreaterThan(boxes.continuation.bottom);
  const separator=paragraph.locator(".reading-source-break");
  await expect(separator).toHaveCount(1);
  await expect(separator).toHaveAttribute("aria-hidden","true");
  await expect(separator).toBeEmpty();

  await paragraph.locator('ruby [data-source-id="s3"]').evaluate(element=>{
    const range=document.createRange();range.selectNodeContents(element);
    const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);
    document.dispatchEvent(new Event("selectionchange"));
  });
  const popup=page.getByRole("dialog",{name:"划词提问",exact:true});
  await expect(popup).toContainText(heading);
  await popup.getByRole("button",{name:"翻译",exact:true}).click();
  const question=()=>state.calls.find(call=>call.path==="/documents/doc/conversations"&&call.method==="POST")?.input;
  const pageLocalStart=lead.length+continuation.length,pageLocalEnd=pageLocalStart+heading.length;
  await expect.poll(question).toMatchObject({operation:"translation",selection:{text:heading,readingPageId:"p0",pageLocalStart,pageLocalEnd,
    start:start+pageLocalStart,end:start+pageLocalEnd,sentenceIds:["chapter-heading"]}});
});

test("prepared source pages refresh authoritative shelf totals once per content change",async({page})=>{
  const state=await preparationFixture(page);
  const marked="{日|にち}".repeat(45)+"あ".repeat(225)+"。";
  const raw=blocksToHtml(parseText(marked));
  state.bodyHtml=initializeSentenceBoundaries(raw,[bodyText(raw)]);state.bodyHash="ready-first";
  let summaries=0,total=0;
  await page.route(/\/api\/documents(?:\?.*)?$/,route=>{
    summaries++;
    return route.fulfill({json:{documents:[{id:"doc",title:"分页阅读资料",kind:"article",charCount:total,rubyCount:total?45:0,preview:total?"日あ。":"",updatedAt:"2026-11-05T00:00:00Z"}]}});
  });
  await page.goto("/#doc");
  await showShelf(page);
  const shelfItem=page.getByRole("navigation",{name:"阅读材料",exact:true}).getByRole("button").filter({has:page.getByText("分页阅读资料",{exact:true})});
  await expect(shelfItem).toContainText("0 字");
  total=271;state.ready=true;
  await expect(page.getByLabel("日语原文")).toBeVisible();
  await expect(page.locator(".document-meta")).toContainText("271 字");
  await expect(page.locator(".document-meta")).toContainText("45 处注音");
  await expect(shelfItem).toContainText("271 字");
  const afterReady=summaries,previousPolls=state.polls;
  await expect.poll(()=>state.polls).toBeGreaterThan(previousPolls);
  expect(summaries).toBe(afterReady);
  total=351;
  state.extraPages=[{id:"p1",index:1,ready:true,bodyHtml:html("あ".repeat(79)+"。"),sourceIds:["s3"],start:271,end:351}];
  await expect(shelfItem).toContainText("351 字");
  await expect(page.locator(".document-meta")).toContainText("271 字");
  await page.locator(".brand").click();
  await expect(page.getByRole("region",{name:"我的阅读资料",exact:true})).toContainText("351");
  await expect(page.getByRole("button",{name:"继续阅读：分页阅读资料",exact:true})).toContainText("351 字");
});

test("reading preparation links to its existing background task",async({page})=>{
  const state=await preparationFixture(page);state.taskId="preparation-task";await page.goto("/#doc");
  await expect(page.getByRole("link",{name:"查看后台任务",exact:true})).toHaveAttribute("href","#tasks/preparation-task");
});

test("queued running and automatic backoff preparation cannot submit a manual retry",async({page})=>{
  const state=await preparationFixture(page);state.taskId="preparation-task";
  state.diagnostics={current:{state:"queued",step:"correct",source:{id:"s2",label:"PDF 第27页"}},recentFailures:[]};
  const requests=[];
  await page.route("**/api/documents/doc/reading-session",route=>{
    if(route.request().method()==="POST")requests.push(route.request().postDataJSON());
    return route.fallback();
  });
  await page.goto("/#doc");
  const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
  for(const [status,label] of [["queued","排队中"],["running","处理中"],["retry_wait","等待自动重试"]]){
    state.diagnostics.current={...state.diagnostics.current,state:status};
    await expect(preparation).toContainText(label);
    await expect(preparation.getByRole("button",{name:"重试准备",exact:true})).toHaveCount(0);
    await expect(preparation.getByRole("link",{name:"查看后台任务",exact:true})).toHaveAttribute("href","#tasks/preparation-task");
    await expect(preparation.getByRole("button",{name:"校对正文",exact:true})).toBeEnabled();
  }
  await expect.poll(()=>requests.filter(request=>request.active===true).length).toBeGreaterThan(0);
  expect(requests.filter(request=>request.retry===true)).toHaveLength(0);
});

test("failed preparation allows one explicit retry and hides it once queued again",async({page})=>{
  const state=await preparationFixture(page);state.taskId="preparation-task";state.error="远端正文校对失败";
  state.diagnostics={current:{state:"failed",step:"correct",source:{id:"s2",label:"PDF 第27页"}},recentFailures:[]};
  const requests=[];
  let releaseRetry;
  const retryGate=new Promise(resolve=>releaseRetry=resolve);
  await page.route("**/api/documents/doc/reading-session",async route=>{
    if(route.request().method()==="POST"){
      const input=route.request().postDataJSON();requests.push(input);
      if(input.retry){
        await retryGate;
        state.error=null;state.diagnostics.current={...state.diagnostics.current,state:"queued"};
      }
    }
    return route.fallback();
  });
  try{
    await page.goto("/#doc");
    const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
    await expect(preparation).toContainText("远端正文校对失败");
    await expect(preparation.getByRole("link",{name:"查看后台任务",exact:true})).toBeVisible();
    await preparation.getByRole("button",{name:"重试准备",exact:true}).click();
    await expect.poll(()=>requests.filter(request=>request.retry===true).length).toBe(1);
    const retry=requests.find(request=>request.retry===true);
    const onlinePosts=await page.evaluate(async()=>{
      const fetch=window.fetch;
      let posts=0;
      window.fetch=(url,options)=>{
        if(typeof url==="string"&&url.endsWith("/reading-session")&&options?.method==="POST")posts++;
        return fetch(url,options);
      };
      try{
        window.dispatchEvent(new Event("online"));
        await new Promise(resolve=>requestAnimationFrame(resolve));
        return posts;
      }finally{window.fetch=fetch;}
    });
    expect(onlinePosts).toBe(0);

    releaseRetry();
    await expect(preparation).toContainText("排队中");
    await expect(preparation.getByRole("button",{name:"重试准备",exact:true})).toHaveCount(0);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect.poll(()=>requests.some(request=>request.active===true&&!request.retry&&request.sequence>retry.sequence)).toBe(true);
    state.ready=true;await expect(page.getByLabel("日语原文")).toContainText(original);
    expect(requests.filter(request=>request.retry===true)).toHaveLength(1);
  }finally{releaseRetry();}
});

test("reopening a pending reading page restores its latest preparation progress",async({page})=>{
  const state=await preparationFixture(page);await page.goto("/#doc");
  const progress=page.getByRole("progressbar",{name:"当前阅读页准备进度",exact:true});
  await expect(progress).toBeVisible();
  state.stage="annotate";state.percent=80;state.completed=800;state.total=1000;
  await page.reload();await expect(progress).toHaveAttribute("aria-valuenow","80");
  state.ready=true;await expect(page.getByLabel("日语原文")).toContainText(original);
});

test("reading diagnostics show the queued and running source without inventing a completion estimate",async({page})=>{
  const state=await preparationFixture(page);
  state.diagnostics={current:{state:"queued",step:"correct",source:{id:"s2",type:"scan_pdf",label:"PDF 第27页",page:27},elapsedMs:65000,providerId:"api_base",model:"Deepseek/deepseek-v4-flash-0731",operationId:"operation-27"},recentFailures:[]};
  await page.goto("/#doc");
  const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
  await expect(preparation).toContainText("排队中");
  await expect(preparation).toContainText("PDF 第27页");
  await expect(preparation).toContainText("已排队 1 分 05 秒");
  await expect(preparation.locator(".is-indeterminate")).toHaveCount(0);
  await expect(preparation.locator(".reading-page-progress-track>span")).toHaveCSS("width","0px");
  state.diagnostics.current={...state.diagnostics.current,state:"running",elapsedMs:12000};
  await expect(preparation).toContainText("正在校正正文");
  await expect(preparation).toContainText("已运行 12 秒");
  await expect(preparation.getByText("处理详情",{exact:true})).toHaveCount(0);
  await expect(preparation).not.toContainText("Deepseek/deepseek-v4-flash-0731");
  await expect(preparation).not.toContainText("预计");
});

test("reading diagnostics stop failed progress and retain safe failure history after recovery",async({page},info)=>{
  const state=await preparationFixture(page);
  const failure={id:"failure-27",step:"correct",source:{id:"s2",type:"scan_pdf",label:"PDF 第27页",page:27},at:"2026-11-04T21:00:00Z",message:"服务暂时不可用",diagnostic:{code:"UPSTREAM_HTTP_ERROR",category:"upstream_http",httpStatus:503,errorType:"AI_APICallError",rawBody:"SECRET_RAW_RESPONSE"},execution:{providerId:"api_base",model:"Deepseek/deepseek-v4-flash-0731",operationId:"operation-27",queueMs:2500,elapsedMs:65000}};
  state.percent=35;
  state.error=failure.message;
  state.diagnostics={current:{state:"failed",step:"correct",source:failure.source,updatedAt:failure.at,...failure.execution,error:{message:failure.message,diagnostic:failure.diagnostic}},recentFailures:[failure]};
  await page.goto("/#doc");
  const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
  await expect(preparation).toContainText("正文校正失败");
  await expect(preparation).toContainText("已失败");
  await expect(preparation).toContainText("35% · 已失败");
  await expect(preparation).not.toContainText("处理中");
  await expect(preparation).not.toContainText("正在校正");
  await expect(preparation).toHaveAttribute("aria-busy","false");
  await expect(preparation.locator(".is-indeterminate")).toHaveCount(0);
  await expect(preparation.getByText("处理详情",{exact:true})).toHaveCount(0);
  await expect(preparation).not.toContainText("HTTP 503");
  await expect(page.locator("body")).not.toContainText("SECRET_RAW_RESPONSE");
  await page.screenshot({path:`artifacts/reading-diagnostics-failed-${info.project.name}.png`,fullPage:true});
  state.ready=true;state.error=null;state.diagnostics.current=null;
  await expect(page.getByLabel("日语原文")).toContainText(original);
  await expect(preparation).toHaveCount(0);
  await expect(page.getByText(/最近处理异常/)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
  await page.screenshot({path:`artifacts/reading-diagnostics-recovered-${info.project.name}.png`,fullPage:true});
});

test("a legacy preparation failure stops its running label and indeterminate animation",async({page})=>{
  const state=await preparationFixture(page);state.error="API 调用失败";
  await page.goto("/#doc");
  const preparation=page.getByRole("region",{name:"准备当前阅读页",exact:true});
  await expect(preparation).toContainText("已暂停");
  await expect(preparation).not.toContainText("处理中");
  await expect(preparation.locator(".is-indeterminate")).toHaveCount(0);
  await expect(preparation.getByRole("button",{name:"重试准备",exact:true})).toBeEnabled();
});

test("a late pending heartbeat cannot replace an automatically loaded completed reading page",async({page})=>{
  const state=await preparationFixture(page,{holdHeartbeat:true});await page.goto("/#doc");
  await expect.poll(()=>typeof state.releaseHeartbeat).toBe("function");
  state.ready=true;await expect(page.getByLabel("日语原文")).toContainText(original);
  await page.evaluate(()=>{
    window.__readingBodyDisappeared=false;
    window.__readingBodyObserver=new MutationObserver(()=>{if(!document.querySelector('article[aria-label="日语原文"]'))window.__readingBodyDisappeared=true;});
    window.__readingBodyObserver.observe(document.body,{subtree:true,childList:true});
  });
  const lateResponse=page.waitForResponse(response=>response.url().includes("/reading-session")&&response.request().method()==="POST");
  state.releaseHeartbeat();await lateResponse;
  await expect(page.getByLabel("日语原文")).toContainText(original);
  await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  expect(await page.evaluate(()=>{window.__readingBodyObserver.disconnect();return window.__readingBodyDisappeared;})).toBe(false);
  await expect(page.getByRole("progressbar",{name:"当前阅读页准备进度",exact:true})).toHaveCount(0);
});

async function hiddenReaderFixture(page,{holdFirst=false}={}) {
  await fixture(page);
  await page.addInitScript(()=>{
    window.__readerTestVisibility="visible";
    Object.defineProperty(document,"visibilityState",{configurable:true,get:()=>window.__readerTestVisibility});
  });
  const state={gets:{doc:0,other:0},aborts:0,finished:0,text:{doc:holdFirst?"隐藏前的迟到旧正文。":original,other:"別資料の新しい正文。"}};
  let releaseGet,releaseHeartbeats;
  const getGate=new Promise(resolve=>releaseGet=resolve),heartbeatGate=new Promise(resolve=>releaseHeartbeats=resolve);
  state.releaseGet=releaseGet;state.releaseHeartbeats=releaseHeartbeats;
  const snapshot=(id,text)=>{const currentPage={id:`${id}-page`,index:0,ready:true,bodyHtml:html(text),sourceIds:["s2"],start:0,end:text.length};return {pages:[currentPage],currentPage,index:0,complete:true,totalPages:1,hasNext:false};};
  await page.route(/\/api\/documents\/(doc|other)$/,route=>{
    const id=route.request().url().endsWith("/other")?"other":"doc",text=id==="other"?"別資料の預載正文。":original;
    return route.fulfill({json:{id,title:id==="other"?"另一篇阅读资料":"当前阅读资料",kind:"article",sourceWorkflow:true,blocks:parseText(text),bodyHtml:html(text),...(holdFirst?{reading:snapshot(id,text)}:{})}});
  });
  await page.route("**/api/documents/other/conversations",route=>route.fulfill({json:{conversations:[]}}));
  page.on("requestfailed",request=>{if(request.method()==="GET"&&request.url().includes("/reading-pages"))state.aborts++;});
  await page.route("**/api/documents/*/reading-*",async route=>{
    const request=route.request(),id=request.url().includes("/other/")?"other":"doc";
    if(request.method()==="POST"&&request.postDataJSON().active===false)return route.fulfill({json:{sessionId:"test"}});
    const value=snapshot(id,state.text[id]);
    if(request.method()==="POST"){await heartbeatGate;return route.fulfill({json:value});}
    state.gets[id]++;
    if(holdFirst&&id==="doc"&&state.gets.doc===1)await getGate;
    try{return await route.fulfill({json:value});}finally{state.finished++;}
  });
  return state;
}
async function readerVisibility(page,value){await page.evaluate(value=>{window.__readerTestVisibility=value;document.dispatchEvent(new Event("visibilitychange"));},value);}

test("hidden reading tabs stop GET polling and resume immediately on visibility or online",async({page})=>{
  const state=await hiddenReaderFixture(page);
  try{
    await page.goto("/#doc");await expect(page.getByLabel("日语原文")).toContainText(original);
    await readerVisibility(page,"hidden");const before=state.gets.doc;
    await page.waitForTimeout(2300);expect(state.gets.doc).toBe(before);
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(state.gets.doc).toBe(before);
    state.text.doc="恢复可见后的正文。";await readerVisibility(page,"visible");
    await expect.poll(()=>state.gets.doc,{timeout:1000}).toBe(before+1);
    await expect(page.getByLabel("日语原文")).toContainText("恢复可见后的正文。");
    state.text.doc="重新联网后的正文。";const resumed=state.gets.doc;
    await page.evaluate(()=>window.dispatchEvent(new Event("online")));
    await expect.poll(()=>state.gets.doc,{timeout:1000}).toBe(resumed+1);
    await expect(page.getByLabel("日语原文")).toContainText("重新联网后的正文。");
  }finally{state.releaseGet();state.releaseHeartbeats();}
});

test("hidden reading tabs abort pending GETs and reject their late response",async({page})=>{
  const state=await hiddenReaderFixture(page,{holdFirst:true});
  try{
    await page.goto("/#doc");await expect(page.getByLabel("日语原文")).toContainText(original);
    await expect.poll(()=>state.gets.doc).toBe(1);
    await readerVisibility(page,"hidden");state.releaseGet();
    await expect.poll(()=>state.finished).toBeGreaterThan(0);
    await expect.poll(()=>state.aborts).toBeGreaterThan(0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.getByLabel("日语原文")).toContainText(original);
    await expect(page.getByLabel("日语原文")).not.toContainText("隐藏前的迟到旧正文。");
  }finally{state.releaseGet();state.releaseHeartbeats();}
});

test("hidden reading tabs keep delayed responses isolated when changing documents",async({page})=>{
  const state=await hiddenReaderFixture(page,{holdFirst:true});
  try{
    await page.goto("/#doc");await expect(page.getByLabel("日语原文")).toContainText(original);
    await expect.poll(()=>state.gets.doc).toBe(1);await readerVisibility(page,"hidden");
    await page.evaluate(()=>location.hash="other");
    await expect(page.getByLabel("日语原文")).toContainText("別資料の預載正文。");
    state.releaseGet();state.releaseHeartbeats();
    await expect.poll(()=>state.finished).toBeGreaterThan(0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(state.gets.other).toBe(0);
    await expect(page.getByLabel("日语原文")).toContainText("別資料の預載正文。");
    await readerVisibility(page,"visible");
    await expect.poll(()=>state.gets.other,{timeout:1000}).toBe(1);
    await expect(page.getByLabel("日语原文")).toContainText("別資料の新しい正文。");
  }finally{state.releaseGet();state.releaseHeartbeats();}
});

async function pagedFailureFixture(page) {
  await fixture(page);
  const pages=[{id:"ready",index:0,ready:true,bodyHtml:html(original),sourceIds:["s2"],start:0,end:original.length},
    {id:"review",index:1,ready:false,bodyHtml:"",sourceIds:["s1"],start:original.length,end:20},
    {id:"pending",index:2,ready:false,bodyHtml:"",sourceIds:["s3"],start:20,end:30}];
  const state={visited:false,held:0,finishedHeld:0,otherHeld:0};
  let releaseReturn,releaseOther;
  const returning=new Promise(resolve=>releaseReturn=resolve),other=new Promise(resolve=>releaseOther=resolve);
  state.releaseReturn=releaseReturn;state.releaseOther=releaseOther;
  await page.route("**/api/documents/other",route=>route.fulfill({json:{id:"other",title:"另一篇资料",kind:"article",sourceWorkflow:true,bodyHtml:html("別の記事だけの本文。"),blocks:parseText("別の記事だけの本文。"),revision:1}}));
  await page.route("**/api/documents/other/conversations",route=>route.fulfill({json:{conversations:[]}}));
  await page.route("**/api/documents/*/reading-*",async route=>{
    const request=route.request(),url=new URL(request.url());
    const input=request.method()==="POST" ? request.postDataJSON() : {};
    if(input.active===false)return route.fulfill({json:{sessionId:"test"}});
    if(url.pathname.includes("/other/")){
      state.otherHeld++;await other;
      const page={...pages[0],id:"other-page",bodyHtml:html("別の記事だけの本文。")};
      return route.fulfill({json:{pages:[page],currentPage:page,index:0,hasNext:false,complete:true,totalPages:1}});
    }
    const index=input.index ?? Number(url.searchParams.get("index") || 0);
    if(index===1)state.visited=true;
    const snapshot={pages,currentPage:pages[index],index,position:index,hasNext:index<2,complete:false,
      ...(index===1 ? {error:"正文出现较大改动，请核对第二页。",preparation:{stage:"correct"},diagnostics:{current:{state:"requires_review",step:"correct",source:{id:"s1",type:"photo"}}},
        ...(state.provisionalPreview?{provisionalPreview:state.provisionalPreview}:{})} : {})};
    if(state.visited&&index!==1){
      state.held++;await returning;
      try{return await route.fulfill({json:snapshot});}finally{state.finishedHeld++;}
    }
    return route.fulfill({json:snapshot});
  });
  return state;
}

test("returning to a prepared reading page reuses its ready body while another page response is delayed",async({page})=>{
  const state=await pagedFailureFixture(page);
  const secondText="二頁だけの未確定な本文。";
  state.provisionalPreview={text:secondText,truncated:false};
  try{
    await page.goto("/#doc");
    await expect(page.getByLabel("日语原文")).toContainText(original);
    const navigation=page.getByRole("navigation",{name:"阅读分页",exact:true});
    await navigation.getByRole("button",{name:"下一页",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("正文出现较大改动");
    const preview=page.getByRole("region",{name:"已提取正文预览",exact:true});
    await expect(preview).toContainText(secondText);
    await expect(preview).not.toContainText(original);
    await navigation.getByText("文章目录",{exact:true}).click();
    await navigation.getByRole("button",{name:"第 3 页 · 准备中",exact:true}).click();
    await expect.poll(()=>state.held).toBeGreaterThan(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).not.toContainText(/较大改动|暂停|待核对/);
    await navigation.getByRole("button",{name:"第 1 页",exact:true}).click();
    await expect(page.getByLabel("日语原文")).toContainText(original);
    await expect(preview).toHaveCount(0);
    await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toHaveCount(0);
    await expect(navigation.getByRole("button",{name:"下一页",exact:true})).toBeEnabled();
  }finally{state.releaseReturn();state.releaseOther();}
});

test("ready page snapshots and late responses never carry into a different document",async({page})=>{
  const state=await pagedFailureFixture(page);
  try{
    await page.goto("/#doc");await expect(page.getByLabel("日语原文")).toContainText(original);
    const navigation=page.getByRole("navigation",{name:"阅读分页",exact:true});
    await navigation.getByRole("button",{name:"下一页",exact:true}).click();
    await expect(page.getByRole("alert")).toContainText("正文出现较大改动");
    await navigation.getByRole("button",{name:"上一页",exact:true}).click();
    await expect.poll(()=>state.held).toBeGreaterThan(0);
    await page.evaluate(()=>location.hash="other");
    await expect(page.getByRole("heading",{name:"另一篇资料",exact:true})).toBeVisible();
    await expect.poll(()=>state.otherHeld).toBeGreaterThan(0);
    await expect(page.getByLabel("日语原文")).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
    state.releaseReturn();await expect.poll(()=>state.finishedHeld).toBeGreaterThan(0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.getByLabel("日语原文")).toHaveCount(0);
    state.releaseOther();
    await expect(page.getByLabel("日语原文")).toContainText("別の記事だけの本文。");
    await expect(page.getByLabel("日语原文")).not.toContainText(original);
  }finally{state.releaseReturn();state.releaseOther();}
});

async function preloadedReadingFixture(page) {
  await fixture(page);
  const pageData={id:"preloaded",index:0,ready:true,bodyHtml:html(original),sourceIds:["s2"],start:0,end:original.length};
  const state={snapshot:{pages:[pageData],currentPage:pageData,index:0,complete:true,totalPages:1,hasNext:false},reads:0,responses:0,otherReads:0};
  let release,releaseOther;
  const gate=new Promise(resolve=>release=resolve),otherGate=new Promise(resolve=>releaseOther=resolve);
  state.release=release;state.releaseOther=releaseOther;
  const document={id:"doc",title:"预载阅读资料",sourceWorkflow:true,kind:"article",blocks:parseText(original),bodyHtml:pageData.bodyHtml,reading:state.snapshot,revision:1};
  await page.route("**/api/documents/doc",route=>route.fulfill({json:document}));
  await page.route("**/api/documents/other",route=>route.fulfill({json:{...document,id:"other",title:"没有预载的新资料",reading:undefined}}));
  await page.route("**/api/documents/other/conversations",route=>route.fulfill({json:{conversations:[]}}));
  await page.route("**/api/documents/*/reading-*",async route=>{
    if(route.request().method()==="POST"&&route.request().postDataJSON().active===false)return route.fulfill({json:{sessionId:"test"}});
    if(route.request().url().includes("/other/")){
      state.otherReads++;await otherGate;
      const currentPage={...pageData,id:"other-page",bodyHtml:html("別の記事の新しい正文。")};
      return route.fulfill({json:{...state.snapshot,pages:[currentPage],currentPage}});
    }
    state.reads++;await gate;
    try{return await route.fulfill({json:state.snapshot});}finally{state.responses++;}
  });
  return state;
}

test("a preloaded ready reading snapshot displays immediately while page loading and heartbeat are delayed",async({page})=>{
  const state=await preloadedReadingFixture(page);
  try{
    await page.goto("/#doc");
    await expect.poll(()=>state.reads).toBeGreaterThan(0);
    await expect(page.getByLabel("日语原文")).toContainText(original);
    await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toHaveCount(0);
    expect(state.responses).toBe(0);
    const currentPage={...state.snapshot.currentPage,bodyHtml:html("服务器刷新后的正文。")};
    state.snapshot={...state.snapshot,pages:[currentPage],currentPage};state.release();
    await expect(page.getByLabel("日语原文")).toContainText("服务器刷新后的正文。");
  }finally{state.release();state.releaseOther();}
});

test("a new document without a reading preload never reuses another document's preloaded page",async({page})=>{
  const state=await preloadedReadingFixture(page);
  try{
    await page.goto("/#doc");await expect(page.getByLabel("日语原文")).toContainText(original);
    await page.evaluate(()=>location.hash="other");
    await expect(page.getByRole("heading",{name:"没有预载的新资料",exact:true})).toBeVisible();
    await expect.poll(()=>state.otherReads).toBeGreaterThan(0);
    await expect(page.getByLabel("日语原文")).toHaveCount(0);
    state.release();await expect.poll(()=>state.responses).toBeGreaterThan(0);
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(page.getByLabel("日语原文")).toHaveCount(0);
    state.releaseOther();await expect(page.getByLabel("日语原文")).toContainText("別の記事の新しい正文。");
  }finally{state.release();state.releaseOther();}
});

test("unified text import confirms detected type before preparing the current page",async({page})=>{
  const state=await fixture(page);await page.goto("/");
  await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();await page.getByRole("tab",{name:"粘贴文字",exact:true}).click();
  await page.getByLabel("资料标题").fill("新资料");await page.getByLabel("导入原文").fill(original);
  await page.getByRole("button",{name:"继续确认类型"}).click();
  await expect(page.getByLabel("确认来源类型")).toHaveValue("text");
  expect(state.calls.filter((item)=>item.path.includes("reading-session"))).toHaveLength(0);
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toContainText(original);
  await expect(page.getByLabel("阅读分页",{exact:true})).toContainText("第 1 页");
  await page.getByLabel("阅读分页",{exact:true}).getByRole("button",{name:"下一页"}).click();
  await expect(page.getByLabel("日语原文")).toContainText("次の読書ページ。");
  await expect(page.getByLabel("阅读分页",{exact:true})).toContainText("第 2 页");
});

test("reading heartbeats advance the same session across page changes and source correction",async({page})=>{
  const secondText="次の読書ページ。";
  await fixture(page,{source1:{type:"text",bodyHtml:html(secondText),preview:{type:"text",text:secondText}}});
  const requests=[];
  let firstHeartbeat,releaseFirstHeartbeat;
  const firstHeartbeatGate=new Promise(resolve=>releaseFirstHeartbeat=resolve);
  await page.route("**/api/documents/doc/reading-session",async route=>{
    const request=route.request(),input=request.postDataJSON();
    requests.push(input);
    if(!firstHeartbeat&&input.active===true&&input.mode==="reading"&&input.index===0){
      firstHeartbeat=request;
      await firstHeartbeatGate;
      const currentPage={id:"p0",index:0,ready:true,bodyHtml:html(original),sourceIds:["s2"],start:6,end:6+original.length};
      return route.fulfill({json:{pages:[currentPage],currentPage,index:0,position:0,hasNext:true,complete:false}});
    }
    return route.fallback();
  });
  const activeReadingAt=(index,start=0)=>requests.slice(start).find(input=>input.active===true&&input.mode==="reading"&&input.index===index);
  const stopAfter=(sessionId,start)=>requests.slice(start).find(input=>input.active===false&&input.sessionId===sessionId);

  try{
    await page.goto("/#doc");
    const reader=page.getByLabel("日语原文",{exact:true});
    await expect(reader).toContainText(original);
    await expect.poll(()=>!!firstHeartbeat).toBe(true);
    const first=activeReadingAt(0),nextStart=requests.length;
    await page.getByRole("navigation",{name:"阅读分页",exact:true}).getByRole("button",{name:"下一页",exact:true}).click();
    await expect(reader).toContainText(secondText);
    await expect.poll(()=>!!stopAfter(first.sessionId,nextStart)&&!!activeReadingAt(1,nextStart)).toBe(true);
    const pageStop=stopAfter(first.sessionId,nextStart),next=activeReadingAt(1,nextStart);
    const lateResponse=page.waitForResponse(response=>response.request()===firstHeartbeat);
    releaseFirstHeartbeat();
    await (await lateResponse).finished();
    await expect(reader).toContainText(secondText);

    const correctionStart=requests.length;
    await page.getByRole("button",{name:"校对正文",exact:true}).click();
    await expect(page.getByLabel("切换校对来源",{exact:true})).toHaveValue("s1");
    await expect.poll(()=>!!stopAfter(first.sessionId,correctionStart)).toBe(true);
    const correctionStop=stopAfter(first.sessionId,correctionStart),returnStart=requests.length;
    await page.getByRole("button",{name:"返回阅读",exact:true}).click();
    await expect(reader).toContainText(secondText);
    await expect.poll(()=>!!activeReadingAt(1,returnStart)).toBe(true);
    const resumed=activeReadingAt(1,returnStart);

    expect(next.sessionId).toBe(first.sessionId);
    expect(resumed.sessionId).toBe(first.sessionId);
    let previous=0;
    for(const {sequence} of [first,pageStop,next,correctionStop,resumed]){
      expect(Number.isSafeInteger(sequence)).toBe(true);
      expect(sequence).toBeGreaterThan(previous);
      previous=sequence;
    }
  }finally{releaseFirstHeartbeat();}
});

for(const save of [false,true])test(`returning from second-page source correction keeps the reading position after ${save ? "saving" : "cancelling"}`,async({page})=>{
  const firstText="一頁だけの本文。",secondText="二頁だけの本文。",editedText="二頁だけの修正済み本文。";
  const first={id:"first-page",index:0,ready:true,bodyHtml:html(firstText),sourceIds:["s1"],start:0,end:firstText.length};
  const staleReading={pages:[first],currentPage:first,index:0,position:0,complete:false,hasNext:true};
  const state=await fixture(page,{source1:{type:"text",bodyHtml:first.bodyHtml},source:{bodyHtml:html(secondText)}});
  await page.route("**/api/documents/doc",route=>route.fulfill({json:{id:"doc",title:"分页校对",kind:"article",sourceWorkflow:true,revision:1,
    bodyHtml:html(firstText+secondText),blocks:parseText(firstText+secondText),reading:staleReading}}));

  let savedIndex=0,returning=false,release;
  const returnReads=[],returnBeats=[],returnGate=new Promise(resolve=>release=resolve);
  await page.route("**/api/documents/doc/reading-*",async route=>{
    const request=route.request(),url=new URL(request.url());
    let index;
    if(request.method()==="POST"){
      const input=request.postDataJSON();
      if(input.active===false)return route.fulfill({json:{sessionId:"test"}});
      index=input.index??savedIndex;savedIndex=index;
      if(returning&&input.mode==="reading")returnBeats.push(input.index);
    }else{
      if(returning){returnReads.push(url.searchParams.get("index"));await returnGate;}
      index=Number(url.searchParams.get("index")??savedIndex);
    }
    const text=state.saves.length ? bodyText(state.saves.at(-1).bodyHtml) : secondText;
    const second={id:"second-page",index:1,ready:true,bodyHtml:html(text),sourceIds:["s2"],start:first.end,end:first.end+text.length};
    const pages=[first,second];
    return route.fulfill({json:{pages,currentPage:pages[index],index,position:index,complete:true,totalPages:2,hasNext:index===0}});
  });

  try{
    await page.goto("/#doc");
    const reader=page.getByLabel("日语原文",{exact:true}),navigation=page.getByRole("navigation",{name:"阅读分页",exact:true});
    await expect(reader).toContainText(firstText);
    await navigation.getByRole("button",{name:"下一页",exact:true}).click();
    await expect(reader).toContainText(secondText);
    await expect.poll(()=>savedIndex).toBe(1);
    await page.getByRole("button",{name:"校对正文",exact:true}).click();
    await expect(page.getByLabel("切换校对来源",{exact:true})).toHaveValue("s2");
    await page.getByRole("button",{name:"编辑正文与注音",exact:true}).click();
    const editor=page.getByLabel("来源正文",{exact:true});
    await expect(editor).toHaveValue(secondText);
    if(save){
      await editor.fill(editedText);
      await page.getByRole("button",{name:"保存正文",exact:true}).click();
      await expect(page.getByRole("status").filter({hasText:"已保存，将仅补齐"})).toBeVisible();
    }else await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect(editor).toHaveCount(0);
    returning=true;
    await page.getByRole("button",{name:"返回阅读",exact:true}).click();
    await expect.poll(()=>returnReads.length+returnBeats.length).toBeGreaterThan(0);
    const showedFirstPage=await reader.filter({hasText:firstText}).count();
    release();
    await expect.poll(()=>returnBeats[0]).toBe(1);
    await expect.poll(()=>returnReads[0]).toBe("1");
    expect(showedFirstPage).toBe(0);
    await expect(navigation).toContainText("第 2 / 2 页");
    await expect(reader).toContainText(save ? editedText : secondText);
    expect(returnBeats).not.toContain(0);
    expect(savedIndex).toBe(1);
    expect(state.saves).toHaveLength(save ? 1 : 0);
  }finally{release();}
});

test("source correction opens the mapped source, saves its version and preserves immutable preview",async({page},testInfo)=>{
  const state=await fixture(page);await page.goto("/#doc");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await expect(page.getByLabel("切换校对来源")).toHaveValue("s2");
  await expect(page.locator(".source-original-text")).toHaveText("保存された原文。");
  await page.getByRole("button",{name:"编辑正文与注音",exact:true}).click();
  await page.getByLabel("来源正文",{exact:true}).fill("今日は広い空を見た。");
  await page.getByRole("button",{name:"保存正文",exact:true}).click();
  await expect(page.getByRole("status").filter({hasText:"已保存，将仅补齐"})).toBeVisible();
  expect(state.saves).toHaveLength(1);expect(state.saves[0].version).toBe(7);expect(bodyText(state.saves[0].bodyHtml)).toBe("今日は広い空を見た。");
  await expect(page.locator(".source-original-text")).toHaveText("保存された原文。");
  await page.screenshot({path:`artifacts/sources-${testInfo.project.name}.png`,fullPage:true});
  await page.getByRole("button",{name:"全文检查",exact:true}).click();
  await expect(page.getByRole("heading",{name:"已准备正文与待准备位置"})).toBeVisible();
  expect(state.calls.filter((item)=>item.path.endsWith("/prepare")).map((item)=>item.path)).toEqual(["/documents/doc/sources/s2/prepare"]);
  await page.getByRole("button",{name:"照片 1 · 待核对",exact:true}).click();
  await expect(page.getByLabel("切换校对来源")).toHaveValue("s1");
  await expect(page.getByRole("img",{name:"照片 1",exact:true})).toBeVisible();
  await page.getByRole("button",{name:"向右旋转",exact:true}).click();
  await expect(page.getByRole("img",{name:"照片 1",exact:true})).toHaveAttribute("style",/rotate\(90deg\)/);
});

for(const example of [
  {name:"failed second PDF source",state:"failed",sourceId:"s2",sourceIds:["s1","s2"],expected:"s2"},
  {name:"unpublished PDF source awaiting review",state:"requires_review",sourceId:"s2",unpublished:true,expected:"s2"},
  {name:"page source order without current diagnostics",sourceIds:["s2","s1"],expected:"s2"},
  {name:"page fallback for an unavailable diagnostic source",state:"failed",sourceId:"removed",sourceIds:["s2","s1"],expected:"s2"},
  {name:"ready page's original edit source",state:"failed",sourceId:"s2",sourceIds:["s1","s2"],ready:true,expected:"s1"},
])test(`reading correction opens the ${example.name}`,async({page})=>{
  const state=await fixture(page,{source1:{type:"scan_pdf",page:105,original:{page:105},preview:{type:"text",text:"PDF 第105页原文"}},source:{type:"scan_pdf",page:110,original:{page:110},preview:{type:"text",text:"PDF 第110页原文"}}});
  const currentPage=example.unpublished ? null : {id:"current",index:0,ready:!!example.ready,bodyHtml:html(original),sourceIds:example.sourceIds,start:0,end:original.length};
  await page.route("**/api/documents/doc/reading-*",route=>{
    if(route.request().method()==="POST"&&route.request().postDataJSON().active===false)return route.fulfill({json:{sessionId:"test"}});
    return route.fulfill({json:{pages:currentPage?[currentPage]:[],currentPage,index:0,complete:false,hasNext:false,
      preparation:{stage:example.ready?"ready":"correct"},diagnostics:{current:example.sourceId?{state:example.state,step:"correct",source:{id:example.sourceId,type:"scan_pdf",position:1,page:110,label:"PDF 第110页"}}:null}}});
  });
  await page.goto("/#doc");
  if(example.ready)await expect(page.getByLabel("日语原文")).toBeVisible();
  else if(example.sourceId)await expect(page.getByRole("region",{name:"准备当前阅读页",exact:true})).toContainText("PDF 第110页");
  else await expect(page.getByText("文章目录",{exact:true})).toBeVisible();
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await expect(page.getByLabel("切换校对来源",{exact:true})).toHaveValue(example.expected);
  expect(state.calls.filter(call=>call.path.endsWith("/prepare")).map(call=>call.path)).toEqual([`/documents/doc/sources/${example.expected}/prepare`]);
});

async function delayedProposalEditFixture(page) {
  const state={latest:{id:"s2",type:"text",position:1,version:7,checked:false,status:"requires_review",processing:false,
    bodyHtml:html(original),preview:{type:"text",text:"保存された原文。"},firstExtraction:{text:original},changes:[],articleStart:6,
    proposalToken:"a".repeat(64),proposal:{bodyHtml:html("古いAI提案。")}},calls:[],editStarted:false};
  let release;
  const gate=new Promise(resolve=>release=resolve);state.release=release;
  const base=await fixture(page,{source:state.latest});state.saves=base.saves;
  await page.route("**/api/documents/doc/sources/s2",route=>route.request().method()==="GET" ? route.fulfill({json:state.latest}) : route.fallback());
  await page.route("**/api/documents/doc/sources/s2/edit",async route=>{
    const request=route.request();state.calls.push({method:request.method(),input:request.postDataJSON()});
    if(request.method()==="POST"){state.editStarted=true;await gate;return route.fulfill({json:state.latest});}
    return route.fulfill({json:{ok:true}});
  });
  await page.goto("/#doc");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await expect(page.getByRole("button",{name:"核对并编辑此提议",exact:true})).toBeVisible();
  return state;
}

test("old edit lease renewal and release cannot interfere with a reopened source editor",async({page})=>{
  const source={id:"s2",type:"text",position:1,version:7,status:"ready",bodyHtml:html(original),preview:{type:"text",text:original}};
  const state=await fixture(page,{source});
  let activeLease=null,oldRenewal,oldRelease,releaseRenewal,releaseCancel;
  const acquisitions=[],releases=[];
  const renewalGate=new Promise(resolve=>releaseRenewal=resolve),cancelGate=new Promise(resolve=>releaseCancel=resolve);
  await page.route("**/api/documents/doc/sources/s2/edit",async route=>{
    const request=route.request(),input=request.postDataJSON();
    if(request.method()==="DELETE"){
      releases.push(input.sessionId);
      if(!oldRelease){oldRelease={request,input};await cancelGate;}
      if(activeLease===input.sessionId)activeLease=null;
    }else{
      if(acquisitions.length===1&&!oldRenewal&&!oldRelease){oldRenewal={request,input};await renewalGate;}
      else if(!input.renew)acquisitions.push(input.sessionId);
      if(!input.renew)activeLease=input.sessionId;
      else if(activeLease!==input.sessionId)return route.fulfill({status:409,json:{error:"旧编辑租约已结束。"}});
    }
    return route.fulfill({json:{...source,sessionId:input.sessionId,editing:activeLease!==null}});
  });
  try{
    await page.goto("/#doc");
    await page.getByRole("button",{name:"校对正文",exact:true}).click();
    const edit=page.getByRole("button",{name:"编辑正文与注音",exact:true}),editor=page.getByLabel("来源正文",{exact:true});
    await edit.click();
    await expect(editor).toHaveValue(original);
    await page.evaluate(()=>document.dispatchEvent(new Event("visibilitychange")));
    await expect.poll(()=>!!oldRenewal).toBe(true);
    await page.getByRole("button",{name:"取消",exact:true}).click();
    await expect.poll(()=>!!oldRelease).toBe(true);
    await edit.click();
    await expect(editor).toHaveValue(original);
    expect(acquisitions).toHaveLength(2);
    const [first,second]=acquisitions;

    const cancelled=page.waitForResponse(response=>response.request()===oldRelease.request);
    releaseCancel();await cancelled;
    const afterOldRelease=activeLease;
    const renewed=page.waitForResponse(response=>response.request()===oldRenewal.request);
    releaseRenewal();
    const staleRenewal=await renewed;
    expect(afterOldRelease).toBe(second);
    expect(activeLease).toBe(second);
    expect(second).not.toBe(first);
    expect(oldRelease.input).toMatchObject({sessionId:first});
    expect(oldRenewal.input).toMatchObject({sessionId:first,renew:true});
    expect(staleRenewal.status()).toBe(409);
    await staleRenewal.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await expect(editor).toHaveValue(original);
    await expect(page.getByText("旧编辑租约已结束。",{exact:true})).toHaveCount(0);

    const changed="再開した編集で保存した本文。";
    await editor.fill(changed);
    await page.getByRole("button",{name:"保存正文",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:"已保存，将仅补齐"})).toBeVisible();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({sessionId:second,version:source.version});
    expect(bodyText(state.saves[0].bodyHtml)).toBe(changed);
    await expect.poll(()=>activeLease).toBe(null);
    expect(releases).toEqual([first,second]);
  }finally{releaseRenewal();releaseCancel();}
});

test("leaving during edit acquisition cannot replace a lease opened after returning",async({page})=>{
  const source={id:"s2",type:"text",position:1,version:7,status:"ready",bodyHtml:html(original),preview:{type:"text",text:original},editRevision:0};
  const state=await fixture(page,{source});
  const acquires=[],releases=[];
  let editRevision=0,activeLease=null,reopening=false,releaseFirst;
  const firstGate=new Promise(resolve=>releaseFirst=resolve);
  const detail=(revision=editRevision)=>({...source,editRevision:revision,editing:activeLease!==null});
  await page.route("**/api/documents/doc/sources/s2",route=>{
    if(route.request().method()!=="GET")return route.fallback();
    // The reopened view sees a snapshot from before the abandoned acquisition was cancelled.
    return route.fulfill({json:detail(reopening&&acquires.length===1 ? 0 : editRevision)});
  });
  await page.route("**/api/documents/doc/sources/s2/edit",async route=>{
    const request=route.request(),input=request.postDataJSON();
    if(request.method()==="DELETE"){
      releases.push(input);
      if(activeLease===input.sessionId)activeLease=null;
      else if(input.editRevision===editRevision)editRevision++;
      return route.fulfill({json:detail()});
    }
    if(input.renew)return route.fulfill({json:{sessionId:input.sessionId}});
    const acquire={request,input,status:200};
    acquires.push(acquire);
    if(acquires.length===1)await firstGate;
    if(input.editRevision!==editRevision){
      acquire.status=409;
      return route.fulfill({status:409,json:{code:"SOURCE_EDIT_REVISION_CONFLICT",error:"编辑状态已更新，请重试。"}});
    }
    activeLease=input.sessionId;editRevision++;
    return route.fulfill({json:{...detail(),sessionId:activeLease}});
  });

  try{
    await page.goto("/#doc");
    const correction=page.getByRole("button",{name:"校对正文",exact:true}),edit=page.getByRole("button",{name:"编辑正文与注音",exact:true});
    await correction.click();await edit.click();
    await expect.poll(()=>acquires.length).toBe(1);
    const abandoned=acquires[0];
    await expect(page.getByRole("status").filter({hasText:"正在打开编辑"})).toBeVisible();
    await page.getByRole("button",{name:"返回阅读",exact:true}).click();
    await expect(page.getByRole("article",{name:"日语原文",exact:true})).toBeVisible();
    await expect.poll(()=>editRevision).toBe(1);
    expect(releases).toEqual([{sessionId:abandoned.input.sessionId,editRevision:0}]);

    reopening=true;
    await correction.click();await edit.click();
    const editor=page.getByLabel("来源正文",{exact:true});
    await expect(editor).toHaveValue(original);
    const [,conflict,current]=acquires;
    expect(acquires).toHaveLength(3);
    expect(conflict.status).toBe(409);
    expect(conflict.input).toMatchObject({sessionId:current.input.sessionId,editRevision:0});
    expect(current.input.editRevision).toBe(1);
    expect(current.input.sessionId).not.toBe(abandoned.input.sessionId);
    const draft="再び開いた編集画面の下書き。";
    await editor.fill(draft);

    const late=page.waitForResponse(response=>response.request()===abandoned.request);
    releaseFirst();
    const lateResponse=await late;
    expect(lateResponse.status()).toBe(409);
    await lateResponse.finished();
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    expect(acquires).toHaveLength(3);
    expect(activeLease).toBe(current.input.sessionId);
    await expect(editor).toHaveValue(draft);
    await expect(page.locator(".source-error")).toHaveCount(0);
    await page.getByRole("button",{name:"保存正文",exact:true}).click();
    await expect(page.getByRole("status").filter({hasText:"已保存，将仅补齐"})).toBeVisible();
    expect(state.saves).toHaveLength(1);
    expect(state.saves[0]).toMatchObject({sessionId:current.input.sessionId,version:source.version});
    expect(bodyText(state.saves[0].bodyHtml)).toBe(draft);
  }finally{releaseFirst();}
});

for(const change of ["version","proposal"])test(`a delayed proposal edit rejects a changed ${change} and releases its edit lease`,async({page})=>{
  const state=await delayedProposalEditFixture(page);
  try{
    const edited=page.waitForResponse(response=>response.request().method()==="POST"&&response.url().endsWith("/sources/s2/edit"));
    await page.getByRole("button",{name:"核对并编辑此提议",exact:true}).click();
    await expect.poll(()=>state.editStarted).toBe(true);
    state.latest={...state.latest,...(change==="version" ? {version:8,bodyHtml:html("別ページで更新した本文。")} : {proposal:{bodyHtml:html("新しいAI提案。")}})};
    if(change==="version")await expect(page.locator(".source-current-body")).toContainText("別ページで更新した本文。");
    else await expect(page.locator(".source-proposal")).toContainText("新しいAI提案。");
    state.release();await edited;
    await expect(page.locator(".source-error")).toContainText("已更新");
    await expect(page.getByLabel("来源正文",{exact:true})).toHaveCount(0);
    await expect.poll(()=>state.calls.filter(call=>call.method==="DELETE").length).toBe(1);
    expect(state.calls.find(call=>call.method==="DELETE").input.sessionId).toBe(state.calls.find(call=>call.method==="POST").input.sessionId);
    if(change==="proposal")await expect(page.locator(".source-proposal")).toContainText("新しいAI提案。");
    else await expect(page.locator(".source-current-body")).toContainText("別ページで更新した本文。");
  }finally{state.release();}
});

test("direct source editing still opens the latest body after another page updates it",async({page})=>{
  const state=await delayedProposalEditFixture(page);
  try{
    await page.getByRole("button",{name:"编辑正文与注音",exact:true}).click();
    await expect.poll(()=>state.editStarted).toBe(true);
    state.latest={...state.latest,version:8,bodyHtml:html("最新の正文で編集する。"),proposal:null};
    state.release();
    await expect(page.getByLabel("来源正文",{exact:true})).toHaveValue("最新の正文で編集する。");
    await expect(page.locator(".source-error")).toHaveCount(0);
  }finally{state.release();}
});

test("an unchanged proposal still opens for manual review without saving automatically",async({page})=>{
  const state=await delayedProposalEditFixture(page);
  try{
    await page.getByRole("button",{name:"核对并编辑此提议",exact:true}).click();state.release();
    await expect(page.getByLabel("来源正文",{exact:true})).toHaveValue("古いAI提案。");
    await expect(page.getByRole("button",{name:"保存正文",exact:true})).toBeEnabled();
    expect(state.saves).toEqual([]);
  }finally{state.release();}
});

for(const conflict of [false,true])test(`keeping current source text ${conflict ? "refreshes a replacement proposal on conflict" : "resumes preparation without opening the editor"}`,async({page})=>{
  const state=await delayedProposalEditFixture(page);
  const current=state.latest,requests=[];
  const conflictMessage="来源正文或 AI 提议已更新，请重新核对。";
  await page.route("**/api/documents/doc/sources/s2/keep-current",route=>{
    const request=route.request();
    requests.push({method:request.method(),body:request.postDataJSON()});
    if(conflict){
      state.latest={...current,proposalToken:"b".repeat(64),proposal:{bodyHtml:html("新しいAI提案。")}};
      return route.fulfill({status:409,json:{error:conflictMessage}});
    }
    state.latest={...current,version:8,status:"pending",proposalToken:null,proposal:null};
    return route.fulfill({json:state.latest});
  });
  try{
    const keep=page.getByRole("button",{name:"保留当前正文并继续",exact:true});
    await keep.click();
    if(conflict){
      await expect(page.locator(".source-error")).toHaveText(conflictMessage);
      await expect(page.locator(".source-proposal")).toContainText("新しいAI提案。");
      await expect(keep).toBeEnabled();
    }else{
      await expect(page.getByText("已保留当前正文，后台将继续分句和注音。",{exact:true})).toBeVisible();
      await expect(page.locator(".source-proposal")).toHaveCount(0);
    }
    await expect(page.locator(".source-current-body")).toContainText(original);
    await expect(page.getByLabel("来源正文",{exact:true})).toHaveCount(0);
    expect(requests).toEqual([{method:"POST",body:{version:current.version,proposalToken:current.proposalToken,sessionId:expect.any(String)}}]);
    expect(state.calls.filter(call=>call.method==="POST")).toEqual([]);
    expect(state.saves).toEqual([]);
  }finally{state.release();}
});

test("a segmentation failure offers explicit retry but cannot keep current text as a correction fallback",async({page})=>{
  const state=await fixture(page,{source:{status:"failed",error:"分句失败",steps:[{step:"segment",status:"failed"}],failedCorrection:null}});
  await page.goto("/#doc");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  const correction=page.getByRole("region",{name:"校对正文",exact:true});
  await expect(correction.locator(".source-current-body")).toContainText(original);
  await expect(correction.getByRole("button",{name:"使用当前正文继续",exact:true})).toHaveCount(0);
  const prepares=()=>state.calls.filter(call=>call.method==="POST"&&call.path==="/documents/doc/sources/s2/prepare");
  await expect.poll(()=>prepares().length).toBe(1);
  expect(prepares()[0].input).toMatchObject({retry:false});
  await correction.getByRole("button",{name:"重试准备此来源",exact:true}).click();
  await expect.poll(()=>prepares().length).toBe(2);
  expect(prepares()[1].input.retry).not.toBe(false);
});


for (const sourceType of ["text_pdf","epub"]) test(`${sourceType} correction previews preserve original page and ruby`,async({page})=>{
  const source = sourceType === "text_pdf" ? {type:"text_pdf",preview:{type:"pdf",url:"/original.pdf",page:12}} : {type:"epub",preview:{type:"html",html:blocksToHtml(parseText("{原文|げんぶん}を残す。"))},original:{chapterHtml:blocksToHtml(parseText("{原文|げんぶん}を残す。\n章全体の続き。"))}};
  await fixture(page,{source});await page.goto("/#doc");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();
  if(sourceType === "text_pdf") await expect(page.getByTitle("PDF 原始页面")).toHaveAttribute("src","/original.pdf#page=12");
  else {await expect(page.locator(".source-original-html ruby")).toContainText("原文");await expect(page.locator(".source-original-html rt")).toHaveText("げんぶん");await page.getByText("查看完整原始章节",{exact:true}).click();await expect(page.locator(".source-original-chapter")).toContainText("章全体の続き。");}
});

test("imported PDF correction displays a loaded original-page image with zoom and the full PDF link",async({page},info)=>{
  await fixture(page,{source:{type:"scan_pdf",preview:{type:"pdf",url:"/api/imports/imp/files/file/raw",page:12}}});
  const png=await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="640" height="900"><rect width="640" height="900" fill="white"/><text x="55" y="90" font-size="30" fill="#263e34">PDF PAGE 12</text><text x="55" y="165" font-size="24" fill="#263e34">Original source page</text><path d="M55 210H585M55 265H585M55 320H585M55 375H585" stroke="#89958c" stroke-width="3"/></svg>')).png().toBuffer();
  await page.route("**/api/imports/imp/files/file/pages/12",(route)=>route.fulfill({contentType:"image/png",body:png}));
  await page.goto("/#doc");await page.getByRole("button",{name:"校对正文",exact:true}).click();
  const originalPage=page.getByRole("img",{name:"PDF 原始页面，第 12 页",exact:true});
  await expect(originalPage).toBeVisible();await expect.poll(()=>originalPage.evaluate((element)=>element.complete && element.naturalWidth > 0)).toBe(true);
  await expect(originalPage).toHaveAttribute("src","/api/imports/imp/files/file/pages/12");await expect(page.getByTitle("PDF 原始页面")).toHaveCount(0);
  await page.getByLabel("PDF 原页缩放").fill("150");await expect(originalPage).toHaveAttribute("style",/width: 150%/);
  await expect(page.getByRole("link",{name:"打开完整原 PDF",exact:true})).toHaveAttribute("href","/api/imports/imp/files/file/raw#page=12");
  await page.getByLabel("PDF 原页缩放").fill("100");await page.screenshot({path:`artifacts/pdf-original-page-${info.project.name}.png`,fullPage:true});
});

test("pasted screenshot keeps a confirmable image type",async({page})=>{
  const state=await fixture(page,{importType:"screenshot"});await page.goto("/");
  await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("上传或粘贴来源文件").evaluate((element)=>{const transfer=new DataTransfer();transfer.items.add(new File(["test-image"],"pasted.png",{type:"image/png"}));element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:transfer}));});
  await expect(page.locator(".source-file-list")).toContainText("pasted.png");
  await page.getByRole("button",{name:"继续确认类型"}).click();
  await expect(page.getByLabel("确认来源类型")).toHaveValue("screenshot");
  await expect(page.getByLabel("作为书籍导入")).toHaveCount(0);
  await page.getByLabel("资料标题").fill("截图资料");
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toBeVisible();
  expect(state.calls.find((call)=>call.path === "/imports/imp/confirm").input).toMatchObject({type:"screenshot",asBook:false});
});

for(const reopen of [false,true])test(`same-file screenshot suggestion ${reopen ? "defaults when reopening a saved draft" : "defaults on upload and yields to a manual type on restore"}`,async({page})=>{
  const draft={id:"imp",title:"再次导入的图片",detectedType:"photo",suggestedType:"screenshot",allowedTypes:["photo","screenshot"],
    files:[{id:"file",name:"113.png"}],context:{bookId:null,targetId:null},status:"staged"};
  const state=await fixture(page,{draft,serverDrafts:reopen?[draft]:[]});
  const reads=[];
  await page.route("**/api/imports/imp",route=>{
    if(route.request().method()!=="GET")return route.fallback();
    reads.push(draft.id);
    return route.fulfill({json:draft});
  });
  const openImport=async()=>{
    await showShelf(page);
    await page.getByRole("button",{name:"添加",exact:true}).click();
  };
  await page.goto("/");await openImport();
  if(reopen){
    await page.getByRole("button",{name:`继续导入：${draft.title}`,exact:true}).click();
  }else{
    const png=await sharp({create:{width:12,height:12,channels:3,background:"white"}}).png().toBuffer();
    await page.getByLabel("选择来源文件",{exact:true}).setInputFiles({name:"113.png",mimeType:"image/png",buffer:png});
    await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  }
  const type=page.getByLabel("确认来源类型",{exact:true});
  await expect(type).toHaveValue("screenshot");
  await expect(page.getByText("相同图片上次确认为截图，可在此更改。")).toBeVisible();
  const uploads=()=>state.calls.filter(call=>call.path==="/imports"&&call.method==="POST");
  const confirms=()=>state.calls.filter(call=>call.path==="/imports/imp/confirm"&&call.method==="POST");
  expect(confirms()).toEqual([]);
  if(reopen){
    expect(reads).toEqual([draft.id]);
    await page.evaluate(id=>{
      const context={initialBookId:null,initialTargetId:null};
      sessionStorage.setItem(`yohaku:import-draft:${JSON.stringify(context)}`,JSON.stringify({id,context}));
    },draft.id);
    await page.reload();await openImport();
    await expect(type).toHaveValue("screenshot");
    expect(reads).toEqual([draft.id,draft.id]);
    expect(uploads()).toEqual([]);
    return;
  }

  await type.selectOption("photo");
  await expect.poll(()=>page.evaluate(()=>{
    const context={initialBookId:null,initialTargetId:null};
    return JSON.parse(sessionStorage.getItem(`yohaku:import-draft:${JSON.stringify(context)}`)||"null")?.type;
  })).toBe("photo");
  await page.reload();await openImport();
  await expect(type).toHaveValue("photo");
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toBeVisible();
  expect(reads).toEqual([draft.id]);
  expect(uploads()).toHaveLength(1);
  expect(confirms().map(call=>call.input)).toEqual([{type:"photo",title:draft.title,asBook:false}]);
});

test("PDF chapter edits use physical ranges and retain uncertain boundaries after confirmation",async({page})=>{
  const state=await fixture(page,{importType:"text_pdf"});await page.goto("/");
  await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件").setInputFiles({name:"original.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-fixture")});
  await page.getByRole("button",{name:"继续确认类型"}).click();
  await page.getByLabel("资料标题").fill("PDF 书籍");await page.getByLabel("作为书籍导入").check();
  await page.getByRole("button",{name:"AI 提议章节",exact:true}).click();
  await page.getByLabel("章节 1 起始页").fill("3");await page.getByLabel("章节 1 标题").fill("调整后的正文");
  await page.locator(".source-chapter").nth(1).getByLabel("纳入正文").uncheck();
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toBeVisible();
  const confirmed=state.calls.find((call)=>call.path === "/imports/imp/confirm").input;
  expect(confirmed.chapters[0]).toMatchObject({title:"调整后的正文",startPage:3,endPage:8,needsReview:true});expect(confirmed.chapters[1].excluded).toBe(true);
});

test("PDF chapter review lazily previews physical boundary pages without marking them checked",async({page},info)=>{
  const state=await fixture(page,{importType:"text_pdf"});
  const previews=[];
  const png=await sharp({create:{width:700,height:1000,channels:3,background:"#f6f1e4"}}).png().toBuffer();
  await page.route("**/api/imports/imp/files/file/pages/*",route=>{
    previews.push(Number(new URL(route.request().url()).pathname.split("/").at(-1)));
    return route.fulfill({contentType:"image/png",body:png});
  });
  await page.goto("/");await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件").setInputFiles({name:"original.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-fixture")});
  await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  await page.getByLabel("作为书籍导入").check();
  await page.getByRole("button",{name:"AI 提议章节",exact:true}).click();
  const first=page.locator(".source-chapter").nth(0),second=page.locator(".source-chapter").nth(1);
  await expect(first.getByLabel("已核对章节边界")).not.toBeChecked();
  expect(previews).toEqual([]);
  await first.getByText("核对原页",{exact:true}).click();
  const preview=first.getByRole("region",{name:"章节 1 原页核对",exact:true});
  const originalPage=preview.getByRole("img",{name:"章节 1 · PDF 第 2 页原图",exact:true});
  await originalPage.scrollIntoViewIfNeeded();
  await expect(originalPage).toBeVisible();await expect.poll(()=>previews).toEqual([2]);
  await preview.getByRole("button",{name:"本章尾页",exact:true}).click();
  await expect(preview.getByRole("img")).toHaveAttribute("src","/api/imports/imp/files/file/pages/8");
  await preview.getByRole("button",{name:"下一章首页",exact:true}).click();
  await expect(preview.getByRole("img")).toHaveAttribute("src","/api/imports/imp/files/file/pages/9");
  await preview.getByRole("button",{name:"上一页",exact:true}).click();
  await expect(preview.getByRole("img")).toHaveAttribute("src","/api/imports/imp/files/file/pages/8");
  await preview.getByRole("button",{name:"本章首页",exact:true}).click();
  await expect(preview).toContainText("PDF 实际第 2 页");
  await expect(first.getByLabel("已核对章节边界")).not.toBeChecked();
  await expect(second.getByLabel("已核对章节边界")).not.toBeChecked();
  expect(previews).not.toContain(10);
  expect(state.calls.some(call=>call.path==="/imports/imp/confirm")).toBe(false);
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:`artifacts/chapter-page-review-${info.project.name}.png`,fullPage:true});
  await first.getByText("核对原页",{exact:true}).click();
  await expect(preview).toHaveCount(0);
});

async function startScannedBook(page,options={}) {
  const state=await fixture(page,{importType:"scan_pdf",asyncChapters:true,...options});await page.goto("/");
  await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件").setInputFiles({name:"scanned.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-scanned-fixture")});
  await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  await page.getByLabel("资料标题").fill("扫描书籍");await page.getByLabel("作为书籍导入").check();
  await page.getByRole("button",{name:"AI 提议章节",exact:true}).click();return state;
}

test("scanned books show whole-book OCR then AI chapter progress and review every exclusion",async({page})=>{
  const state=await startScannedBook(page);
  const progress=page.getByLabel("PDF 分章进度");await expect(progress).toContainText("全书本地 OCR：0 / 10 页");
  await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeDisabled();await expect(page.getByRole("button",{name:"返回",exact:true})).toBeEnabled();
  await expect(progress).toContainText("全书本地 OCR：3 / 10 页");await expect(progress).toContainText("正在由 AI 分章");
  await expect(page.getByLabel("章节 1 标题")).toHaveValue("第一章");
  const exclusions=page.getByLabel("建议排除的内容");await expect(exclusions).toContainText("版権所有・学習資料");await expect(exclusions).toContainText("関連図書のお知らせ");
  await expect(exclusions).toContainText("原始 OCR 结果完整保留");
  await expect(exclusions.getByRole("checkbox")).toHaveCount(2);await expect(exclusions.getByRole("checkbox").first()).toBeChecked();
  await exclusions.getByRole("checkbox").last().uncheck();await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toBeVisible();
  expect(state.calls.find((call)=>call.path === "/imports/imp/confirm").input.exclusions).toEqual([
    {page:1,startLine:1,endLine:2,reason:"重复页眉",text:"版権所有・学習資料",excluded:true},
    {page:3,startLine:8,endLine:10,reason:"与正文无关的广告",text:"関連図書のお知らせ",excluded:false},
  ]);
});

test("PDF review can keep all suggested lines in included chapters and still exclude individual lines",async({page})=>{
  const state=await startScannedBook(page,{extraExclusions:[
    {page:7,startLine:1,endLine:1,reason:"疑似页眉",text:"本文の続き",excluded:true},
    {page:9,startLine:3,endLine:3,reason:"附录标记",text:"付録の見出し",excluded:true},
  ]});
  const appendix=page.locator(".source-chapter").filter({has:page.getByLabel("章节 2 标题",{exact:true})});
  await appendix.getByLabel("纳入正文").uncheck();
  const exclusions=page.getByLabel("建议排除的内容");
  const keep=exclusions.getByRole("button",{name:"保留正文中的全部建议行",exact:true});
  const line=(n)=>exclusions.getByRole("checkbox",{name:new RegExp(`^排除 PDF 第 ${n} 页`)});
  await expect(exclusions.getByRole("status")).toHaveText("正文范围内已选 2 处行排除");
  await keep.click();
  await expect(line(3)).not.toBeChecked();await expect(line(7)).not.toBeChecked();
  await expect(line(1)).toBeChecked();await expect(line(9)).toBeChecked();
  await expect(appendix.getByLabel("纳入正文")).not.toBeChecked();
  await expect(keep).toBeDisabled();
  await line(7).check();
  await expect(exclusions.getByRole("status")).toHaveText("正文范围内已选 1 处行排除");
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  const submitted=state.calls.find((call)=>call.path==="/imports/imp/confirm").input;
  expect(submitted.exclusions.map(({page,excluded})=>[page,excluded])).toEqual([[1,true],[3,false],[7,true],[9,true]]);
  expect(submitted.chapters.map(({excluded})=>excluded)).toEqual([false,true]);
});

test("queued PDF chapter tasks keep polling and stay locked until ready",async({page})=>{
  await startScannedBook(page,{queuedChapters:true});
  const progress=page.getByLabel("PDF 分章进度");
  await expect(progress).toContainText("资源排队中");
  await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeDisabled();
  await expect(page.getByLabel("章节 1 标题")).toHaveValue("第一章");
  await expect(page.getByRole("button",{name:"确认导入",exact:true})).toBeEnabled();
});

test("failed async chapter proposals allow manual chapter confirmation",async({page})=>{
  const state=await startScannedBook(page,{failChapters:true});
  await expect(page.getByRole("alert")).toContainText("AI 分章失败");
  await page.getByRole("button",{name:"添加章节",exact:true}).click();
  await page.getByLabel("章节 1 标题").fill("人工确认的正文");await page.getByLabel("章节 1 结束页").fill("10");
  await page.getByRole("button",{name:"确认导入",exact:true}).click();await expect(page.getByLabel("日语原文")).toBeVisible();
  expect(state.calls.find((call)=>call.path === "/imports/imp/confirm").input.chapters[0]).toMatchObject({title:"人工确认的正文",startPage:1,endPage:10});
});

test("leaving async chapter preparation stops UI polling without cancelling the background job",async({page})=>{
  const state=await startScannedBook(page,{keepExtracting:true});
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  let prompts=0;page.on("dialog",async dialog=>{prompts++;await dialog.accept();});await page.getByRole("button",{name:"返回",exact:true}).click();
  await expect(page.getByLabel("统一导入")).toHaveCount(0);
  expect(prompts).toBe(0);
  const reads=state.calls.filter((call)=>call.path === "/imports/imp" && call.method === "GET").length;
  await page.waitForTimeout(2200);
  expect(state.calls.filter((call)=>call.path === "/imports/imp" && call.method === "GET")).toHaveLength(reads);
  expect(state.calls.filter((call)=>call.path.includes("/imports/") && call.method === "DELETE")).toHaveLength(0);
});

async function simulateUnavailableImportDraftCache(page,{blocked=true,restore=false}={}){
  await page.addInitScript(({blocked,restore})=>{
    const context={initialBookId:null,initialTargetId:null};
    const prefix="yohaku:import-draft:";
    if(restore)sessionStorage.setItem(`${prefix}${JSON.stringify(context)}`,JSON.stringify({id:"imp",context}));
    const original=Storage.prototype.setItem;
    window.__blockImportDraftWrites=blocked;window.__rejectedImportDraftWrites=0;
    Storage.prototype.setItem=function(key,value){
      if(this===sessionStorage&&key.startsWith(prefix)&&window.__blockImportDraftWrites){
        window.__rejectedImportDraftWrites++;throw new DOMException("Import draft storage quota reached","QuotaExceededError");
      }
      return original.call(this,key,value);
    };
  },{blocked,restore});
}

async function leaveSavedImportWithoutDialog(page){
  await expect.poll(()=>page.evaluate(()=>window.__rejectedImportDraftWrites)).toBeGreaterThan(0);
  const prompts=[];page.on("dialog",async dialog=>{prompts.push(dialog.message());await dialog.accept();});
  await page.getByRole("button",{name:"返回",exact:true}).click();
  await expect(page.getByLabel("统一导入")).toHaveCount(0);
  expect(prompts).toEqual([]);
}

test("an uploaded PDF draft can be left when its browser cache cannot be written",async({page})=>{
  await simulateUnavailableImportDraftCache(page);
  const state=await fixture(page,{importType:"scan_pdf"});await page.goto("/");await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件",{exact:true}).setInputFiles({name:"saved.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-saved-fixture")});
  await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  await expect(page.getByLabel("确认来源类型",{exact:true})).toHaveValue("scan_pdf");
  await leaveSavedImportWithoutDialog(page);
  expect(state.calls.filter(call=>call.path==="/imports"&&call.method==="POST")).toHaveLength(1);
});

test("a server accepted PDF chapter job can be left when its browser cache cannot be written",async({page})=>{
  await simulateUnavailableImportDraftCache(page);
  const state=await startScannedBook(page,{keepExtracting:true});
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  await leaveSavedImportWithoutDialog(page);
  expect(state.calls.filter(call=>call.path==="/imports/imp/chapters"&&call.method==="POST").map(call=>call.input)).toEqual([{type:"scan_pdf",title:"扫描书籍"}]);
  expect(state.calls.filter(call=>call.path.startsWith("/imports/")&&call.method==="DELETE")).toHaveLength(0);
});

for(const restore of [true,false])test(`${restore?"restored":"resumed"} server PDF drafts can be left when their browser cache cannot be written`,async({page})=>{
  await simulateUnavailableImportDraftCache(page,{restore});
  const pending={id:"imp",title:"可继续的扫描书籍",detectedType:"scan_pdf",status:"staged",chapterAttempted:true,context:{bookId:null,targetId:null},chapterProcessing:{status:"extracting",type:"scan_pdf",completedPages:3,totalPages:10}};
  const state=await fixture(page,{importType:"scan_pdf",keepExtracting:true,draft:pending,serverDrafts:[pending]});await page.goto("/");await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  if(!restore)await page.getByRole("button",{name:"继续导入：可继续的扫描书籍",exact:true}).click();
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  await leaveSavedImportWithoutDialog(page);
  expect(state.calls.filter(call=>call.path.startsWith("/imports")&&call.method==="POST")).toHaveLength(0);
});

test("an added chapter still warns before leaving if its only copy is in the editor",async({page})=>{
  await simulateUnavailableImportDraftCache(page,{blocked:false});
  await startScannedBook(page);
  await expect(page.getByLabel("章节 1 标题",{exact:true})).toHaveValue("第一章");
  await page.evaluate(()=>{window.__blockImportDraftWrites=true;});
  await page.getByRole("button",{name:"添加章节",exact:true}).click();
  await expect(page.getByLabel("章节 3 标题",{exact:true})).toHaveValue("章节 3");
  await expect.poll(()=>page.evaluate(()=>window.__rejectedImportDraftWrites)).toBeGreaterThan(0);
  const prompts=[];page.on("dialog",async dialog=>{prompts.push(dialog.message());await dialog.dismiss();});
  await page.getByRole("button",{name:"返回",exact:true}).click();
  expect(prompts).toHaveLength(1);expect(prompts[0]).toContain("还没有保存");
  await expect(page.getByLabel("章节 3 标题",{exact:true})).toHaveValue("章节 3");
});

test("reopening an import after refresh restores its draft and resumes existing OCR progress",async({page})=>{
  const state=await startScannedBook(page,{keepExtracting:true});
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  const reads=state.calls.filter((call)=>call.path === "/imports/imp" && call.method === "GET").length;
  const acceptReload=(dialog)=>dialog.accept();page.on("dialog",acceptReload);await page.reload();page.off("dialog",acceptReload);
  await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  await expect(page.getByLabel("资料标题")).toHaveValue("扫描书籍");await expect(page.getByLabel("作为书籍导入")).toBeChecked();
  await expect.poll(()=>state.calls.filter((call)=>call.path === "/imports/imp" && call.method === "GET").length).toBeGreaterThan(reads+1);
  expect(state.calls.filter((call)=>call.path === "/imports" && call.method === "POST")).toHaveLength(1);
  expect(state.calls.filter((call)=>call.path === "/imports/imp/chapters")).toHaveLength(1);
  let prompts=0;page.on("dialog",async dialog=>{prompts++;await dialog.accept();});
  await page.getByRole("button",{name:"返回",exact:true}).click();
  await expect(page.getByLabel("统一导入")).toHaveCount(0);expect(prompts).toBe(0);
  const restoredReads=state.calls.filter(call=>call.path==="/imports/imp"&&call.method==="GET").length;
  await page.waitForTimeout(2200);
  expect(state.calls.filter(call=>call.path==="/imports/imp"&&call.method==="GET")).toHaveLength(restoredReads);
  expect(state.calls.filter(call=>call.path.includes("/imports/")&&call.method==="DELETE")).toHaveLength(0);
  await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  expect(state.calls.filter(call=>call.path==="/imports"&&call.method==="POST")).toHaveLength(1);
  expect(state.calls.filter(call=>call.path==="/imports/imp/chapters")).toHaveLength(1);
});

test("a selected file that has not been uploaded still warns before leaving",async({page})=>{
  const state=await fixture(page);await page.goto("/");await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件").setInputFiles({name:"unsaved.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-unsaved-fixture")});
  const dialogs=[];page.on("dialog",async dialog=>{dialogs.push(dialog.message());await dialog.dismiss();});
  await page.getByRole("button",{name:"返回",exact:true}).click();
  expect(dialogs).toHaveLength(1);expect(dialogs[0]).toMatch(/还没有保存/);
  await expect(page.getByLabel("统一导入")).toBeVisible();
  expect(state.calls.filter(call=>call.path==="/imports"&&call.method==="POST")).toHaveLength(0);
});

test("an image can be removed and selected again from the same native file path",async({page},info)=>{
  await fixture(page,{importType:"photo"});
  const png=await sharp({create:{width:12,height:12,channels:3,background:"white"}}).png().toBuffer();
  await mkdir(info.outputDir,{recursive:true});const path=info.outputPath("same.png");await writeFile(path,png);
  let uploaded;
  // Chromium's intercepted postData omits disk-backed file bytes; inspect the actual HTTP upload.
  const receiver=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);uploaded=Buffer.concat(chunks);
    response.writeHead(200,{"content-type":"application/json","access-control-allow-origin":"*"});
    response.end(JSON.stringify({id:"imp",status:"staged",detectedType:"photo",allowedTypes:["photo"]}));
  });
  await new Promise(resolve=>receiver.listen(0,"127.0.0.1",resolve));
  try{
    await page.route("**/api/imports",route=>route.request().method()==="POST"?route.continue({url:`http://127.0.0.1:${receiver.address().port}/upload`}):route.fallback());
    await page.goto("/");await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
    const chooseButton=page.getByRole("button",{name:"从设备选择文件",exact:true});
    await expect(chooseButton).toBeVisible();
    const accessibility=await page.context().newCDPSession(page);
    const {nodes}=await accessibility.send("Accessibility.getFullAXTree");
    await accessibility.detach();
    const pickerNames=nodes.filter(node=>!node.ignored&&node.role?.value==="button").map(node=>node.name?.value)
      .filter(name=>["从设备选择文件","选择来源文件"].includes(name));
    expect(pickerNames).toEqual(["从设备选择文件"]);
    const choose=async()=>{
      const selected=page.waitForEvent("filechooser");await chooseButton.click();await(await selected).setFiles(path);
    };
    await choose();
    await page.getByRole("button",{name:"移除 same.png",exact:true}).click();
    await expect(page.getByRole("button",{name:"继续确认类型",exact:true})).toBeDisabled();
    await choose();
    await expect(page.locator(".source-file-list li")).toHaveCount(1);
    await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
    await expect(page.getByLabel("确认来源类型",{exact:true})).toHaveValue("photo");
    expect(uploaded.includes(png)).toBe(true);
    expect(uploaded.toString("latin1").match(/filename="same\.png"/g)).toHaveLength(1);
  }finally{await new Promise(resolve=>receiver.close(resolve));}
});

test("repeated image selections upload in the adjusted order and a new selection starts empty",async({page},info)=>{
  await fixture(page,{importType:"photo"});
  const png=await sharp({create:{width:12,height:12,channels:3,background:"white"}}).png().toBuffer();
  const firstImage=info.outputPath("114.png"),secondImage=info.outputPath("105.png");
  await mkdir(info.outputDir,{recursive:true});
  await Promise.all([writeFile(firstImage,png),writeFile(secondImage,png)]);

  let uploaded;
  // A local HTTP receiver captures the browser's actual multipart body, including disk-backed files.
  const receiver=createServer(async(request,response)=>{
    const chunks=[];for await(const chunk of request)chunks.push(chunk);uploaded=Buffer.concat(chunks);
    response.writeHead(200,{"content-type":"application/json","access-control-allow-origin":"*"});
    response.end(JSON.stringify({id:"imp",status:"staged",detectedType:"photo",allowedTypes:["photo"]}));
  });
  await new Promise(resolve=>receiver.listen(0,"127.0.0.1",resolve));
  try{
    await page.route("**/api/imports",route=>route.request().method()==="POST"?route.continue({url:`http://127.0.0.1:${receiver.address().port}/upload`}):route.fallback());
    await page.goto("/");await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
    const input=page.getByLabel("选择来源文件",{exact:true});
    const chooseButton=page.getByRole("button",{name:"从设备选择文件",exact:true});
    const stageButton=page.getByRole("button",{name:"继续确认类型",exact:true});
    const rows=page.locator(".source-file-list li");
    const expectOrder=async(names)=>{
      await expect(rows).toHaveCount(names.length);
      for(const [index,name] of names.entries()){
        await expect(rows.nth(index).getByRole("button",{name:`移除 ${name}`,exact:true})).toBeVisible();
      }
    };
    const pasteImage=()=>page.getByLabel("上传或粘贴来源文件").evaluate((element,bytes)=>{
      const transfer=new DataTransfer();
      transfer.items.add(new File([new Uint8Array(bytes)],"pasted.png",{type:"image/png"}));
      element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:transfer}));
    },[...png]);

    await input.setInputFiles({name:"original.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-original")});
    await expectOrder(["original.pdf"]);
    await input.setInputFiles({name:"replacement.pdf",mimeType:"application/pdf",buffer:Buffer.from("%PDF-replacement")});
    await expectOrder(["replacement.pdf"]);
    await pasteImage();
    await expect(page.getByRole("alert")).toContainText("图片和其他文件请分开导入");
    await expectOrder(["replacement.pdf"]);
    await page.getByRole("button",{name:"移除 replacement.pdf",exact:true}).click();

    for(const path of [firstImage,secondImage]){
      const selected=page.waitForEvent("filechooser");await chooseButton.click();await(await selected).setFiles(path);
    }
    await expectOrder(["114.png","105.png"]);
    await pasteImage();
    await expectOrder(["114.png","105.png","pasted.png"]);
    await page.getByRole("button",{name:"上移 105.png",exact:true}).click();
    const expectedOrder=["105.png","114.png","pasted.png"];
    await expectOrder(expectedOrder);

    await stageButton.click();
    await expect(page.getByLabel("确认来源类型",{exact:true})).toHaveValue("photo");
    expect([...uploaded.toString("latin1").matchAll(/filename="([^"]+)"/g)].map((match)=>match[1])).toEqual(expectedOrder);

    await page.getByRole("button",{name:"重新选择",exact:true}).click();
    await expect(chooseButton).toBeEnabled();
    await expectOrder([]);
    await expect(stageButton).toBeDisabled();
  }finally{await new Promise(resolve=>receiver.close(resolve));}
});

test("file upload persists the entered title for a draft reopened without session storage",async({page})=>{
  await fixture(page,{importType:"epub"});
  const title="【持续回归】お目出たき人（EPUB）";
  let uploaded,savedTitle="";
  const draft=()=>({id:"imp",title:savedTitle,detectedType:"epub",allowedTypes:["epub"],status:"staged",context:{bookId:null,targetId:null}});
  await page.route("**/api/imports",route=>{
    if(route.request().method()!=="POST")return route.fulfill({json:{drafts:savedTitle?[draft()]:[]}});
    uploaded=route.request().postDataBuffer().toString("utf8");
    savedTitle=uploaded.match(/name="title"\r\n\r\n([^\r]*)/)?.[1] || "";
    return route.fulfill({json:draft()});
  });
  await page.goto("/");await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("资料标题",{exact:true}).fill(title);
  await page.getByLabel("选择来源文件",{exact:true}).setInputFiles({name:"pg31757-images.epub",mimeType:"application/epub+zip",buffer:Buffer.from("epub-fixture")});
  await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  await expect(page.getByLabel("确认来源类型",{exact:true})).toHaveValue("epub");
  expect(savedTitle).toBe(title);
  await page.evaluate(()=>sessionStorage.clear());
  await page.route("**/api/imports/imp",route=>route.fulfill({json:draft()}));
  await page.reload();await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByRole("button",{name:`继续导入：${title}`,exact:true}).click();
  await expect(page.getByLabel("资料标题",{exact:true})).toHaveValue(title);
});

test("a pending file upload locks file changes and preserves its server error until a new selection",async({page})=>{
  await fixture(page,{importType:"photo"});
  const png=await sharp({create:{width:12,height:12,channels:3,background:"white"}}).png().toBuffer();
  let release,entered=false,uploaded;
  const held=new Promise(resolve=>release=resolve);
  await page.route("**/api/imports",async route=>{
    if(route.request().method()!=="POST")return route.fallback();
    entered=true;uploaded=route.request().postDataBuffer();await held;
    return route.fulfill({status:503,json:{error:"当前上传未能保存，请重试。"}});
  });
  try{
    await page.goto("/");await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
    const input=page.getByLabel("选择来源文件",{exact:true});
    await input.setInputFiles({name:"first.png",mimeType:"image/png",buffer:png});
    await page.getByRole("button",{name:"继续确认类型",exact:true}).click();await expect.poll(()=>entered).toBe(true);
    await expect(page.getByRole("button",{name:"移除 first.png",exact:true})).toBeDisabled();
    await expect(input).toBeDisabled();
    await expect(page.getByRole("button",{name:"从设备选择文件",exact:true})).toBeDisabled();
    await expect(page.getByRole("tab",{name:"粘贴文字",exact:true})).toBeDisabled();
    await expect(page.getByRole("tab",{name:"上传或粘贴文件",exact:true})).toBeDisabled();
    await page.getByLabel("上传或粘贴来源文件",{exact:true}).evaluate((element,bytes)=>{
      const data=new DataTransfer();data.items.add(new File([new Uint8Array(bytes)],"late.png",{type:"image/png"}));
      element.dispatchEvent(new ClipboardEvent("paste",{bubbles:true,clipboardData:data}));
    },[...png]);
    await expect(page.locator(".source-file-list li")).toHaveCount(1);
    await expect(page.locator(".source-file-list")).toContainText("first.png");
    expect(uploaded.toString("latin1")).toContain('filename="first.png"');
    expect(uploaded.toString("latin1")).not.toContain("late.png");
    release();await expect(page.getByRole("alert")).toContainText("当前上传未能保存");
    await input.setInputFiles({name:"new.png",mimeType:"image/png",buffer:png});
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".source-file-list")).toContainText("new.png");
  }finally{release();}
});

test("choosing files again clears the previous import flow's error",async({page})=>{
  await fixture(page,{importType:"epub"});
  await page.route("**/api/imports/imp/confirm",route=>route.fulfill({status:400,json:{error:"请提供来源列表。"}}));
  await page.goto("/");await showShelf(page);await page.getByRole("button",{name:"添加",exact:true}).click();
  await page.getByLabel("选择来源文件",{exact:true}).setInputFiles({name:"old.epub",mimeType:"application/epub+zip",buffer:Buffer.from("epub-fixture")});
  await page.getByRole("button",{name:"继续确认类型",exact:true}).click();
  await page.getByRole("button",{name:"确认导入",exact:true}).click();
  await expect(page.getByRole("alert")).toContainText("请提供来源列表");
  await page.getByRole("button",{name:"重新选择",exact:true}).click();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(page.getByLabel("选择来源文件",{exact:true})).toBeEnabled();
});

test("a new tab without session cache resumes a server draft from the matching import context",async({page})=>{
  await startScannedBook(page,{keepExtracting:true});
  await expect(page.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
  const otherTab=await page.context().newPage();
  try {
    const pending={id:"imp",title:"后台扫描书籍",detectedType:"text_pdf",allowedTypes:["text_pdf","scan_pdf"],status:"staged",chapterAttempted:true,context:{bookId:null,targetId:null},chapterProcessing:{status:"extracting",type:"scan_pdf",completedPages:3,totalPages:10}};
    const state=await fixture(otherTab,{keepExtracting:true,draft:pending,serverDrafts:[pending,
      {...pending,id:"foreign",title:"其他书籍的后台任务",context:{bookId:"other-book",targetId:null}},
      {id:"legacy",title:"旧格式独立草稿",status:"staged",detectedType:"text"},
      {...pending,id:"complete",title:"已经确认的导入",status:"confirmed"},
    ]});
    await otherTab.goto("/");expect(await otherTab.evaluate(()=>Object.keys(sessionStorage).filter((key)=>key.startsWith("yohaku:import-draft:")).length)).toBe(0);
    await showShelf(otherTab);await otherTab.getByRole("button",{name:"添加",exact:true}).click();
    const list=otherTab.getByLabel("继续未完成的导入");await expect(list).toContainText("全书本地 OCR：3 / 10 页");
    await expect(list.getByRole("button",{name:"继续导入：旧格式独立草稿",exact:true})).toBeVisible();
    await expect(list.getByRole("button",{name:"继续导入：其他书籍的后台任务",exact:true})).toHaveCount(0);
    await expect(list.getByRole("button",{name:"继续导入：已经确认的导入",exact:true})).toHaveCount(0);
    await list.getByRole("button",{name:"继续导入：后台扫描书籍",exact:true}).click();
    await expect(otherTab.getByLabel("资料标题")).toHaveValue("后台扫描书籍");
    await expect(otherTab.getByLabel("确认来源类型")).toHaveValue("scan_pdf");await expect(otherTab.getByLabel("作为书籍导入")).toBeChecked();
    await expect(otherTab.getByLabel("PDF 分章进度")).toContainText("全书本地 OCR：3 / 10 页");
    await expect.poll(()=>state.calls.filter((call)=>call.path === "/imports/imp" && call.method === "GET").length).toBeGreaterThan(1);
    expect(state.calls.filter((call)=>call.path === "/imports" && call.method === "POST")).toHaveLength(0);
    expect(state.calls.filter((call)=>call.path === "/imports/imp/chapters")).toHaveLength(0);
  } finally {await otherTab.close();}
});

test("reselecting a restored PDF draft distinguishes identical saved drafts by task reference",async({page})=>{
  const title="同名扫描书籍",context={bookId:null,targetId:null};
  const makeDraft=(id,createdAt,chapterTitle)=>({
    id,taskId:`${id}:g2`,createdAt,title,context,status:"staged",detectedType:"scan_pdf",allowedTypes:["scan_pdf","text_pdf"],
    files:[{id:"file",name:"same.pdf",pageCount:10}],chapterAttempted:true,
    chapterProcessing:{status:"done",type:"scan_pdf",completedPages:10,totalPages:10},
    chapters:[{id:"chapter",title:chapterTitle,startPage:1,endPage:10,needsReview:false}],
  });
  const first=makeDraft("116ad9af-0000-4000-8000-000000000001","2026-11-04T10:00:00.100Z","已恢复草稿的章节");
  const second=makeDraft("731bf8ce-0000-4000-8000-000000000002","2026-11-04T10:00:00.900Z","另一份草稿的章节");
  const drafts=[second,first],reads=[];
  const state=await fixture(page,{serverDrafts:drafts});
  await page.route("**/api/imports/*",route=>{
    const request=route.request();
    const draft=drafts.find(item=>new URL(request.url()).pathname===`/api/imports/${item.id}`);
    if(request.method()!=="GET"||!draft)return route.fallback();
    reads.push(draft.id);
    return route.fulfill({json:draft});
  });
  await page.addInitScript(id=>{
    const context={initialBookId:null,initialTargetId:null};
    sessionStorage.setItem(`yohaku:import-draft:${JSON.stringify(context)}`,JSON.stringify({id,context}));
  },first.id);
  await page.goto("/");await showShelf(page);
  await page.getByRole("button",{name:"添加",exact:true}).click();
  await expect(page.getByLabel("章节 1 标题",{exact:true})).toHaveValue(first.chapters[0].title);
  expect(reads).toEqual([first.id]);

  await page.getByRole("button",{name:"重新选择",exact:true}).click();
  const list=page.getByLabel("继续未完成的导入");
  await expect(list).toBeVisible();
  await expect(list.getByText(title,{exact:true})).toHaveCount(2);
  const firstReference="2026-11-04 11:00:00 · #116ad9af",secondReference="2026-11-04 11:00:00 · #731bf8ce";
  await expect(list.getByText(firstReference)).toBeVisible();
  await expect(list.getByText(secondReference)).toBeVisible();
  const firstButton=list.getByRole("button",{name:`继续导入：${title} · ${firstReference}`,exact:true});
  const secondButton=list.getByRole("button",{name:`继续导入：${title} · ${secondReference}`,exact:true});
  await expect(firstButton).toHaveText("继续导入");
  await expect(secondButton).toHaveText("继续导入");
  expect(reads).toEqual([first.id]);
  await secondButton.click();
  await expect(page.getByLabel("章节 1 标题",{exact:true})).toHaveValue(second.chapters[0].title);
  expect(reads).toEqual([first.id,second.id]);
  expect(state.calls.filter(call=>call.path.startsWith("/imports")&&(call.method==="POST"||call.path.endsWith("/chapters")))).toEqual([]);
});


test("source questions carry current sentence and stable source scope",async({page})=>{
  const state=await fixture(page);await page.goto("/#doc");await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await expect(page.locator(".source-current-body .article-body")).toContainText(original);
  await page.locator(".source-current-body .article-body p").evaluate((element)=>{const range=document.createRange();range.selectNodeContents(element);const selection=window.getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event("selectionchange"));});
  await page.getByRole("button",{name:"翻译选区",exact:true}).click();
  await expect.poll(()=>state.calls.filter((call)=>call.path === "/documents/doc/conversations" && call.method === "POST").length).toBe(1);
  const question=state.calls.find((call)=>call.path === "/documents/doc/conversations" && call.method === "POST").input;
  expect(question.selection).toMatchObject({sourceIds:["s2"],sourceVersion:7,sourceLocalStart:0,sourceLocalEnd:original.length,start:6,end:6 + original.length});
  expect(question.selection.sentenceIds).toHaveLength(1);
});


test("source correction can remove all non-body text without changing the original",async({page})=>{
  const state=await fixture(page);await page.goto("/#doc");await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await page.getByRole("button",{name:"编辑正文与注音",exact:true}).click();await page.getByLabel("来源正文",{exact:true}).fill("");
  await expect(page.getByRole("button",{name:"保存正文",exact:true})).toBeEnabled();await page.getByRole("button",{name:"保存正文",exact:true}).click();
  await expect.poll(()=>state.saves.length).toBe(1);expect(bodyText(state.saves[0].bodyHtml)).toBe("");
  await expect(page.locator(".source-original-text")).toHaveText("保存された原文。");
});

test("full-body review distinguishes prepared blank and excluded sources from pending or failed extraction",async({page})=>{
  await fixture(page,{
    source1:{bodyHtml:"<p></p>",firstExtraction:{text:""}},
    source:{bodyHtml:"<p></p>",firstExtraction:{text:"广告内容"},original:{importExclusions:[{startLine:1,endLine:1}]}},
    extraSources:[{id:"pending",type:"text",position:2,status:"pending",bodyHtml:"",firstExtraction:null},{id:"failed",type:"text",position:3,status:"failed",bodyHtml:"",firstExtraction:{text:""}}],
  });
  await page.goto("/#doc");await page.getByRole("button",{name:"校对正文",exact:true}).click();
  await page.getByRole("button",{name:"全文检查",exact:true}).click();
  await expect(page.getByText("此来源没有正文",{exact:true})).toHaveCount(1);
  await expect(page.getByText("非正文内容已排除",{exact:true})).toHaveCount(1);
  await expect(page.getByText("此处正文尚未准备",{exact:true})).toHaveCount(2);
});


test("empty completed articles show an editing path without an endless preparation gate",async({page})=>{
  await fixture(page,{empty:true});await page.goto("/#doc");
  await expect(page.getByRole("heading",{name:"当前文章没有正文"})).toBeVisible();
  await expect(page.getByRole("button",{name:"校对正文",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"重试准备",exact:true})).toHaveCount(0);
  await expect(page.getByLabel("准备当前阅读页")).toHaveAttribute("aria-busy","false");
});

test("an unpublished next page never repeats the previous page as new content",async({page})=>{
  await fixture(page,{pendingNext:true});await page.goto("/#doc");
  await expect(page.getByLabel("日语原文")).toContainText(original);await page.getByLabel("阅读分页",{exact:true}).getByRole("button",{name:"下一页"}).click();
  await expect(page.getByRole("heading",{name:"正在准备当前阅读页"})).toBeVisible();
  await expect(page.getByLabel("日语原文")).toHaveCount(0);
  await expect(page.getByLabel("阅读分页",{exact:true})).toContainText("第 2 页");
  await expect(page.getByLabel("阅读分页",{exact:true}).getByRole("button",{name:"下一页"})).toBeDisabled();
});

test("new paginated articles retain the existing book promotion action",async({page})=>{
  await fixture(page);await page.goto("/#doc");
  await page.getByRole("button",{name:"转为书籍",exact:true}).click();
  await expect(page.getByRole("heading",{name:"将材料转为书籍",exact:true})).toBeVisible();
  await expect(page.getByLabel("书籍名称")).toHaveValue("分页阅读资料");
});

test("an emptied published page retains its position and navigation",async({page})=>{
  await fixture(page,{emptyPublished:true});await page.goto("/#doc");
  await expect(page.getByRole("heading",{name:"本页正文已清空",exact:true})).toBeVisible();
  await expect(page.getByRole("button",{name:"重试准备",exact:true})).toHaveCount(0);
  await page.getByLabel("页末阅读分页").getByRole("button",{name:"下一页",exact:true}).click();
  await expect(page.getByLabel("日语原文")).toContainText("次の読書ページ。");
});

test("source-scoped editing preserves batch readings and undo",async({page})=>{
  const text="空を見る。空が青い。";
  const state=await fixture(page,{source:{bodyHtml:html(text)}});await page.goto("/#doc");
  await page.getByRole("button",{name:"校对正文",exact:true}).click();await page.getByRole("button",{name:"编辑正文与注音",exact:true}).click();
  await page.getByRole("tab",{name:"批量注音",exact:true}).click();
  const batch=page.getByRole("tabpanel",{name:"批量注音",exact:true});
  await batch.getByLabel("要标注的词语").fill("空");await batch.getByRole("button",{name:"查找位置",exact:true}).click();
  const hits=page.getByRole("group",{name:"完整原文中的批量注音位置",exact:true}).locator("button.ruby-occurrence");
  await expect(hits).toHaveCount(2);await hits.first().click();await batch.getByLabel("批量假名读音").fill("そら");
  await batch.getByRole("button",{name:"应用到选中的 1 处",exact:true}).click();
  const preview=page.getByRole("region",{name:"阅读预览",exact:true});await expect(preview.locator("rt")).toHaveText(["そら"]);
  await page.getByRole("tab",{name:"正文编辑",exact:true}).click();await page.getByRole("button",{name:"撤销",exact:true}).click();await expect(page.locator(".source-edit-pane .preview-panel rt")).toHaveCount(0);
  await page.getByRole("button",{name:"重做",exact:true}).click();await page.getByRole("tab",{name:/^注音校正/}).click();await expect(preview.locator("rt")).toHaveText(["そら"]);
  await page.getByRole("button",{name:"保存正文",exact:true}).click();await expect.poll(()=>state.saves.length).toBe(1);
  expect(bodyText(state.saves[0].bodyHtml)).toBe(text);expect(state.saves[0].bodyHtml.match(/<ruby/g)).toHaveLength(1);
});
