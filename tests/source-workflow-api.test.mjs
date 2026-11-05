import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { ensureSession,cookieFromResponse } from './helpers/session.mjs';
import { bodyText,bodyRanges,blocksToHtml } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';
import { SENTENCE_SCHEMA } from '../shared/sentences.mjs';
import { ANNOTATION_SCHEMA } from '../shared/ocr-correction.mjs';

async function fixture(t,{connected=true,ndlOcr,beforeRun}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'yohaku-source-api-')),calls=[];
  const modelIds=['vision','correction-model','sentence-model','ruby-model','chat-model'];
  const checkedAt=new Date().toISOString();
  const reports=modelIds.map(model=>({model,checkedAt,passed:true,checks:Object.fromEntries(['json','image','streaming'].map(name=>[name,{state:'supported',checkedAt}]))}));
  function aiServices(_user,providerId) {
    const account={connected,activeAccountId:'account-'+providerId,subject:'subject-'+providerId};
    return {auth:{status:async()=>account,accounts:async()=>({accounts:[],activeId:account.activeAccountId})},credentialStatus:async()=>account,
      knownModels:()=>modelIds.map(id=>({id})),models:async()=>({models:modelIds.map(id=>({id}))}),testReports:async()=>reports,
      runtime:{status:()=>({model:'vision',busy:false}),stop(){},async run(input){
        await beforeRun?.(input);
        calls.push({providerId,model:input.model,prompt:input.prompt,schema:input.schema});
        let value;
        if(input.schema===SENTENCE_SCHEMA){const text=JSON.parse(input.prompt.split('输入正文：\n').at(-1).split('\n')[0]);value={sentences:text.match(/[^。]*。|[^。]+$/gu)||[text]};}
        else if(input.schema?.properties?.changes)value={changes:[],uncertain:[]};
        else if(input.schema===ANNOTATION_SCHEMA){const targets=JSON.parse(input.prompt.split('输入目标：\n').at(-1).split('\n')[0]);value={blocks:targets.map(({text})=>({words:[{t:text,r:'にほんご'}]}))};}
        else if(input.schema){value={text:JSON.parse(input.prompt.split('目标正文：\n').at(-1))};}
        return {completed:true,text:value?JSON.stringify(value):'語句の説明。',model:input.model,threadId:'source-api-thread'};
      }} };
  }
  let active;
  const localRuby={async annotate(text){return {annotations:[...text.matchAll(/日本語|本文|原文|情報|変更|追加|空|見|読/gu)].map(match=>({start:match.index,end:match.index+match[0].length,surface:match[0],reading:match[0]==='日本語'?'にほんご':'よみ'})),engine:'fixture'};},close(){}};
  async function start(){const instance=createApp({dataDir,aiServices,ndlOcr,localRuby,imageTaskOptions:{runnerOptions:{enabled:false}}});const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`,session=await ensureSession(url);active={instance,server,url,cookie:session.cookie,user:session.user};}
  async function stop(){if(!active)return;const previous=active;active=null;await previous.instance.shutdown();previous.server.closeAllConnections();await new Promise(resolve=>previous.server.close(resolve));}
  await start();t.after(async()=>{await stop();await rm(dataDir,{recursive:true,force:true});});
  // The in-process server and fetch client share a clock/event loop. Synchronous
  // source drains can delay both keep-alive timers past their idle deadline;
  // close completed test connections rather than reusing a stale pooled socket.
  async function request(path,method='GET',body,expected=200){const multipart=body instanceof FormData;const response=await fetch(active.url+'/api'+path,{method,headers:{Cookie:active.cookie,Connection:'close',...(body&&!multipart?{'Content-Type':'application/json'}:{})},...(body?{body:multipart?body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});const value=response.status===204?null:await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;}
  async function configure(){return request('/ai/roles','PUT',{version:0,annotationReferenceImage:false,roles:{ocr:{providerId:'openai',model:'vision'},correction:{providerId:'api_base',model:'correction-model'},segmentation:{providerId:'openai',model:'sentence-model'},annotation:{providerId:'api_base',model:'ruby-model'},chat:{providerId:'openai',model:'chat-model'}}});}
  async function importText(text){const draft=await request('/imports','POST',{text,title:'统一导入'},201);return request(`/imports/${draft.id}/confirm`,'POST',{type:'text',title:'按需阅读'},201);}
  return {request,calls,configure,importText,get url(){return active.url;},get instance(){return active.instance;},get user(){return active.user;},restart:async()=>{await stop();await start();}};
}

test('source tasks enforce ownership and running deletion; failed tombstones survive heartbeat/restart with original intact',{timeout:20000},async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  t.after(()=>release());
  const f=await fixture(t,{beforeRun:async input=>{if(input.model==='correction-model'){entered();await gate;throw Object.assign(new Error('controlled correction failure'),{status:400,expose:true});}}});await f.configure();
  const imported=await f.importText('日本語の原文。'),id=imported.firstDocumentId;
  await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await started;
  let task=(await f.request('/tasks?type=preparation')).tasks.find(task=>task.documentId===id);assert.ok(task);assert.equal(task.canDelete,false);
  await f.request(`/tasks/${task.id}`,'DELETE',{version:task.version},409);
  const invitation=await f.request('/invitations','POST',{},201);
  const response=await fetch(f.url+'/api/accounts/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:'task_isolation_friend',password:'fixture-friend-password',inviteToken:invitation.token})});
  assert.equal(response.status,201);const friend=cookieFromResponse(response);
  for(const [method,path] of [['GET',`/tasks/${task.id}`],['POST',`/tasks/${task.id}/retry`],['DELETE',`/tasks/${task.id}`]]){
    const result=await fetch(f.url+'/api'+path,{method,headers:{Cookie:friend,'Content-Type':'application/json'},...(method==='GET'?{}:{body:JSON.stringify({version:task.version})})});assert.equal(result.status,404);
  }
  release();await f.instance.sources.drain();task=await f.request(`/tasks/${task.id}`);assert.equal(task.canDelete,true);
  const sources=(await f.request(`/documents/${id}/sources`)).sources,preview=sources[0].preview;
  await f.request(`/tasks/${task.id}`,'DELETE',{version:task.version},204);
  const calls=f.calls.length;
  await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  assert.equal(f.calls.length,calls);assert.equal((await f.request('/tasks?type=preparation')).tasks.some(item=>item.id===task.id),false);
  assert.deepEqual((await f.request(`/documents/${id}/sources`)).sources[0].preview,preview);
  await f.restart();await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  await f.request(`/tasks/${task.id}`,'GET',undefined,404);
  assert.deepEqual((await f.request(`/documents/${id}/sources`)).sources[0].preview,preview);
});

test('deleting an empty book invalidates its running import proposal and preserves original bytes',{timeout:15000},async t=>{
  let release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const f=await fixture(t,{beforeRun:async input=>{if(input.schema?.properties?.chapters){entered();await gate;}}});await f.configure();
  const book=await f.request('/books','POST',{title:'导入中的目标书'},201);
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\ntrailer << /Root 1 0 R /Size 4 >>\n%%EOF');
  const form=new FormData();form.append('files',new Blob([pdf],{type:'application/pdf'}),'book.pdf');form.append('bookId',book.id);
  const draft=await f.request('/imports','POST',form,201);
  await f.request(`/imports/${draft.id}/chapters`,'POST',{type:'text_pdf'},202);await started;
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision+1},409);
  assert.equal((await f.request(`/tasks/${draft.id}`)).status,'running');
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision},204);
  const timeout=setTimeout(()=>release(),1000);await f.instance.imports.drain();clearTimeout(timeout);release();
  await f.request(`/tasks/${draft.id}`,'GET',undefined,404);
  const restored=await f.request(`/imports/${draft.id}`);assert.equal(restored.chapterProcessing.status,'failed');
  assert.equal((await f.request('/books')).books.length,0);assert.equal((await f.request('/tasks?type=import')).tasks.length,0);
  const request=await fetch(f.url+draft.files[0].previewUrl,{headers:{Cookie:(await ensureSession(f.url)).cookie}});assert.equal(request.status,200);assert.deepEqual(Buffer.from(await request.arrayBuffer()),pdf);
});

test('reading API exposes safe role diagnostics and retains failures after retry and server restart',async(t)=>{
  let failOnce=true;const f=await fixture(t,{beforeRun:input=>{if(failOnce&&input.model==='correction-model')throw Object.assign(new Error('private SDK request secret-token https://secret.example'),{code:'ECONNRESET'});}});await f.configure();
  const imported=await f.importText('日本語を読む。'),id=imported.firstDocumentId;
  await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  let reading=await f.request(`/documents/${id}/reading-pages`);
  assert.equal(reading.diagnostics.current.state,'failed');assert.equal(reading.diagnostics.current.step,'correct');assert.equal(reading.diagnostics.current.role,'correction');assert.equal(reading.diagnostics.current.providerId,'api_base');assert.equal(reading.diagnostics.current.model,'correction-model');assert.equal(reading.diagnostics.current.error.diagnostic.networkCode,'ECONNRESET');assert.equal(reading.diagnostics.recentFailures.length,1);assert.doesNotMatch(JSON.stringify(reading.diagnostics),/secret-token|secret\.example|private SDK/);
  const tasks=await f.request('/tasks');assert.doesNotMatch(JSON.stringify(tasks),/secret-token|secret\.example|private SDK/);
  await f.restart();reading=await f.request(`/documents/${id}/reading-pages`);assert.equal(reading.diagnostics.recentFailures.length,1);
  failOnce=false;await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true,retry:true});await f.instance.sources.drain();
  reading=await f.request(`/documents/${id}/reading-pages`);assert.equal(reading.currentPage.ready,true);assert.equal(reading.diagnostics.current,null);assert.equal(reading.diagnostics.recentFailures.length,1);
});

test('a reading page spanning six PDF sources makes one hybrid proofreading request and persists local steps',async(t)=>{
  const f=await fixture(t);await f.configure();
  const article=await f.request('/documents','POST',{title:'跨来源注音',kind:'article',orientation:'horizontal',content:'準備中。'},201);
  const texts=Array.from({length:6},(_,i)=>'日本語を読む。'.repeat(20)+`${i}。`);
  f.instance.sources.createArticleSources(f.user.id,article.id,texts.map((text,i)=>({id:`batch-pdf-${i}`,type:'text_pdf',text,needsCorrection:false})));
  const session=await f.request(`/documents/${article.id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  const reviews=f.calls.filter(call=>call.model==='ruby-model');assert.equal(reviews.length,1);assert.ok(reviews[0].schema.properties.changes);
  const reading=await f.request(`/documents/${article.id}/reading-pages`);assert.equal(reading.currentPage.sourceIds.length,6);assert.equal(reading.currentPage.ready,true);assert.equal(bodyText(reading.currentPage.bodyHtml),texts.join(''));
  const {sources}=await f.request(`/documents/${article.id}/sources`);assert.ok(sources.every(source=>source.steps.some(step=>step.step.startsWith('annotate_local:')&&step.status==='completed')));
  assert.ok(sources.every(source=>source.bodyHtml.includes('<rt>にほんご</rt>')));
  await f.request(`/documents/${article.id}/reading-session`,'POST',{sessionId:session.sessionId,index:0,active:false});await f.restart();
  const count=f.calls.length;await f.request(`/documents/${article.id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();assert.equal(f.calls.length,count);
});

test('new text imports prepare current plus two pages, retain scopes and QA through manual edits and restart',async(t)=>{
  const f=await fixture(t);await f.configure();const text='日本語を読む。'.repeat(650);
  const imported=await f.importText(text),id=imported.firstDocumentId;
  let detail=await f.request(`/documents/${id}`);assert.equal(detail.sourceWorkflow,true);assert.ok(detail.sources.length>=4);
  assert.equal(f.calls.length,0);assert.equal(detail.reading.totalPages,undefined);
  const preview=await f.request(`/documents/${id}/sources`);assert.ok(preview.sources.every(source=>source.status==='pending'));
  assert.ok(preview.sources.every(source=>!JSON.stringify(source).includes('filePath')));
  await f.request(`/documents/${id}/reading-pages`);await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,0);
  const session=await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  let reading=await f.request(`/documents/${id}/reading-pages`);
  assert.equal(reading.pages.length,3);assert.equal(reading.totalPages,undefined);assert.equal(reading.currentPage.ready,true);
  const prepared=(await f.request('/tasks?scope=archived&type=preparation')).tasks.find(task=>task.documentId===id);
  assert.ok(prepared,'completed requested pages archive through the real task API while the unread article tail remains pending');
  assert.equal(prepared.status,'completed');assert.ok(prepared.targets.some(target=>target.mode==='reading'&&target.index===0&&!target.prefetch));
  assert.equal((await f.request('/tasks?scope=active&type=preparation')).tasks.some(task=>task.documentId===id),false);
  assert.ok(f.calls.some(call=>call.model==='correction-model'&&call.providerId==='api_base'));
  assert.ok(f.calls.some(call=>call.model==='sentence-model'));assert.ok(f.calls.some(call=>call.model==='ruby-model'));
  assert.equal(f.calls.some(call=>call.model==='vision'),false);
  const processedCalls=f.calls.length;
  await f.request(`/documents/${id}/reading-session`,'POST',{sessionId:session.sessionId,index:0,active:false});
  detail=await f.request(`/documents/${id}`);const page=reading.currentPage,range=bodyRanges(detail.bodyHtml).sentences[0];
  const conversation=await f.request(`/documents/${id}/conversations`,'POST',{operation:'grammar',selection:{start:range.start,end:range.end,text:range.text,bodyHash:detail.bodyHash,sentenceIds:[range.id],readingPageId:page.id,sourceIds:page.sourceIds}},201);
  assert.equal(conversation.groups[0].selection.readingPageId,page.id);assert.ok(conversation.groups[0].selection.sourceRanges.length);
  const source=detail.sources[0],otherText=detail.sources[1].text;
  await f.request(`/documents/${id}/sources/${source.id}/checked`,'POST',{version:source.version,checked:true});
  const edit=await f.request(`/documents/${id}/sources/${source.id}/edit`,'POST',{});
  const saved=await f.request(`/documents/${id}/sources/${source.id}`,'PUT',{version:source.version,text:'追加した文。'+source.text});
  assert.equal(saved.checked,false);assert.equal(saved.manual,true);assert.equal(saved.firstExtraction.text,source.firstExtraction.text);
  await f.request(`/documents/${id}/sources/${source.id}/edit`,'DELETE',{sessionId:edit.sessionId});
  await f.request(`/documents/${id}/sources/${source.id}/prepare`,'POST',{index:0});await f.instance.sources.drain();
  const changed=await f.request(`/documents/${id}`);assert.equal(changed.sources[1].text,otherText);
  assert.equal(changed.sources[0].text,'追加した文。'+source.text);
  assert.equal(f.calls.slice(processedCalls+1).some(call=>call.model==='correction-model'),false);
  const newPages=await f.request(`/documents/${id}/reading-pages`);assert.deepEqual(newPages.pages.map(p=>p.id),reading.pages.map(p=>p.id));
  assert.equal(bodyText(newPages.pages[1].bodyHtml),bodyText(reading.pages[1].bodyHtml));
  await f.restart();const restored=await f.request(`/documents/${id}/conversations`);
  assert.deepEqual(await f.request(`/tasks/${prepared.id}`),prepared,'later manual edits and restart cannot change the completed scope snapshot');
  assert.equal(restored.conversations[0].groups[0].selection.text,range.text);assert.equal(restored.conversations[0].messages.length,2);
  const count=f.calls.length;await f.request(`/documents/${id}/sources`);await f.instance.sources.drain();assert.equal(f.calls.length,count);
});

test('screenshot local OCR saves real regions before provider authorization and preview starts no extraction',async(t)=>{
  let ocrCalls=0;const f=await fixture(t,{connected:false,ndlOcr:{async recognize(path){ocrCalls++;assert.ok(path);return {regions:[{text:'本地の原文。',label:'line-1'}],warnings:[]};},close(){}}});
  const buffer=await sharp({create:{width:30,height:50,channels:3,background:'white'}}).png().toBuffer(),form=new FormData();
  form.append('files',new Blob([buffer],{type:'image/png'}),'Screenshot.png');
  const draft=await f.request('/imports','POST',form,201),imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'screenshot',title:'截图'},201),id=imported.firstDocumentId;
  const {sources:[source]}=await f.request(`/documents/${id}/sources`);assert.equal(ocrCalls,0);assert.equal(f.calls.length,0);assert.equal(source.original.filePath,undefined);
  await f.request(`/documents/${id}/sources/${source.id}/prepare`,'POST',{});await f.instance.sources.drain();
  const result=await f.request(`/documents/${id}/sources/${source.id}`);assert.equal(ocrCalls,1);assert.equal(f.calls.length,0);
  assert.equal(result.firstExtraction.text,'本地の原文。');assert.equal(result.status,'failed');assert.match(result.error,/授权|连接|不可用/);
  const saved=await f.request(`/documents/${id}/sources/${source.id}`,'PUT',{version:result.version,text:'人工补回。'});assert.equal(saved.manual,true);assert.equal(saved.firstExtraction.text,'本地の原文。');assert.equal(ocrCalls,1);
});


test('source-managed QA deletion clears canonical marks and old whole-article mutation routes stay guarded',async(t)=>{
  const f=await fixture(t);await f.configure();const imported=await f.importText('日本語を読む。空を見る。'),id=imported.firstDocumentId;
  await f.request(`/documents/${id}/reading-session`,'POST',{active:true,index:0});await f.instance.sources.drain();
  let detail=await f.request(`/documents/${id}`);const sentence=bodyRanges(detail.bodyHtml).sentences[0],source=detail.sources[0];
  const conversation=await f.request(`/documents/${id}/conversations`,'POST',{operation:'grammar',selection:{start:sentence.start,end:sentence.end,text:sentence.text,bodyHash:detail.bodyHash,sentenceIds:[sentence.id],sourceIds:[source.id],sourceVersion:source.version,sourceLocalStart:sentence.start,sourceLocalEnd:sentence.end}},201);
  detail=await f.request(`/documents/${id}`);assert.ok(bodyRanges(detail.bodyHtml).qa.length);assert.ok(bodyRanges(detail.sources[0].bodyHtml).qa.length);
  await f.request(`/conversations/${conversation.id}`,'DELETE',undefined,204);
  detail=await f.request(`/documents/${id}`);assert.equal(bodyRanges(detail.bodyHtml).qa.length,0);assert.equal(bodyRanges(detail.sources[0].bodyHtml).qa.length,0);
  const pages=await f.request(`/documents/${id}/reading-pages`);assert.ok(pages.pages.every(page=>bodyRanges(page.bodyHtml).qa.length===0));
  await f.request(`/documents/${id}/sentences`,'POST',{revision:detail.revision,bodyHash:detail.bodyHash,force:true},409);
  await f.request(`/documents/${id}`,'PUT',{title:'改动标题',kind:detail.kind,orientation:'horizontal',revision:detail.revision,bodyHtml:blocksToHtml(parseText('改变正文。'))},409);
  const renamed=await f.request(`/documents/${id}`,'PUT',{title:'改动标题',kind:detail.kind,orientation:'horizontal',revision:detail.revision,bodyHtml:detail.bodyHtml});
  assert.equal(renamed.title,'改动标题');assert.equal(bodyText(renamed.bodyHtml),bodyText(detail.bodyHtml));assert.equal(renamed.sourceWorkflow,true);
});

test('source-scoped versioned QA tolerates unrelated source changes and rejects changes to its own source',async(t)=>{
  const f=await fixture(t);await f.configure();const imported=await f.importText('日本語を読む。'.repeat(220)),id=imported.firstDocumentId;
  const session=await f.request(`/documents/${id}/reading-session`,'POST',{active:true,index:0});await f.instance.sources.drain();
  await f.request(`/documents/${id}/reading-session`,'POST',{sessionId:session.sessionId,active:false,index:0});
  const original=await f.request(`/documents/${id}`);assert.ok(original.sources.length>=2);
  const [first,second]=original.sources,sentence=bodyRanges(first.bodyHtml).sentences[0];
  const selection={start:sentence.start,end:sentence.end,text:sentence.text,bodyHash:original.bodyHash,sentenceIds:[sentence.id],sourceIds:[first.id],sourceVersion:first.version,sourceLocalStart:sentence.start,sourceLocalEnd:sentence.end};
  await f.request(`/documents/${id}/sources/${second.id}`,'PUT',{version:second.version,text:'別の情報。'+second.text});
  const progressed=await f.request(`/documents/${id}`);assert.notEqual(progressed.bodyHash,original.bodyHash);assert.equal(progressed.sources[0].version,first.version);
  const conversation=await f.request(`/documents/${id}/conversations`,'POST',{operation:'grammar',selection},201);
  assert.equal(conversation.groups[0].selection.text,sentence.text);assert.equal(conversation.groups[0].selection.sourceRanges[0].version,first.version);
  await f.request(`/documents/${id}/sources/${first.id}`,'PUT',{version:first.version,text:'自分の変更。'+first.text});
  const rejected=await f.request(`/documents/${id}/conversations`,'POST',{operation:'grammar',selection},409);assert.match(rejected.error,/来源已修改|重新选择/);
  const history=await f.request(`/documents/${id}/conversations`);assert.equal(history.conversations[0].messages.length,2);assert.equal(history.conversations[0].groups[0].selection.text,sentence.text);
});

test('unified imports, source saves and article metadata invalidate the previous book revision',async(t)=>{
  const f=await fixture(t);
  let book=await f.request('/books','POST',{title:'文章集'},201);
  const stage=async()=>f.request('/imports','POST',{text:'追加する本文。',title:'新しい文章'},201);
  let draft=await stage();
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'text',title:'新しい文章',bookId:book.id},201);
  const updated=await f.request(`/books/${book.id}`);
  assert.equal(updated.revision,book.revision+1);
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision},409);
  book=updated;draft=await stage();
  await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'text',title:'追加',targetId:imported.firstDocumentId},201);
  const appended=await f.request(`/books/${book.id}`);
  assert.equal(appended.revision,book.revision+1);
  assert.equal(appended.articleCount,1);
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision},409);
  book=appended;
  let article=await f.request(`/documents/${imported.firstDocumentId}`),source=article.sources[0];
  await f.request(`/documents/${article.id}/sources/${source.id}`,'PUT',{version:source.version,text:'人工补字。'+source.text});
  const edited=await f.request(`/books/${book.id}`);assert.equal(edited.revision,book.revision+1);
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision},409);
  book=edited;article=await f.request(`/documents/${article.id}`);
  await f.request(`/documents/${article.id}`,'PUT',{title:'重新命名',kind:article.kind,orientation:'horizontal',revision:article.revision,bodyHtml:article.bodyHtml});
  assert.equal((await f.request(`/books/${book.id}`)).revision,book.revision+1);
  await f.request(`/books/${book.id}`,'DELETE',{revision:book.revision},409);
});

test('photo and screenshot imports remain one article when placed in an existing book',async(t)=>{
  const f=await fixture(t),book=await f.request('/books','POST',{title:'图片文章集'},201);
  const buffer=await sharp({create:{width:20,height:30,channels:3,background:'white'}}).png().toBuffer();
  const stage=async(count)=>{const form=new FormData();for(let i=0;i<count;i++)form.append('files',new Blob([buffer],{type:'image/png'}),`image-${i}.png`);return f.request('/imports','POST',form,201);};
  let draft=await stage(2);
  await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'photo',title:'一篇照片文章',asBook:true},400);
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'photo',title:'一篇照片文章',bookId:book.id},201);
  assert.equal(imported.documents.length,1);assert.equal(imported.bookId,book.id);
  let article=await f.request(`/documents/${imported.firstDocumentId}`);
  assert.equal(article.sources.length,2);assert.equal(article.bookId,book.id);
  draft=await stage(1);
  await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'screenshot',title:'追加截图',targetId:article.id},201);
  article=await f.request(`/documents/${article.id}`);assert.equal(article.sources.length,3);
  const updated=await f.request(`/books/${book.id}`);assert.equal(updated.articleCount,1);
  assert.equal((await f.request('/books')).books.length,1);assert.equal(f.calls.length,0);
});
