import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import sharp from 'sharp';
import { createApp } from '../server/app.mjs';
import { ensureSession,cookieFromResponse } from './helpers/session.mjs';
import { applySentenceBoundaries,bodyText,bodyRanges,blocksToHtml,htmlToBlocks,syncBodyReadings,markBodyRange } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';
import { SENTENCE_SCHEMA } from '../shared/sentences.mjs';
import { ANNOTATION_SCHEMA } from '../shared/ocr-correction.mjs';

async function fixture(t,{connected=true,ndlOcr,beforeRun,chapterProposal,correctionEdits=[]}={}) {
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
        if(input.schema?.properties?.chapters&&chapterProposal)value=chapterProposal;
        else if(input.schema===SENTENCE_SCHEMA){const text=JSON.parse(input.prompt.split('输入正文：\n').at(-1).split('\n')[0]);value={sentences:text.match(/[^。]*。|[^。]+$/gu)||[text]};}
        else if(input.schema?.properties?.changes)value={changes:[],uncertain:[]};
        else if(input.schema===ANNOTATION_SCHEMA){const targets=JSON.parse(input.prompt.split('输入目标：\n').at(-1).split('\n')[0]);value={blocks:targets.map(({text})=>({words:[{t:text,r:'にほんご'}]}))};}
        else if(input.schema?.properties?.edits)value={edits:correctionEdits};
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
  return {request,calls,configure,importText,dataDir,get url(){return active.url;},get instance(){return active.instance;},get user(){return active.user;},restart:async()=>{await stop();await start();}};
}

test('out-of-order reading heartbeats cannot change a newer demand or saved page',async t=>{
  const f=await fixture(t);
  const create=title=>f.request('/documents','POST',{title,kind:'article',orientation:'horizontal',content:'準備中。'},201);
  const {id}=await create('阅读位置'),other=await create('其他资料');
  const text=['甲','乙','丙'].map(char=>(char.repeat(99)+'。').repeat(10)).join('');
  const sourceId='reading-position-source',bodyHtml=applySentenceBoundaries(blocksToHtml(parseText(text)),text.match(/[^。]*。/gu));
  f.instance.sources.createArticleSources(f.user.id,id,[{id:sourceId,type:'text',bodyHtml,status:'ready',needsCorrection:false}]);
  const path=`/documents/${id}`,sessionId='ordered-reading-session';
  const beat=(event,session=sessionId,expected=200)=>f.request(`${path}/reading-session`,'POST',{sessionId:session,...event},expected);
  const database=new DatabaseSync(join(f.dataDir,'yohaku.sqlite'),{readOnly:true});
  const readSession=(session=sessionId)=>database.prepare('SELECT mode,source_id,page_index,active,expires_at,last_sequence FROM reading_sessions WHERE id=?').get(session);
  const readBookmark=()=>database.prepare('SELECT page_id,page_index FROM reading_positions WHERE user_id=? AND document_id=?').get(f.user.id,id);
  try{
    await beat({index:0,sequence:1});
    const second=await beat({index:1,sequence:3}),activeSecond=readSession();
    assert.equal(activeSecond.active,1);
    assert.equal(activeSecond.page_index,1);
    assert.equal((await beat({active:false,sequence:2})).currentPage.id,second.currentPage.id);
    assert.deepEqual(readSession(),activeSecond);

    const third=await beat({index:2,sequence:5}),activeThird=readSession();
    for(const sequence of [4,5,undefined]){
      const ignored=await beat({index:0,sequence,retry:true});
      assert.equal(ignored.index,2);
      assert.equal(ignored.currentPage.id,third.currentPage.id);
      assert.deepEqual(readSession(),activeThird);
    }
    assert.equal(database.prepare('SELECT COUNT(*) AS count FROM source_preparation_requests WHERE document_id=?').get(id).count,0,'stale retries do not create work');
    assert.equal((await f.request(`${path}/reading-pages`)).index,2);
    await f.request(`/documents/${other.id}/reading-session`,'POST',{sessionId,sequence:4,index:0},404);
    assert.deepEqual(readSession(),activeThird);

    await beat({active:false,sequence:7});
    const stopped=readSession();assert.equal(stopped.active,0);
    assert.equal((await beat({index:0,sequence:6})).index,2);
    assert.deepEqual(readSession(),stopped);
    assert.equal(readBookmark().page_index,2);
    await beat({index:1,sequence:8});
    assert.equal(readSession().active,1);
    assert.equal(readBookmark().page_index,1);

    await beat({active:false,sequence:2},'stop-arrives-first');
    assert.equal((await beat({index:0,sequence:1},'stop-arrives-first')).index,1);
    assert.equal(readSession('stop-arrives-first').active,0);
    assert.equal(readBookmark().page_index,1);

    await beat({index:0},'legacy-reader');
    assert.equal(readBookmark().page_index,0);
    await beat({index:1},'legacy-reader');
    assert.equal(readBookmark().page_index,1);
    await beat({mode:'correction',sourceId,index:0,sequence:1},'correction-session');
    assert.equal(readSession('correction-session').mode,'correction');
    assert.equal(readBookmark().page_index,1);
    const clamped=await beat({index:99,sequence:9});
    assert.equal(clamped.index,2);
    assert.deepEqual({...readBookmark()},{page_id:clamped.currentPage.id,page_index:2});
    for(const sequence of [0,1.5,Number.MAX_SAFE_INTEGER+1])await beat({index:0,sequence},sessionId,400);
    assert.equal((await f.request(`${path}/reading-pages`)).index,2);

    await f.restart();
    const restored=readSession();
    assert.equal(restored.active,0);
    assert.equal(restored.last_sequence,9);
    assert.equal((await beat({index:0,sequence:8})).index,2);
    assert.deepEqual(readSession(),restored);
    await beat({index:1,sequence:10});
    assert.equal(readSession().active,1);
    assert.equal(readBookmark().page_index,1);
  }finally{database.close();}
});

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
  const sourcePath=`/documents/${id}/sources/${sources[0].id}`,source=await f.request(sourcePath);
  assert.equal(source.failedCorrection.status,'failed');
  const keep={version:source.version,failedCorrectionAttemptId:source.failedCorrection.attemptId};
  const denied=await fetch(f.url+`/api${sourcePath}/keep-current`,{method:'POST',headers:{Cookie:friend,'Content-Type':'application/json'},body:JSON.stringify(keep)});
  assert.equal(denied.status,404);
  await f.request(`/tasks/${task.id}`,'DELETE',{version:task.version},204);
  assert.equal((await f.request(sourcePath)).failedCorrection,null);
  await f.request(`${sourcePath}/keep-current`,'POST',keep,409);
  const calls=f.calls.length;
  await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  assert.equal(f.calls.length,calls);assert.equal((await f.request('/tasks?type=preparation')).tasks.some(item=>item.id===task.id),false);
  assert.deepEqual((await f.request(`/documents/${id}/sources`)).sources[0].preview,preview);
  await f.restart();await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});await f.instance.sources.drain();
  await f.request(`/tasks/${task.id}`,'GET',undefined,404);
  await f.request(`${sourcePath}/keep-current`,'POST',keep,409);
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

for(const target of ['document','book'])for(const committed of [false,true])test(`${committed?'committed':'rolled-back'} ${target} deletion ${committed?'aborts':'preserves'} the same staged import proposal`,{timeout:15000},async t=>{
  let release,entered,signal;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const chapterProposal={chapters:[{title:'原文',startPage:1,endPage:1,excluded:false,needsReview:false}],exclusions:[]};
  const f=await fixture(t,{chapterProposal,beforeRun:async input=>{if(input.schema?.properties?.chapters){signal=input.signal;entered();await gate;}}});await f.configure();
  const record=target==='book'?await f.request('/books','POST',{title:'导入目标'},201):await f.request('/documents','POST',{title:'导入目标',kind:'article',orientation:'horizontal',content:'原文。'},201);
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\ntrailer << /Root 1 0 R /Size 4 >>\n%%EOF');
  const form=new FormData();form.append('files',new Blob([pdf],{type:'application/pdf'}),'atomic-import.pdf');form.append(target==='book'?'bookId':'targetId',record.id);
  const draft=await f.request('/imports','POST',form,201),path=`/${target==='book'?'books':'documents'}/${record.id}`;
  await f.request(`/imports/${draft.id}/chapters`,'POST',{type:'text_pdf'},202);await started;
  assert.ok(signal);assert.equal(signal.aborted,false);
  const originalSignal=signal,database=new DatabaseSync(join(f.dataDir,'yohaku.sqlite'));
  try{
    const before=database.prepare('SELECT * FROM import_drafts WHERE id=?').get(draft.id);
    if(!committed)database.exec(`CREATE TRIGGER reject_import_target_delete BEFORE DELETE ON ${target==='book'?'books':'documents'} BEGIN SELECT RAISE(ABORT,'fixture rejected final delete'); END;`);
    try{await f.request(path,'DELETE',{revision:record.revision},committed?204:500);}
    finally{if(!committed)database.exec('DROP TRIGGER reject_import_target_delete');}
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(signal,originalSignal,'deletion must not replace the existing provider attempt');
    assert.equal(signal.aborted,committed,'only a committed target deletion may abort the import execution');
    if(committed){
      await f.instance.imports.drain();
      const stopped=database.prepare('SELECT task_generation,task_deleted_at FROM import_drafts WHERE id=?').get(draft.id);
      assert.equal(stopped.task_generation,before.task_generation);assert.ok(stopped.task_deleted_at);
      await f.request(`/tasks/${draft.id}`,'GET',undefined,404);
      await f.request(path,'GET',undefined,404);
    }else{
      assert.deepEqual(database.prepare('SELECT * FROM import_drafts WHERE id=?').get(draft.id),before,'rollback must restore the draft, checkpoints and live execution identity');
      assert.equal((await f.request(`/tasks/${draft.id}`)).status,'running');
      assert.equal((await f.request(path)).id,record.id);
    }
    release();await f.instance.imports.drain();
    const result=await f.request(`/imports/${draft.id}`);
    assert.equal(result.chapterProcessing.status,committed?'failed':'done');
    assert.equal(f.calls.filter(call=>call.schema?.properties?.chapters).length,1,'a rolled-back deletion must reuse the original valid provider result');
    if(committed){
      assert.deepEqual(result.chapters,[],'late chapter results must not restore a deleted target');
      await f.request(`/tasks/${draft.id}`,'GET',undefined,404);
    }else{
      assert.equal(result.chapters.length,1);assert.equal(result.chapters[0].title,'原文');
      assert.equal((await f.request(`/tasks/${draft.id}`)).status,'requires_review');
    }
    const raw=await fetch(f.url+draft.files[0].previewUrl,{headers:{Cookie:(await ensureSession(f.url)).cookie}});
    assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),pdf);
  }finally{database.close();}
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

test('an excluded PDF source keeps its exact OCR and does not block the first reading page',async t=>{
  const first='日本語'+'あ'.repeat(166)+'。',second='本文'+'い'.repeat(187)+'。',tail='続'.repeat(30);
  const rawExcluded='章末页眉\n \n ',ocrPages=[first,rawExcluded,second+tail,'きます。後のページ。'];
  const chapterProposal={chapters:[{title:'本文の章',startPage:1,endPage:4,excluded:false,needsReview:false}],exclusions:[{page:2,startLine:1,endLine:1,reason:'页眉'}]};
  let extracted=0;
  const f=await fixture(t,{chapterProposal,ndlOcr:{async recognize(){return {text:ocrPages[extracted++],regions:[]};},close(){}}});
  await f.configure();
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >> endobj\n'+
    Array.from({length:4},(_,i)=>`${i+3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\n`).join('')+'trailer << /Root 1 0 R /Size 7 >>\n%%EOF');
  const form=new FormData();form.append('files',new Blob([pdf],{type:'application/pdf'}),'blank-source.pdf');
  const draft=await f.request('/imports','POST',form,201),path=`/imports/${draft.id}`;
  await f.request(path+'/chapters','POST',{type:'scan_pdf'},202);
  await f.instance.imports.drain();
  const proposal=await f.request(path);
  assert.equal(proposal.chapterProcessing.status,'done');
  assert.equal(extracted,4);
  const saved=await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters:proposal.chapters,exclusions:proposal.exclusions},201);
  const chapter=`/documents/${saved.firstDocumentId}`,{sources}=await f.request(chapter+'/sources');
  assert.equal(sources[1].firstExtraction.text,rawExcluded);
  assert.equal(bodyText(sources[1].firstExtraction.bodyHtml),rawExcluded);
  assert.equal(sources[1].status,'ready');
  for(const source of [sources[0],sources[2]]){
    await f.request(`${chapter}/sources/${source.id}/prepare`,'POST',{});
    await f.instance.sources.drain();
  }
  const {sources:prepared}=await f.request(chapter+'/sources');
  assert.deepEqual(prepared.map(source=>source.status),['ready','ready','ready','pending']);
  const reading=await f.request(chapter+'/reading-pages?index=0');
  assert.equal(reading.currentPage?.ready,true,'excluded whitespace must not block a complete, annotated first page');
  assert.equal(bodyText(reading.currentPage.bodyHtml),first+second);
  assert.deepEqual(reading.currentPage.sourceIds,[sources[0].id,sources[2].id]);
  assert.equal(reading.complete,false);
  assert.equal(prepared[1].text,'');
  assert.equal(prepared[1].firstExtraction.text,rawExcluded);
});

test('saving only PDF readings through the source API preserves cross-page sentences and manual ruby',async t=>{
  const left='前文。みんなそうしているん',right='です。終わり。';
  let extracted=0;
  const f=await fixture(t,{chapterProposal:{chapters:[{title:'本文',startPage:1,endPage:2,needsReview:false}],exclusions:[]},
    ndlOcr:{async recognize(){return {text:[left,right][extracted++],regions:[]};},close(){}}});
  await f.configure();
  const pdf=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\n4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\ntrailer << /Root 1 0 R /Size 5 >>\n%%EOF');
  const form=new FormData();form.append('files',new Blob([pdf],{type:'application/pdf'}),'ruby-tail.pdf');
  const draft=await f.request('/imports','POST',form,201),importPath=`/imports/${draft.id}`;
  await f.request(importPath+'/chapters','POST',{type:'scan_pdf'},202);await f.instance.imports.drain();
  const proposal=await f.request(importPath);
  const saved=await f.request(importPath+'/confirm','POST',{type:'scan_pdf',title:'本文',asBook:true,chapters:proposal.chapters,exclusions:[]},201);
  const path=`/documents/${saved.firstDocumentId}`,{sources}=await f.request(path+'/sources');
  const prepared=await f.request(`${path}/sources/${sources[0].id}/prepare`,'POST',{});await f.instance.sources.drain();
  await f.request(path+'/reading-session','POST',{sessionId:prepared.sessionId,active:false});
  const before=await f.request(`${path}/sources/${sources[0].id}`),blocks=htmlToBlocks(before.bodyHtml);
  blocks[0].segments=[{text:'前文',reading:'まえぶん',origin:'manual'},{text:left.slice(2)}];
  const editorHtml=syncBodyReadings(before.bodyHtml,blocks);
  assert.deepEqual(bodyRanges(editorHtml).sentences,bodyRanges(before.bodyHtml).sentences);
  const updated=await f.request(`${path}/sources/${sources[0].id}`,'PUT',{version:before.version,bodyHtml:editorHtml});
  assert.equal(updated.manual,true,'the public edited state remains intact');
  assert.equal(Object.hasOwn(updated,'manual_boundaries'),false,'boundary ownership stays private');
  await f.request(path+'/reading-session','POST',{active:true,index:0});await f.instance.sources.drain();
  const {sources:after}=await f.request(path+'/sources');
  assert.equal(bodyRanges(after[0].bodyHtml).sentences.at(-1).id,bodyRanges(after[1].bodyHtml).sentences[0].id,'one sentence must span both original pages');
  const ruby=htmlToBlocks(after[0].bodyHtml).flatMap(block=>block.segments).find(segment=>segment.text==='前文');
  assert.equal(ruby.reading,'まえぶん');assert.equal(ruby.origin,'manual');
  const reading=await f.request(path+'/reading-pages');
  assert.equal(reading.currentPage.ready,true);assert.equal(reading.complete,true);
  assert.equal(bodyText(reading.currentPage.bodyHtml),left+right);
  assert.ok(f.calls.some(call=>call.schema===SENTENCE_SCHEMA&&call.prompt.includes('みんなそうしているんです。終わり。')));
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

test('edit renewal never reacquires a released lease or changes a newer opening',async t=>{
  const f=await fixture(t);await f.configure();
  const text='日本語の原文。',id=(await f.importText(text)).firstDocumentId,documentPath=`/documents/${id}`;
  const [source]=(await f.request(`${documentPath}/sources`)).sources;
  const sourcePath=`${documentPath}/sources/${source.id}`,editPath=`${sourcePath}/edit`;
  const edit=(input,expected=200)=>f.request(editPath,'POST',input,expected);
  const release=sessionId=>f.request(editPath,'DELETE',{sessionId});
  const database=new DatabaseSync(join(f.dataDir,'yohaku.sqlite'));
  const lease=()=>database.prepare('SELECT edit_session,edit_expires FROM article_sources WHERE scope_id=?').get(source.scopeId);
  const setExpiry=expiry=>database.prepare('UPDATE article_sources SET edit_expires=? WHERE scope_id=?').run(expiry,source.scopeId);
  try{
    const first='first-editor-opening',second='second-editor-opening',third='third-editor-opening';
    assert.equal((await edit({sessionId:first})).editing,true,'legacy POST acquires the lease');
    await edit({renew:true},409);
    const nearExpiry=Date.now()+15_000;setExpiry(nearExpiry);
    await edit({sessionId:first,renew:true});
    assert.equal(lease().edit_session,first);
    assert.ok(lease().edit_expires>nearExpiry,'the live matching lease can renew');

    assert.equal((await release(first)).editing,false);
    await edit({sessionId:first,renew:true},409);
    assert.equal((await f.request(sourcePath)).editing,false);
    assert.equal(lease().edit_session,null);

    assert.equal((await edit({sessionId:second})).editing,true);
    const reopened=lease();assert.equal(reopened.edit_session,second);
    await edit({sessionId:first,renew:true},409);
    assert.equal((await release(first)).editing,true);
    assert.deepEqual(lease(),reopened,'stale renewal and release leave the new lease untouched');

    setExpiry(Date.now()-1);
    const expired=lease();
    await edit({sessionId:second,renew:true},409);
    assert.deepEqual(lease(),expired);
    assert.equal((await f.request(sourcePath)).editing,false);

    assert.equal((await edit({sessionId:third})).editing,true);
    await f.request(`${documentPath}/reading-session`,'POST',{index:0,active:true});
    await f.instance.sources.drain();
    const waiting=await f.request(`${documentPath}/reading-pages`);
    assert.equal(waiting.diagnostics.current.state,'editing');
    assert.equal(f.calls.length,0,'the edit lease holds pending correction');
    await release(third);
    await edit({sessionId:third,renew:true},409);
    await f.instance.sources.drain();
    const ready=await f.request(`${documentPath}/reading-pages`);
    assert.equal(ready.currentPage.ready,true);
    assert.equal(bodyText(ready.currentPage.bodyHtml),text);
    assert.equal(f.calls.filter(call=>call.model==='correction-model').length,1);
  }finally{database.close();}
});

test('keeping current source text rejects stale proposals and resumes the existing task without applying AI edits',async t=>{
  const original='日本語の原文です。\n削除してはいけない本文。',proposed='日本語の原文です。';
  let extractions=0;
  const f=await fixture(t,{correctionEdits:[{original:'\n削除してはいけない本文。',replacement:''}],ndlOcr:{async recognize(){
    extractions++;
    return {text:original,blocks:parseText(original.replace('日本語','{日本語|ニホンゴ}'))};
  },close(){}}});
  await f.configure();
  const bytes=await sharp({create:{width:30,height:50,channels:3,background:'white'}}).png().toBuffer(),form=new FormData();
  form.append('files',new Blob([bytes],{type:'image/png'}),'Screenshot.png');
  const draft=await f.request('/imports','POST',form,201);
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'screenshot',title:'核对截图'},201);
  const id=imported.firstDocumentId,documentPath=`/documents/${id}`;
  const [{id:sourceId}]=(await f.request(`${documentPath}/sources`)).sources;
  const path=`${documentPath}/sources/${sourceId}`,keepPath=`${path}/keep-current`;
  assert.equal((await f.request(path)).proposalToken,null);
  const session=await f.request(`${documentPath}/reading-session`,'POST',{index:0,active:true});
  await f.instance.sources.drain();
  const review=await f.request(path);
  assert.equal(review.status,'requires_review');assert.equal(bodyText(review.proposal.bodyHtml),proposed);
  assert.equal(typeof review.proposalToken,'string');assert.ok(review.proposalToken);
  assert.equal(review.text,original);assert.deepEqual(f.calls.map(call=>call.model),['correction-model']);
  assert.equal((await f.request(`/tasks/${session.taskId}`)).status,'requires_review');
  await f.request(keepPath,'POST',{version:review.version-1,proposalToken:review.proposalToken},409);
  const checked=await f.request(`${path}/checked`,'POST',{version:review.version,checked:true});
  assert.equal(checked.checked,true);assert.equal(checked.status,'requires_review');
  const database=new DatabaseSync(join(f.dataDir,'yohaku.sqlite'));
  try{
    const correction=()=>database.prepare("SELECT * FROM source_step_attempts WHERE scope_id=? AND step='correct'").all(review.scopeId);
    const journal=correction();assert.equal(journal.length,1);
    // Simulate a proposal replaced at the same source version while another tab was reviewing it.
    const replacement={...review.proposal,bodyHtml:blocksToHtml(parseText('別の提議。'))};
    database.prepare('UPDATE article_sources SET proposal_json=? WHERE scope_id=?').run(JSON.stringify(replacement),review.scopeId);
    const refreshed=await f.request(path);
    assert.equal(refreshed.version,review.version);assert.notEqual(refreshed.proposalToken,review.proposalToken);
    await f.request(keepPath,'POST',{version:review.version,proposalToken:review.proposalToken},409);

    const edit=await f.request(`${path}/edit`,'POST',{sessionId:'other-edit-session'});
    const decision={version:refreshed.version,proposalToken:refreshed.proposalToken};
    await f.request(keepPath,'POST',{...decision,sessionId:'review-session'},409);

    const document=await f.request(documentPath);
    f.instance.sources.persistDocumentMarks(f.user.id,id,markBodyRange(document.bodyHtml,0,3,'latest-review-qa'));
    const current=await f.request(path);
    assert.equal(current.version,decision.version);assert.equal(current.proposalToken,decision.proposalToken);
    assert.deepEqual(bodyRanges(current.bodyHtml).qa.map(mark=>mark.id),['latest-review-qa']);
    const kept=await f.request(keepPath,'POST',{...decision,sessionId:edit.sessionId});
    assert.equal(kept.version,review.version+1);assert.equal(kept.proposal,null);assert.equal(kept.proposalToken,null);
    assert.equal(kept.editing,false);assert.equal(kept.bodyHtml,current.bodyHtml);
    assert.equal(kept.checked,true);assert.equal(kept.checkedVersion,kept.version);
    await f.request(keepPath,'POST',{version:kept.version,proposalToken:decision.proposalToken},409);
    await f.instance.sources.drain();

    const ready=await f.request(path),reading=await f.request(`${documentPath}/reading-pages`);
    assert.equal(ready.status,'ready');assert.equal(ready.text,original);assert.equal(ready.checked,true);
    assert.deepEqual(ready.firstExtraction,review.firstExtraction);assert.deepEqual(ready.preview,review.preview);
    assert.deepEqual(bodyRanges(ready.bodyHtml).qa.map(mark=>mark.id),['latest-review-qa']);
    assert.ok(htmlToBlocks(ready.bodyHtml).flatMap(block=>block.segments).some(({text,reading,origin})=>text==='日本語'&&reading==='ニホンゴ'&&origin==='manual'));
    assert.equal(reading.currentPage.ready,true);assert.equal(bodyText(reading.currentPage.bodyHtml),original);
    assert.equal((await f.request(`/tasks/${session.taskId}`)).status,'completed');
    assert.equal(extractions,1);assert.deepEqual(correction(),journal);
    assert.deepEqual(f.calls.map(call=>call.model).sort(),['correction-model','ruby-model','sentence-model']);
    const raw=await fetch(f.url+ready.preview.url,{headers:{Cookie:(await ensureSession(f.url)).cookie},signal:AbortSignal.timeout(5000)});
    assert.equal(raw.status,200);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),bytes);
  }finally{database.close();}
});

test('keeping extracted text after a correction timeout uses the latest stopped attempt and continues the same task', {timeout:20000},async t=>{
  const original='日本語の原文です。\n本文を読みます。';
  const slots=Math.min(2,Math.max(1,Math.floor(Number(process.env.AI_HTTP_CONCURRENCY)||4)));
  let corrections=0,extractions=0,firstRetryEntered,releaseFirstRetry,timeoutEntered,releaseTimeout,held=0,slotsFilled,releaseSlots;
  const capacityFull=new Promise(resolve=>{slotsFilled=resolve;}),slotGate=new Promise(resolve=>{releaseSlots=resolve;});
  const firstRetryStarted=new Promise(resolve=>{firstRetryEntered=resolve;}),firstRetryGate=new Promise(resolve=>{releaseFirstRetry=resolve;});
  const timeoutStarted=new Promise(resolve=>{timeoutEntered=resolve;}),timeoutGate=new Promise(resolve=>{releaseTimeout=resolve;});
  t.after(()=>{releaseSlots();releaseFirstRetry();releaseTimeout();});
  const f=await fixture(t,{ndlOcr:{async recognize(){
    extractions++;
    return {text:original,blocks:parseText(original.replace('日本語','{日本語|ニホンゴ}'))};
  },close(){}},beforeRun:async input=>{
    if(input.model!=='correction-model')return;
    if(input.prompt.includes('校正枠を保持')){if(++held===slots)slotsFilled();await slotGate;return;}
    if(++corrections===1)throw Object.assign(new Error('controlled failure'),{status:502,expose:true});
    if(corrections===2){firstRetryEntered();await firstRetryGate;throw Object.assign(new Error('controlled backoff'),{status:429});}
    timeoutEntered();await timeoutGate;
    throw Object.assign(new Error('controlled timeout'),{status:504,expose:true,diagnostic:{code:'AI_TIMEOUT',category:'timeout'}});
  }});
  await f.configure();
  const bytes=await sharp({create:{width:30,height:50,channels:3,background:'white'}}).png().toBuffer(),form=new FormData();
  form.append('files',new Blob([bytes],{type:'image/png'}),'Screenshot.png');
  const draft=await f.request('/imports','POST',form,201);
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'screenshot',title:'校对超时'},201);
  const id=imported.firstDocumentId,documentPath=`/documents/${id}`;
  const [{id:sourceId}]=(await f.request(`${documentPath}/sources`)).sources;
  const path=`${documentPath}/sources/${sourceId}`,keepPath=`${path}/keep-current`;
  assert.equal((await f.request(path)).failedCorrection,null);
  const session=await f.request(`${documentPath}/reading-session`,'POST',{index:0,active:true}),taskPath=`/tasks/${session.taskId}`;
  await f.instance.sources.drain();
  const failed=await f.request(path);
  assert.equal(failed.failedCorrection.status,'failed');assert.equal(typeof failed.failedCorrection.attemptId,'string');
  const stale={version:failed.version,failedCorrectionAttemptId:failed.failedCorrection.attemptId};
  const task=await f.request(taskPath);
  assert.equal(task.status,'failed');
  const waitForCorrectionState=async status=>{
    let step;
    for(let i=0;i<50;i++){
      step=(await f.request(taskPath)).steps.find(node=>node.step==='correct');
      if(step.status===status)break;
      await delay(15);
    }
    assert.equal(step.status,status);
  };
  // Occupy the article's real provider slots so the new attempt remains queued.
  const blockers=Promise.allSettled(Array.from({length:slots},()=>f.instance.ai.processSource(f.user.id,{
    step:'correct',source:{type:'text'},bodyHtml:'<p>校正枠を保持。</p>',groupKey:JSON.stringify([f.user.id,id]),
  })));
  await capacityFull;
  const scheduled=await f.request(`${taskPath}/retry`,'POST',{version:task.version});
  assert.equal(scheduled.status,'queued');
  await waitForCorrectionState('queued');
  assert.equal((await f.request(path)).failedCorrection,null);
  await f.request(keepPath,'POST',stale,409);
  releaseSlots();assert.ok((await blockers).every(result=>result.status==='fulfilled'));
  await firstRetryStarted;
  assert.equal((await f.request(path)).failedCorrection,null);
  await f.request(keepPath,'POST',stale,409);
  releaseFirstRetry();
  await waitForCorrectionState('retry_wait');
  assert.equal((await f.request(path)).failedCorrection,null);
  await f.request(keepPath,'POST',stale,409);
  await timeoutStarted;releaseTimeout();await f.instance.sources.drain();

  const timedOut=await f.request(path);
  assert.equal(timedOut.version,failed.version);assert.equal(timedOut.failedCorrection.status,'timeout');
  assert.notEqual(timedOut.failedCorrection.attemptId,failed.failedCorrection.attemptId);
  assert.equal((await f.request(taskPath)).status,'timeout');
  await f.request(keepPath,'POST',stale,409);
  await f.request(`${path}/checked`,'POST',{version:timedOut.version,checked:true});
  const article=await f.request(documentPath);
  f.instance.sources.persistDocumentMarks(f.user.id,id,markBodyRange(article.bodyHtml,0,3,'timeout-qa'));
  const marked=await f.request(path),database=new DatabaseSync(join(f.dataDir,'yohaku.sqlite'),{readOnly:true});
  try{
    const correction=()=>database.prepare("SELECT * FROM source_step_attempts WHERE scope_id=? AND step='correct' ORDER BY rowid").all(timedOut.scopeId);
    const journal=correction();assert.equal(journal.length,2);
    const keep={version:timedOut.version,failedCorrectionAttemptId:timedOut.failedCorrection.attemptId,sessionId:session.sessionId};
    const kept=await f.request(keepPath,'POST',keep);
    assert.equal(kept.version,timedOut.version+1);assert.equal(kept.failedCorrection,null);assert.equal(kept.checked,true);
    assert.equal(kept.bodyHtml,marked.bodyHtml);assert.deepEqual(kept.firstExtraction,failed.firstExtraction);
    await f.request(keepPath,'POST',{...keep,version:kept.version},409);
    await f.instance.sources.drain();

    const ready=await f.request(path),reading=await f.request(`${documentPath}/reading-pages`),finished=await f.request(taskPath);
    assert.equal(ready.status,'ready');assert.equal(ready.text,original);assert.equal(ready.checked,true);
    assert.deepEqual(bodyRanges(ready.bodyHtml).qa.map(mark=>mark.id),['timeout-qa']);
    assert.ok(htmlToBlocks(ready.bodyHtml).flatMap(block=>block.segments).some(({text,reading,origin})=>text==='日本語'&&reading==='ニホンゴ'&&origin==='manual'));
    assert.equal(reading.currentPage.ready,true);assert.equal(bodyText(reading.currentPage.bodyHtml),original);
    assert.equal(finished.status,'completed');assert.equal(finished.archived,true);assert.equal(finished.generation,task.generation);
    assert.equal(finished.steps.find(step=>step.step==='correct').message,'已选择使用当前正文，跳过 AI 校对。');
    assert.equal(extractions,1);assert.equal(corrections,3);assert.deepEqual(correction(),journal);
    assert.deepEqual(f.calls.filter(call=>!call.prompt.includes('校正枠を保持')).map(call=>call.model).sort(),['ruby-model','sentence-model']);
  }finally{database.close();}
});

test('keep-current is unavailable after extraction or segmentation failures',async t=>{
  const failure=()=>Object.assign(new Error('controlled step failure'),{status:502,expose:true});
  const f=await fixture(t,{ndlOcr:{async recognize(){throw failure();},close(){}},beforeRun:input=>{
    if(input.model==='sentence-model')throw failure();
  }});
  await f.configure();
  const bytes=await sharp({create:{width:30,height:50,channels:3,background:'white'}}).png().toBuffer(),form=new FormData();
  form.append('files',new Blob([bytes],{type:'image/png'}),'Screenshot.png');
  const draft=await f.request('/imports','POST',form,201);
  const image=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'screenshot',title:'提取失败'},201);
  const text=await f.importText('日本語の原文。');
  for(const [id,step] of [[image.firstDocumentId,'extract'],[text.firstDocumentId,'segment']]){
    const session=await f.request(`/documents/${id}/reading-session`,'POST',{index:0,active:true});
    await f.instance.sources.drain();
    const task=await f.request(`/tasks/${session.taskId}`),failed=task.steps.find(node=>node.step===step);
    assert.equal(failed.status,'failed');
    const path=`/documents/${id}/sources/${failed.sourceId}`,source=await f.request(path);
    assert.equal(source.failedCorrection,null);
    await f.request(`${path}/keep-current`,'POST',{version:source.version,failedCorrectionAttemptId:failed.children[0].id},409);
  }
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
