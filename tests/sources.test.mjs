import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSourceService } from '../server/sources.mjs';
import { createSourceProcessor } from '../server/ai/source-processing.mjs';
import { blocksToHtml, bodyText, bodyRanges, htmlToBlocks, applySentenceBoundaries, markBodyRange, removeQaMarks } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';
const html=text=>blocksToHtml(parseText(text));
function fixture(ai={}) {
  const database=new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);`);
  const add=(id,text='歴史。')=>database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)').run(id,'u',id,'article','horizontal',JSON.stringify(parseText(text)),text,html(text),'hash',new Date().toISOString(),new Date().toISOString(),'[]',null,null);
  add('a');add('b');
  let clock=1000;
  const makeService=()=>createSourceService({database,ai,now:()=>clock,requireDocument:(u,id)=>{const row=database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id,u);if(!row)throw Object.assign(new Error('missing'),{status:404});return row;},fromRow:row=>({id:row.id,bodyHtml:row.body_html,blocks:JSON.parse(row.blocks_json),revision:row.revision})});
  let service=makeService();
  return {database,get service(){return service;},restart:()=>{service.close();service=makeService();},advance:n=>clock+=n,close:()=>{service.close();database.close();}};
}
const ready=text=>({type:'text',text,needsCorrection:false,status:'ready',bodyHtml:applySentenceBoundaries(html(text),text.match(/[^。]*。|[^。]+$/g)||[text])});

test('reading diagnostics distinguish queued and running work and retain a safe failure after retry and restart',async()=>{
  let release,update,failOnce=true;
  const execution={operationId:'operation-1',role:'correction',providerId:'api_base',model:'test-model',configurationVersion:3};
  const f=fixture({processSource:async(_u,request)=>{
    if(request.step==='correct'&&failOnce){
      update=request.onStatus;update?.({...execution,state:'queued',queuedAt:new Date(1000).toISOString()});
      return new Promise((resolve,reject)=>release=()=>reject(Object.assign(new Error('服务暂时不可用，请重试。'),{expose:true,diagnostic:{code:'AI_UPSTREAM_HTTP',category:'upstream_http',httpStatus:503,errorType:'AI_APICallError'},execution:{...execution,startedAt:new Date(4000).toISOString(),elapsedMs:2000,queueMs:3000}})));
    }
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'pdf27',type:'scan_pdf',text:'日本語。',original:{page:27}}]);
    f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    let current=f.service.readingPages('u','a',0).diagnostics?.current;
    assert.equal(current?.state,'queued');assert.equal(current.source.label,'PDF 第27页');assert.equal(current.step,'correct');assert.equal(current.model,'test-model');
    f.advance(3000);update?.({...execution,state:'running',queuedAt:new Date(1000).toISOString(),startedAt:new Date(4000).toISOString(),queueMs:3000});f.advance(2000);
    current=f.service.readingPages('u','a',0).diagnostics.current;assert.equal(current.state,'running');assert.equal(current.elapsedMs,2000);
    release();await f.service.drain();
    const failed=f.service.readingPages('u','a',0).diagnostics;assert.equal(failed.current.state,'failed');assert.equal(failed.current.error.diagnostic.httpStatus,503);assert.equal(failed.recentFailures[0].execution.operationId,'operation-1');assert.equal(failed.recentFailures[0].step,'correct');
    f.advance(90000);assert.equal(f.service.readingPages('u','a',0).diagnostics.current.elapsedMs,2000);
    f.restart();assert.equal(f.service.readingPages('u','a',0).diagnostics.recentFailures[0].diagnostic.httpStatus,503);
    failOnce=false;f.service.heartbeat('u','a',{index:0,retry:true});await f.service.drain();
    const recovered=f.service.readingPages('u','a',0);assert.equal(recovered.currentPage.ready,true);assert.equal(recovered.diagnostics.current,null);assert.equal(recovered.diagnostics.recentFailures.length,1);
  }finally{f.close();}
});

test('reading diagnostics and top-level error ignore failed prefetch outside the current unfinished page',async()=>{
  let release;const text=('あ'.repeat(99)+'。').repeat(10);
  const f=fixture({processSource:async(_u,request)=>request.step==='annotate'?new Promise(resolve=>release=()=>resolve({bodyHtml:request.bodyHtml})):{bodyHtml:request.bodyHtml}});try{
    f.service.createArticleSources('u','a',[{id:'current',...ready(text),status:'pending',needsCorrection:false},{id:'future',...ready(text)}]);
    const row=f.database.prepare('SELECT scope_id FROM article_sources WHERE source_id=?').get('current');
    f.database.prepare('UPDATE article_sources SET next_step=3 WHERE scope_id=?').run(row.scope_id);
    f.database.prepare("UPDATE article_sources SET status='failed',next_step=1,error='future failed' WHERE source_id='future'").run();
    f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    const snapshot=f.service.readingPages('u','a',0);assert.equal(snapshot.error,undefined);assert.equal(snapshot.diagnostics?.current.source.id,'current');assert.equal(snapshot.diagnostics.current.state,'running');
    release();await f.service.drain();assert.equal(f.service.readingPages('u','a',0).diagnostics.current,null);
  }finally{f.close();}
});

test('restarting a running diagnostic attempt resumes pending instead of reporting a ghost runner',async()=>{
  const f=fixture({processSource:async()=>new Promise(()=>{})});try{
    f.service.createArticleSources('u','a',[{id:'source',type:'text',text:'本文。'}]);f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.service.readingPages('u','a',0).diagnostics?.current.state,'running');
    f.restart();assert.equal(f.service.readingPages('u','a',0).diagnostics.current.state,'pending');
  }finally{f.close();}
});

test('a partially invalid local annotation batch reports the failure for its blocked source',async()=>{
  const f=fixture({prepareAnnotationBodies:async items=>({items:items.map((item,index)=>index?{...item,bodyHtml:html('別の正文。')}:item)}),proofreadAnnotationBodies:async()=>{throw new Error('must not proofread');}});try{
    f.service.createArticleSources('u','a',[{id:'first',...ready('一。'),status:'pending'},{id:'second',...ready('二。'),status:'pending'}]);
    f.database.prepare('UPDATE article_sources SET next_step=3').run();
    f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const reading=f.service.readingPages('u','a',0);assert.equal(reading.diagnostics.current.state,'failed');assert.match(reading.diagnostics.current.step,/^annotate_local:/);assert.ok(reading.diagnostics.recentFailures.some(item=>item.source.id==='first'));assert.match(reading.error,/本地注音/);
  }finally{f.close();}
});

test('stale provider status and errors cannot replace diagnostics after a manual source version change',async()=>{
  let reject,update;const f=fixture({processSource:async(_u,request)=>{update=request.onStatus;update({state:'running',operationId:'old-operation',startedAt:new Date(1000).toISOString()});return new Promise((_resolve,fail)=>reject=fail);}});try{
    f.service.createArticleSources('u','a',[{id:'source',type:'text',text:'元の正文。'}]);f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    const source=f.service.getSource('u','a','source');f.service.beginEdit('u','a','source',{});f.service.stop();f.service.saveSource('u','a','source',{version:source.version,text:'人工正文。'});
    update({state:'queued',operationId:'late-operation',queuedAt:new Date(1000).toISOString()});reject(new Error('late failure'));await f.service.drain();
    const current=f.service.readingPages('u','a',0).diagnostics;assert.equal(current.current.state,'editing');assert.equal(current.current.operationId,undefined);assert.equal(current.recentFailures.length,0);assert.equal(f.service.getSource('u','a','source').text,'人工正文。');
  }finally{f.close();}
});

test('legacy failures have an unknown diagnostic without invented timings or provider details',()=>{
  const f=fixture();try{
    f.service.createArticleSources('u','a',[{id:'legacy',type:'text',text:'原文。'}]);f.database.prepare("UPDATE article_sources SET status='failed',error='历史处理失败' WHERE source_id='legacy'").run();
    const current=f.service.readingPages('u','a',0).diagnostics.current;assert.equal(current.state,'failed');assert.equal(current.error.message,'历史处理失败');assert.equal(current.error.diagnostic.code,'AI_UNKNOWN_ERROR');assert.equal(current.startedAt,undefined);assert.equal(current.providerId,undefined);assert.equal(current.error.diagnostic.httpStatus,undefined);
  }finally{f.close();}
});

test('unpublished PDF page diagnostics locate the running lookahead correction that blocks segmentation',async()=>{
  let release;const f=fixture({processSource:async(_u,request)=>{
    if(request.source.id==='second'&&request.step==='correct'){request.onStatus({state:'queued',role:'correction',queuedAt:new Date(1000).toISOString()});return new Promise(resolve=>release=()=>resolve({bodyHtml:request.bodyHtml}));}
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'first',type:'scan_pdf',text:'一。',original:{page:27}},{id:'second',type:'scan_pdf',text:'二。',original:{page:28}}]);f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<10&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    const reading=f.service.readingPages('u','a',0);assert.equal(reading.currentPage,null);assert.equal(reading.diagnostics.current.source.page,28);assert.equal(reading.diagnostics.current.step,'correct');assert.equal(reading.diagnostics.current.state,'queued');
    f.service.stop();release();await f.service.drain();
  }finally{f.close();}
});

test('failed PDF lookahead is the unpublished page blocker while an existing page keeps its own segmentation scope',()=>{
  const f=fixture();try{
    f.service.createArticleSources('u','a',[{id:'first',type:'scan_pdf',text:'前の正文。',needsCorrection:false,original:{page:27}},{id:'second',type:'scan_pdf',text:'次の正文。',original:{page:28}}]);
    f.database.prepare("UPDATE article_sources SET status='failed',error='下一来源校正失败' WHERE source_id='second'").run();
    let reading=f.service.readingPages('u','a',0);assert.equal(reading.currentPage,null);assert.equal(reading.diagnostics.current.source.page,28);assert.equal(reading.diagnostics.current.state,'failed');assert.equal(reading.diagnostics.current.step,'correct');assert.equal(reading.error,'下一来源校正失败');
    const text=('あ'.repeat(99)+'。').repeat(10);f.service.createArticleSources('u','b',[{id:'published',...ready(text)},{id:'future-pdf',type:'scan_pdf',text:'次の正文。'}]);
    f.database.prepare("UPDATE article_sources SET status='pending',next_step=2 WHERE source_id='published'").run();f.database.prepare("UPDATE article_sources SET status='failed',error='未来来源失败' WHERE source_id='future-pdf'").run();
    reading=f.service.readingPages('u','b',0);assert.ok(reading.currentPage);assert.equal(reading.currentPage.ready,false);assert.equal(reading.diagnostics.current.source.id,'published');assert.equal(reading.diagnostics.current.step,'segment');assert.equal(reading.error,undefined);
  }finally{f.close();}
});

test('a failed or review-blocked PDF segmentation remains current ahead of pending lookahead correction',()=>{
  for(const status of ['failed','requires_review']){
    const f=fixture();try{
      f.service.createArticleSources('u','a',[{id:'first',type:'scan_pdf',text:'前の正文。',needsCorrection:false,original:{page:27}},{id:'second',type:'scan_pdf',text:'次の正文。',original:{page:28}}]);
      f.database.prepare('UPDATE article_sources SET status=?,error=? WHERE source_id=?').run(status,'当前来源分句受阻','first');
      const reading=f.service.readingPages('u','a',0);assert.equal(reading.currentPage,null);assert.equal(reading.diagnostics.current.source.id,'first');assert.equal(reading.diagnostics.current.state,status);assert.equal(reading.diagnostics.current.step,'segment');assert.equal(reading.error,'当前来源分句受阻');
    }finally{f.close();}
  }
});

test('page batch diagnostics distinguish local work and broadcast provider queue status to its sources',async()=>{
  let finishLocal,finishReview;const f=fixture({
    prepareAnnotationBodies:items=>new Promise(resolve=>finishLocal=()=>resolve({items})),
    proofreadAnnotationBodies:async(_u,request)=>{request.onStatus({state:'queued',operationId:'batch-operation',role:'annotation',providerId:'api_base',model:'deepseek',queuedAt:new Date(1000).toISOString()});return new Promise((_resolve,reject)=>finishReview=()=>reject(Object.assign(new Error('raw SDK includes a secret-token and https://secret.example'),{diagnostic:{code:'AI_NETWORK_ERROR',category:'network',networkCode:'ECONNRESET',body:'secret-token'},execution:{operationId:'batch-operation',role:'annotation',providerId:'api_base',model:'deepseek',request:'secret-token'}})));}
  });try{
    f.service.createArticleSources('u','a',[{id:'one',...ready('日本語。'),status:'pending'},{id:'two',...ready('正文。'),status:'pending'}]);f.database.prepare('UPDATE article_sources SET next_step=3').run();f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    const local=f.service.readingPages('u','a',0).diagnostics.current;assert.equal(local.state,'running');assert.match(local.step,/^annotate_local:/);assert.equal(local.role,undefined);
    finishLocal();await new Promise(resolve=>setImmediate(resolve));const queued=f.service.readingPages('u','a',0).diagnostics.current;assert.equal(queued.state,'queued');assert.match(queued.step,/^annotate:/);assert.equal(queued.model,'deepseek');
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM source_step_attempts WHERE state='queued'").get().count,2);
    finishReview();await f.service.drain();const failed=f.service.readingPages('u','a',0).diagnostics;assert.equal(failed.recentFailures.length,2);assert.ok(failed.recentFailures.every(item=>item.execution.operationId==='batch-operation'&&item.diagnostic.networkCode==='ECONNRESET'));assert.doesNotMatch(JSON.stringify(failed),/secret-token|secret\.example|raw SDK/);
    const persisted=f.database.prepare('SELECT execution_json,diagnostic_json,message FROM source_step_attempts').all();assert.doesNotMatch(JSON.stringify(persisted),/secret-token|secret\.example|raw SDK/);
  }finally{f.close();}
});

test('failure history is bounded to five article-scoped attempts and document deletion clears its journal',async()=>{
  const f=fixture({processSource:async()=>{throw Object.assign(new Error('failure'),{diagnostic:{code:'AI_TIMEOUT',category:'timeout'}});}});try{
    f.service.createArticleSources('u','a',[{id:'a-source',type:'text',text:'一。'}]);f.service.createArticleSources('u','b',[{id:'b-source',type:'text',text:'二。'}]);
    for(let i=0;i<7;i++){f.advance(1);f.service.heartbeat('u','a',{retry:true,index:0});await f.service.drain();}
    f.service.heartbeat('u','b',{index:0});await f.service.drain();
    const history=f.service.readingPages('u','a',0).diagnostics.recentFailures;assert.equal(history.length,5);assert.ok(history.every(item=>item.source.id==='a-source'));assert.ok(history[0].at>=history[4].at);
    f.service.deleteDocument('u','a');assert.equal(f.database.prepare('SELECT COUNT(*) AS count FROM source_step_attempts').get().count,1);assert.equal(f.service.readingPages('u','b',0).diagnostics.recentFailures[0].source.id,'b-source');
  }finally{f.close();}
});

test('original and first extraction remain immutable through manual saves and checked status is independent',()=>{
  const f=fixture();try {
    f.service.createArticleSources('u','a',[ready('一。二。')]);
    const source=f.service.listSources('u','a')[0];
    f.service.markChecked('u','a',source.id,{version:source.version,checked:true});
    assert.equal(f.service.getSource('u','a',source.id).checked,true);
    const next=f.service.saveSource('u','a',source.id,{version:source.version,text:'一。漏れた文。二。'});
    assert.equal(next.checked,false);assert.equal(next.firstExtraction.text,'一。二。');
    assert.equal(next.original.text,'一。二。');assert.equal(next.text,'一。漏れた文。二。');
    assert.equal(next.status,'pending');
  } finally {f.close();}
});

test('saving one source ignores background progress of another and rejects its own stale version',()=>{
  const f=fixture();try {
    f.service.createArticleSources('u','a',[ready('一。'),ready('二。')]);
    const [a,b]=f.service.listSources('u','a');
    f.service.saveSource('u','a',b.id,{version:b.version,text:'二番。'});
    assert.equal(f.service.saveSource('u','a',a.id,{version:a.version,text:'一番。'}).text,'一番。');
    assert.throws(()=>f.service.saveSource('u','a',a.id,{version:a.version,text:'古い。'}),{status:409});
  } finally {f.close();}
});

test('shared original across articles has independent editable scopes',()=>{
  const f=fixture();try {
    f.service.createArticleSources('u','a',[{...ready('前半。'),id:'shared',original:{text:'前半。後半。'}}]);
    f.service.createArticleSources('u','b',[{...ready('後半。'),id:'shared'}]);
    const source=f.service.getSource('u','a','shared');
    f.service.saveSource('u','a','shared',{version:source.version,text:'前の章。'});
    assert.equal(f.service.getSource('u','b','shared').text,'後半。');
    assert.equal(f.service.getSource('u','a','shared').original.text,'前半。後半。');
  } finally {f.close();}
});

test('one source spans multiple reading pages and editing expands only affected published page',()=>{
  const f=fixture();try {
    const text=('あ'.repeat(99)+'。').repeat(25);
    f.service.createArticleSources('u','a',[ready(text)]);
    const source=f.service.listSources('u','a')[0],before=f.service.readingPages('u','a',0);
    assert.equal(before.pages.length,3);assert.equal(before.totalPages,3);
    assert.equal(before.pages.map(page=>bodyText(page.bodyHtml)).join(''),text);
    f.service.saveSource('u','a',source.id,{version:source.version,text:text.slice(0,500)+'追加。'+text.slice(500)});
    const after=f.service.readingPages('u','a',0);
    assert.deepEqual(after.pages.map(p=>p.id),before.pages.map(p=>p.id));
    assert.equal(bodyText(after.pages[0].bodyHtml).length,1003);
    assert.equal(bodyText(after.pages[1].bodyHtml),bodyText(before.pages[1].bodyHtml));
  } finally {f.close();}
});

test('page can reference multiple sources and source previews do not run AI',async()=>{
  let calls=0;const f=fixture({processSource:async()=>{calls++;return {};}});try {
    f.service.createArticleSources('u','a',[ready(('あ'.repeat(99)+'。').repeat(6)),ready(('い'.repeat(99)+'。').repeat(6))]);
    const page=f.service.readingPages('u','a',0).currentPage;
    assert.equal(page.sourceIds.length,2);assert.equal(bodyText(page.bodyHtml).length,1000);
    f.service.listSources('u','a');f.service.getSource('u','a',page.sourceIds[0]);
    await new Promise(resolve=>setImmediate(resolve));assert.equal(calls,0);
  }finally{f.close();}
});

test('legacy text adoption is a labelled historical body snapshot and never re-recognizes',()=>{
  const f=fixture();try {
    f.service.adoptDocument('u','a');
    const source=f.service.listSources('u','a')[0];
    assert.equal(source.original.label,'历史正文快照');assert.equal(source.firstExtraction.label,'历史正文快照');
    assert.equal(source.status,'ready');
  }finally{f.close();}
});

test('leaving preserves manual input against late extraction and completes only its missing steps',async()=>{
  let release;const calls=[];
  const f=fixture({processSource:async(_u,request)=>{calls.push(request.step);if(request.step==='extract')return await new Promise(resolve=>release=resolve);return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};}});try {
    f.service.createArticleSources('u','a',[{type:'scan_pdf',original:{page:1},preview:{kind:'pdf',page:1}}]);
    const source=f.service.listSources('u','a')[0];
    const session=f.service.heartbeat('u','a',{active:true,index:0});
    await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(calls,['extract']);
    f.service.beginEdit('u','a',source.id,{sessionId:session.sessionId});
    f.service.saveSource('u','a',source.id,{version:source.version,text:'手入力。'});
    f.service.heartbeat('u','a',{sessionId:session.sessionId,active:false,index:0});
    release({bodyHtml:html('遅い結果。')});await f.service.drain();
    assert.equal(f.service.getSource('u','a',source.id).text,'手入力。');
    assert.deepEqual(calls,['extract','segment','annotate']);
  }finally{f.close();}
});

test('failed background work pauses until explicit retry resumes stored successful extraction',async()=>{
  const calls=[];
  const f=fixture({processSource:async(_u,request)=>{calls.push(request.step);if(request.step==='extract')return {bodyHtml:html('原文。')};if(request.step==='correct')throw new Error('offline');return {bodyHtml:request.bodyHtml};}});try {
    f.service.createArticleSources('u','a',[{type:'scan_pdf'}]);const source=f.service.listSources('u','a')[0];
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    assert.deepEqual(calls,['extract','correct']);assert.equal(f.service.getSource('u','a',source.id).status,'failed');
    f.service.getSource('u','a',source.id);await f.service.drain();assert.equal(calls.length,2);
    f.service.prepareSource('u','a',source.id,{retry:true});await f.service.drain();
    assert.deepEqual(calls,['extract','correct','correct']);
  }finally{f.close();}
});

test('prepending, boundary insertion, appending and deleting all text preserve published coverage',()=>{
  const f=fixture();try {
    let text=('あ'.repeat(99)+'。').repeat(25);
    f.service.createArticleSources('u','a',[ready(text)]);
    let source=f.service.listSources('u','a')[0];const initial=f.service.readingPages('u','a',0);
    for(const transform of [value=>'前文。'+value,value=>value.slice(0,1003)+'境界。'+value.slice(1003),value=>value+'後文。',()=> '']) {
      text=transform(text);source=f.service.saveSource('u','a',source.id,{version:source.version,text});
      const pages=f.service.readingPages('u','a',0).pages;
      assert.deepEqual(pages.map(p=>p.id),initial.pages.map(p=>p.id));
      assert.equal(pages.map(p=>bodyText(p.bodyHtml)).join(''),text);
    }
  }finally{f.close();}
});

test('stop prevents subsequent steps while allowing active extraction to persist',async()=>{
  let release;const calls=[];
  const f=fixture({processSource:async(_u,request)=>{calls.push(request.step);return new Promise(resolve=>release=resolve);}});try {
    f.service.createArticleSources('u','a',[{type:'scan_pdf'}]);const source=f.service.listSources('u','a')[0];
    f.service.heartbeat('u','a',{active:true,index:0});await new Promise(resolve=>setImmediate(resolve));
    f.service.stop();release({bodyHtml:html('保存。')});await f.service.drain();
    assert.equal(f.service.getSource('u','a',source.id).text,'保存。');assert.deepEqual(calls,['extract']);
  }finally{f.close();}
});

test('public source metadata excludes local filesystem paths, processor receives private metadata',async()=>{
  let received;const f=fixture({processSource:async(_u,request)=>{received=request.source.original.filePath;throw new Error('stop');}});try{
    f.service.createArticleSources('u','a',[{type:'scan_pdf',original:{filePath:'/private/path.pdf',name:'book.pdf'}}]);
    const source=f.service.listSources('u','a')[0];assert.equal(source.original.filePath,undefined);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();assert.equal(received,'/private/path.pdf');
  }finally{f.close();}
});

test('segmentation spans PDF pages and shares the sentence identity without duplicating context',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({step:request.step,text:bodyText(request.bodyHtml)});
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{type:'text_pdf',text:'これはページをまたぐ',needsCorrection:false},{type:'text_pdf',text:'一つの文です。',needsCorrection:false}]);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    assert.deepEqual(calls.filter(c=>c.step==='segment').map(c=>c.text),['これはページをまたぐ一つの文です。']);
    const page=f.service.readingPages('u','a',0).currentPage;
    assert.equal(bodyText(page.bodyHtml),'これはページをまたぐ一つの文です。');
    assert.equal((await import('../shared/article-html.mjs')).bodyRanges(page.bodyHtml).sentences.length,1);
  }finally{f.close();}
});

test('shared source extraction is reused and each article receives only its local range',async()=>{
  let extractions=0;
  const f=fixture({processSource:async(_u,request)=>{
    if(request.step==='extract'){extractions++;return {bodyHtml:html('前半。後半。')};}
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try {
    f.service.createArticleSources('u','a',[{id:'physical',type:'scan_pdf',localRange:{start:0,end:3}}]);
    f.service.createArticleSources('u','b',[{id:'physical',type:'scan_pdf',localRange:{start:3}}]);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    f.service.heartbeat('u','b',{active:true,index:0});await f.service.drain();
    assert.equal(extractions,1);
    assert.equal(f.service.getSource('u','a','physical').text,'前半。');
    assert.equal(f.service.getSource('u','b','physical').text,'後半。');
    assert.equal(f.service.getSource('u','b','physical').firstExtraction.text,'前半。後半。');
  }finally{f.close();}
});

test('deleting an article while extraction runs discards the result without an unhandled rejection',async()=>{
  let release;const f=fixture({processSource:async()=>new Promise(resolve=>release=resolve)});try{
    f.service.createArticleSources('u','a',[{type:'photo'}]);
    f.service.heartbeat('u','a',{active:true,index:0});await new Promise(resolve=>setImmediate(resolve));
    f.service.deleteDocument('u','a');f.database.prepare('DELETE FROM documents WHERE id=?').run('a');
    release({bodyHtml:html('遅延。')});await f.service.drain();
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM source_fragments').get().n,0);
  }finally{f.close();}
});

test('large source annotates current reading page and only two successors, then resumes next page',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({step:request.step,text:bodyText(request.bodyHtml),priority:request.priority});
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))};
    return {bodyHtml:request.bodyHtml};
  }});try{
    const text=('あ'.repeat(99)+'。').repeat(80);
    f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false}]);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    let snapshot=f.service.readingPages('u','a',0);
    assert.equal(snapshot.pages.length,8);assert.equal(snapshot.currentPage.ready,true);assert.equal(snapshot.pages[3].ready,false);
    assert.equal(snapshot.totalPages,undefined);
    assert.deepEqual(calls.filter(c=>c.step==='annotate').map(c=>c.text.length),[1000,1000,1000]);
    f.service.heartbeat('u','a',{active:true,index:1});await f.service.drain();
    snapshot=f.service.readingPages('u','a',1);assert.equal(snapshot.pages[3].ready,true);assert.equal(snapshot.pages[4].ready,false);
    assert.equal(calls.filter(c=>c.step==='annotate').length,4);
  }finally{f.close();}
});

test('editing one published page retains readiness of other annotated pages',async()=>{
  const f=fixture({processSource:async(_u,request)=>request.step==='segment'?{bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])}:{bodyHtml:request.bodyHtml}});try{
    const text=('あ'.repeat(99)+'。').repeat(25);f.service.createArticleSources('u','a',[ready(text)]);
    const source=f.service.listSources('u','a')[0];f.service.readingPages('u','a',0);
    f.service.saveSource('u','a',source.id,{version:source.version,text:text.slice(0,500)+'補足。'+text.slice(500)});
    const pages=f.service.readingPages('u','a',0).pages;
    assert.equal(pages[0].ready,false);assert.equal(pages[1].ready,true);assert.equal(pages[2].ready,true);
  }finally{f.close();}
});

test('opening one PDF correction source never starts the following source',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({id:request.source.id,step:request.step});
    if(request.step==='extract')return {bodyHtml:html('途中の文')};
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'first',type:'scan_pdf'},{id:'second',type:'scan_pdf'}]);
    f.service.prepareSource('u','a','first');await f.service.drain();
    assert.equal(calls.length,4);assert.equal(calls.every(call=>call.id==='first'),true);
    assert.equal(f.service.getSource('u','a','second').firstExtraction,null);
  }finally{f.close();}
});

test('frozen extraction result remains traceable and is reused after cancelling the edit',async()=>{
  let release;let calls=0;
  const f=fixture({processSource:async(_u,request)=>{
    if(request.step==='extract'){calls++;return await new Promise(resolve=>release=resolve);}
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'first',type:'scan_pdf'}]);
    const session=f.service.prepareSource('u','a','first');await new Promise(resolve=>setImmediate(resolve));
    f.service.beginEdit('u','a','first',{sessionId:session.sessionId});
    release({bodyHtml:html('完了した OCR。')});await f.service.drain();
    const frozen=f.service.getSource('u','a','first');assert.equal(frozen.text,'');assert.equal(frozen.firstExtraction.text,'完了した OCR。');
    f.service.endEdit('u','a','first',{sessionId:session.sessionId});await f.service.drain();
    assert.equal(calls,1);assert.equal(f.service.getSource('u','a','first').text,'完了した OCR。');
  }finally{f.close();}
});

test('requesting an unpublished reading page keeps its index and starts that page ahead of prefetch',async()=>{
  const f=fixture({processSource:async(_u,request)=>request.step==='segment'?{bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}:{bodyHtml:request.bodyHtml}});try{
    const text=('あ'.repeat(99)+'。').repeat(10);
    f.service.createArticleSources('u','a',[{...ready(text)},{...ready(text)},{...ready(text)},{type:'text',text,needsCorrection:false}]);
    const pending=f.service.readingPages('u','a',3);
    assert.equal(pending.index,3);assert.equal(pending.currentPage,null);
    f.service.heartbeat('u','a',{active:true,index:3});await f.service.drain();
    const prepared=f.service.readingPages('u','a',3);assert.equal(prepared.currentPage.index,3);assert.equal(prepared.currentPage.ready,true);
  }finally{f.close();}
});

test('legacy image adoption preserves unassigned body and paragraph boundaries without OCR',()=>{
  const f=fixture();try{
    const original='<p data-paragraph-id="p">補足。<span data-source-image-id="img-a">一。</span>間の文字。<span data-source-image-id="img-b">二。</span></p><p data-paragraph-id="q">末尾。</p>';
    f.database.prepare('UPDATE documents SET body_html=?,plain_text=?,source_images_json=? WHERE id=?').run(original,bodyText(original),JSON.stringify([{id:'img-a'},{id:'img-b'}]),'a');
    const adopted=f.service.adoptDocument('u','a');
    assert.equal(bodyText(adopted.bodyHtml),bodyText(original));
    assert.deepEqual(adopted.sources.filter(source=>source.type==='photo').map(source=>source.id),['img-a','img-b']);
    assert.equal(adopted.reading.currentPage.ready,true);
  }finally{f.close();}
});

test('paragraph separators survive page composition and remain included in question offsets',async()=>{
  const f=fixture({processSource:async(_u,request)=>request.step==='segment'?{bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}:{bodyHtml:request.bodyHtml}});try{
    const text=Array.from({length:50},(_,i)=>'あ'.repeat(95)+i+'。').join('\n');
    f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false}]);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    const reading=f.service.readingPages('u','a',0);
    assert.equal(reading.pages.map(page=>bodyText(page.bodyHtml)).join(''),text);
    for(const page of reading.pages)assert.equal(bodyText(page.bodyHtml),text.slice(page.start,page.end));
  }finally{f.close();}
});

test('an expired heartbeat keeps the requested page running through all remaining steps',async()=>{
  let release;const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push(request.step);
    if(request.step==='extract')return new Promise(resolve=>release=resolve);
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{type:'scan_pdf'}]);f.service.heartbeat('u','a',{active:true,index:0});await new Promise(resolve=>setImmediate(resolve));
    f.advance(45001);release({bodyHtml:html('途中まで保存。')});await f.service.drain();
    assert.deepEqual(calls,['extract','correct','segment','annotate']);assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
  }finally{f.close();}
});

test('page annotation sees known neighboring source context without writing it into text',async()=>{
  const contexts=[];const f=fixture({processSource:async(_u,request)=>{
    if(request.step==='annotate')contexts.push(request.context);
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'first',type:'text',text:'先の文。',needsCorrection:false},ready('後の文。')]);
    f.service.prepareSource('u','a','first');await f.service.drain();
    assert.equal(contexts.length,1);assert.equal(contexts[0].after,'後の文。');assert.equal(f.service.getSource('u','a','first').text,'先の文。');
  }finally{f.close();}
});

test('clearing all text keeps published page identities and marks the empty pages complete',()=>{
  const f=fixture();try{
    f.service.createArticleSources('u','a',[ready('全文。')]);const initial=f.service.readingPages('u','a',0),source=f.service.listSources('u','a')[0];
    f.service.saveSource('u','a',source.id,{version:source.version,text:''});
    const reading=f.service.readingPages('u','a',0);assert.equal(reading.currentPage.id,initial.currentPage.id);assert.equal(reading.currentPage.ready,true);assert.equal(reading.complete,true);
  }finally{f.close();}
});

test('deleting part of an annotated word prepares that sentence again and completes without re-OCR',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push(request.step);
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    return {bodyHtml:request.bodyHtml};
  }});try{
    const bodyHtml=applySentenceBoundaries(html('{日本語|にほんご}。'),['日本語。']);
    f.service.createArticleSources('u','a',[{type:'text',bodyHtml,status:'ready',needsCorrection:false}]);const source=f.service.listSources('u','a')[0];f.service.readingPages('u','a',0);
    f.service.saveSource('u','a',source.id,{version:source.version,text:'日本。'});
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    assert.deepEqual(calls,['segment','annotate']);assert.equal(f.service.readingPages('u','a',0).complete,true);
  }finally{f.close();}
});

test('reading page paragraph identities stay stable across repeat reads of multiline sources',()=>{
  const f=fixture();try{
    f.service.createArticleSources('u','a',[ready('一。\n二。\n三。')]);
    const first=f.service.readingPages('u','a',0),again=f.service.readingPages('u','a',0);
    assert.equal(again.currentPage.bodyHtml,first.currentPage.bodyHtml);
  }finally{f.close();}
});

test('blank text-PDF pages preserve extraction but do not block the next page or invoke text AI',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({id:request.source.id,step:request.step});
    if(request.step==='extract')return {bodyHtml:html(request.source.id==='blank'?'':'本文。')};
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};
    if(!bodyText(request.bodyHtml).trim())throw new Error('blank input not allowed');
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'blank',type:'text_pdf'},{id:'body',type:'text_pdf'}]);
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    assert.deepEqual(calls.filter(call=>call.id==='blank').map(call=>call.step),['extract']);
    assert.equal(f.service.getSource('u','a','blank').firstExtraction.text,'');
    const reading=f.service.readingPages('u','a',0);assert.equal(reading.currentPage.ready,true);assert.equal(bodyText(reading.currentPage.bodyHtml),'本文。');
  }finally{f.close();}
});

test('chapter exclusions retain complete first OCR and record filtering separately before correction',()=>{
  const f=fixture();try{
    const raw='頁見出し\n本文一。\n本文二。\n12',current='本文一。\n本文二。';
    const exclusions=[{page:5,startLine:1,endLine:1,reason:'頁見出し',text:'頁見出し'},{page:5,startLine:4,endLine:4,reason:'頁番号',text:'12'}];
    const execution={role:'ocr',providerId:'api_base',model:'chapter-model'};
    const firstExtraction={text:raw,bodyHtml:html(raw),label:'本地 OCR 首次提取结果',engine:'ndl',regions:[{text:'頁見出し'},{text:'本文一。'},{text:'本文二。'},{text:'12'}]};
    f.service.createArticleSources('u','a',[{id:'page-5',type:'scan_pdf',text:current,original:{page:5,importExclusions:exclusions},firstExtraction,importExclusions:exclusions,execution}]);
    const source=f.service.getSource('u','a','page-5'),extracted=source.changes.find(change=>change.step==='extract'),filtered=source.changes.find(change=>change.step==='chapter_filter');
    assert.equal(bodyText(extracted.bodyHtml),raw);
    assert.ok(filtered);assert.equal(bodyText(filtered.bodyHtml),current);assert.deepEqual(filtered.execution,execution);
    assert.equal(extracted.execution,null);
    assert.deepEqual(source.firstExtraction,firstExtraction);assert.equal(source.text,current);assert.deepEqual(source.original.importExclusions,exclusions);
    assert.equal(f.database.prepare('SELECT next_step FROM article_sources WHERE scope_id=?').get(source.scopeId).next_step,1);
    f.service.saveSource('u','a','page-5',{version:source.version,text:'人工补回。'+current});
    const edited=f.service.getSource('u','a','page-5');assert.deepEqual(edited.firstExtraction,firstExtraction);
    assert.equal(bodyText(edited.changes.find(change=>change.step==='extract').bodyHtml),raw);
    assert.equal(bodyText(edited.changes.find(change=>change.step==='chapter_filter').bodyHtml),current);
  }finally{f.close();}
});

test('pre-extracted source history uses the raw first result within the current article range',()=>{
  const f=fixture();try{
    const raw='先頭。対象。末尾。',current='先頭。変更。末尾。',extractionExecution={engine:'local-ocr',providerId:null};
    f.service.createArticleSources('u','a',[{id:'range-page',type:'scan_pdf',text:current,localRange:{start:3,end:6},firstExtraction:{text:raw,label:'本地 OCR 首次提取结果',execution:extractionExecution}}]);
    const source=f.service.getSource('u','a','range-page');
    assert.equal(source.text,'変更。');assert.equal(source.firstExtraction.text,raw);
    assert.equal(bodyText(source.changes.find(change=>change.step==='extract').bodyHtml),'対象。');
    assert.deepEqual(source.changes.find(change=>change.step==='extract').execution,extractionExecution);
    assert.equal(source.changes.some(change=>change.step==='chapter_filter'),false);
  }finally{f.close();}
});

test('failed single-source segmentation persists the rejected model value without changing the body',async()=>{
  const value={sentences:['変化。']},execution={role:'segmentation',providerId:'api_base',model:'deepseek'};
  const processor=createSourceProcessor({execute:async()=>({value,execution})}),f=fixture(processor);
  try{
    f.service.createArticleSources('u','a',[{id:'single-failure',type:'text',text:'原文。',needsCorrection:false}]);
    const before=f.service.getSource('u','a','single-failure');
    f.service.prepareSource('u','a','single-failure');await f.service.drain();
    const after=f.service.getSource('u','a','single-failure'),stored=f.database.prepare("SELECT status,result_json FROM source_steps WHERE scope_id=? AND step='segment' AND input_version=?").get(before.scopeId,before.version);
    assert.equal(after.status,'failed');assert.equal(after.bodyHtml,before.bodyHtml);assert.deepEqual(after.firstExtraction,before.firstExtraction);assert.equal(stored.status,'failed');
    assert.deepEqual(JSON.parse(stored.result_json),{kind:'invalid_segmentation',expectedText:'原文。',value,execution});
    assert.equal(after.changes.some(change=>change.step==='segment'),false);
  }finally{f.close();}
});

test('failed PDF batch segmentation persists the same rejected result for both source steps and changes neither body',async()=>{
  const value={sentences:['前頁。','後頁']},execution={role:'segmentation',providerId:'api_base',model:'deepseek'};
  const processor=createSourceProcessor({execute:async()=>({value,execution})}),f=fixture(processor);
  try{
    f.service.createArticleSources('u','a',[{id:'first-failure',type:'text_pdf',text:'前頁。',needsCorrection:false},{id:'second-failure',type:'text_pdf',text:'後頁。',needsCorrection:false}]);
    const before=f.service.listSources('u','a');
    f.service.heartbeat('u','a',{active:true,index:0});await f.service.drain();
    const after=f.service.listSources('u','a');
    assert.deepEqual(after.map(source=>source.bodyHtml),before.map(source=>source.bodyHtml));assert.equal(f.database.prepare('SELECT plain_text FROM documents WHERE id=?').get('a').plain_text,'前頁。後頁。');
    for(let index=0;index<after.length;index++){
      const source=after[index],stored=f.database.prepare("SELECT status,result_json FROM source_steps WHERE scope_id=? AND step='segment' AND input_version=?").get(source.scopeId,before[index].version);
      assert.equal(source.status,'failed');assert.equal(stored.status,'failed');assert.deepEqual(source.firstExtraction,before[index].firstExtraction);
      assert.deepEqual(JSON.parse(stored.result_json),{kind:'invalid_segmentation',expectedText:'前頁。後頁。',value,execution});
      assert.equal(source.changes.some(change=>change.step==='segment'),false);
    }
  }finally{f.close();}
});


test('leaving completes the requested page in background without annotating the rest of the article',async()=>{
  let release;const calls=[];const text=('あ'.repeat(99)+'。').repeat(80);
  const f=fixture({processSource:async(_u,request)=>{
    calls.push({step:request.step,length:bodyText(request.bodyHtml).length,priority:request.priority});
    if(request.step==='segment')return new Promise(resolve=>release=()=>resolve({bodyHtml:applySentenceBoundaries(request.bodyHtml,text.match(/[^。]*。/g))}));
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false}]);const session=f.service.heartbeat('u','a',{index:0});
    await new Promise(resolve=>setImmediate(resolve));f.service.heartbeat('u','a',{sessionId:session.sessionId,active:false});release();await f.service.drain();
    assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
    assert.equal(f.service.readingPages('u','a',1).currentPage.ready,false);
    assert.deepEqual(calls.filter(call=>call.step==='annotate').map(call=>call.length),[1000]);
    assert.equal(f.database.prepare('SELECT count(*) AS n FROM source_preparation_jobs').get().n,0);
  }finally{f.close();}
});

test('persisted current page work resumes after server restart without extracting again',async()=>{
  let release;const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push(request.step);if(request.step==='extract')return new Promise(resolve=>release=resolve);
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{type:'screenshot'}]);f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    f.service.stop();release({bodyHtml:html('再開。')});await f.service.drain();f.restart();await f.service.drain();
    assert.deepEqual(calls,['extract','correct','segment','annotate']);assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
  }finally{f.close();}
});

test('independent article jobs start concurrently while each article has only one running step',async()=>{
  let release;const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({id:request.source.id,step:request.step});
    if(request.source.id==='a-source'&&request.step==='extract')return new Promise(resolve=>release=resolve);
    return {bodyHtml:request.step==='extract'?html('別の文章。'):request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'a-source',type:'screenshot'}]);f.service.createArticleSources('u','b',[{id:'b-source',type:'screenshot'}]);
    const session=f.service.heartbeat('u','a',{index:0});await new Promise(resolve=>setImmediate(resolve));
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0});f.service.heartbeat('u','b',{index:0});await new Promise(resolve=>setImmediate(resolve));
    assert.ok(calls.some(call=>call.id==='b-source'));assert.equal(calls.filter(call=>call.id==='a-source').length,1);
    release({bodyHtml:html('先の文章。')});await f.service.drain();
    assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);assert.equal(f.service.readingPages('u','b',0).currentPage.ready,true);
  }finally{f.close();}
});

test('current page progress reports real annotation coverage and ignores later pages',async()=>{
  let release;let annotation=0;const text=('あ'.repeat(99)+'。').repeat(5);
  const f=fixture({processSource:async(_u,request)=>{
    if(request.step==='segment')return {bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))};
    if(request.step==='annotate'&&++annotation===2)return new Promise(resolve=>release=()=>resolve({bodyHtml:request.bodyHtml}));
    return {bodyHtml:request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false},{type:'text',text,needsCorrection:false},{type:'text',text:text.repeat(4),needsCorrection:false}]);
    assert.deepEqual(f.service.readingPages('u','a',0).preparation,{stage:'segment',percent:null,completed:0,total:null});
    const session=f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(f.service.readingPages('u','a',0).preparation,{stage:'annotate',percent:50,completed:500,total:1000});
    const startedBeforeLeaving=annotation;
    f.service.heartbeat('u','a',{sessionId:session.sessionId,active:false});release();await f.service.drain();
    assert.deepEqual(f.service.readingPages('u','a',0).preparation,{stage:'ready',percent:100,completed:1000,total:1000});
    assert.equal(annotation,startedBeforeLeaving);
    assert.ok(f.service.readingPages('u','a',0).pages.length<=3);
  }finally{f.close();}
});

test('source correction continues after leaving and never starts another source',async()=>{
  let release;const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push({id:request.source.id,step:request.step});
    if(request.step==='extract')return new Promise(resolve=>release=resolve);
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{id:'requested',type:'scan_pdf'},{id:'untouched',type:'scan_pdf'}]);
    const session=f.service.prepareSource('u','a','requested');await new Promise(resolve=>setImmediate(resolve));
    f.service.heartbeat('u','a',{sessionId:session.sessionId,active:false});release({bodyHtml:html('対象。')});await f.service.drain();
    assert.deepEqual(calls.map(call=>call.step),['extract','correct','segment','annotate']);assert.ok(calls.every(call=>call.id==='requested'));
    assert.equal(f.service.getSource('u','a','requested').status,'ready');assert.equal(f.service.getSource('u','a','untouched').text,'');
  }finally{f.close();}
});

test('saving manual text prepares its missing sentences and readings without another heartbeat',async()=>{
  const calls=[];const f=fixture({processSource:async(_u,request)=>{
    calls.push(request.step);return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)]):request.bodyHtml};
  }});try{
    f.service.createArticleSources('u','a',[{...ready('元の文。'),id:'manual-save'}]);const source=f.service.getSource('u','a','manual-save');
    f.service.saveSource('u','a','manual-save',{version:source.version,text:'人が直した文。'});await f.service.drain();
    assert.deepEqual(calls,['segment','annotate']);assert.equal(f.service.getSource('u','a','manual-save').status,'ready');
    assert.equal(f.service.getSource('u','a','manual-save').text,'人が直した文。');
  }finally{f.close();}
});

test('one reading page reviews six PDF source ranges in one batch and reuses completed coverage',async()=>{
  const batches=[],execution={providerId:'api_base',model:'deepseek'};
  const f=fixture({
    processSource:async(_u,request)=>{assert.equal(request.step,'segment');return {bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))};},
    annotateBodies:async(_u,request)=>{batches.push(request);return {items:request.items.map((item,index)=>({...item,bodyHtml:item.bodyHtml.replace('日本語',`<ruby>日本語<rt>よみ${index}</rt></ruby>`)})),execution,metrics:{reviewedItems:request.items.length}};}
  });try{
    const texts=Array.from({length:6},(_,i)=>'日本語を読む。'.repeat(20)+`${i}。`);
    f.service.createArticleSources('u','a',texts.map((text,i)=>({id:`pdf-${i}`,type:'text_pdf',text,needsCorrection:false})));
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.equal(batches.length,1);assert.equal(batches[0].items.length,6);assert.equal(batches[0].priority,'foreground');
    assert.deepEqual(batches[0].items.map(item=>bodyText(item.bodyHtml)),texts);
    assert.equal(new Set(batches[0].items.map(item=>item.id)).size,6);
    for(const [index,source] of f.service.listSources('u','a').entries()){
      assert.equal(source.text,texts[index]);assert.match(source.bodyHtml,new RegExp(`<rt>よみ${index}</rt>`));
      const step=f.database.prepare("SELECT status,result_json FROM source_steps WHERE scope_id=? AND step LIKE 'annotate:%'").get(source.scopeId);
      assert.equal(step.status,'completed');assert.deepEqual(JSON.parse(step.result_json).execution,execution);
    }
    const page=f.service.readingPages('u','a',0).currentPage;assert.equal(page.sourceIds.length,6);assert.equal(page.ready,true);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0});await f.service.drain();assert.equal(batches.length,1);
  }finally{f.close();}
});

test('a late page batch preserves a manually saved source while persisting other source results',async()=>{
  let release;const batches=[];
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}),
    annotateBodies:async(_u,request)=>{batches.push(request);return new Promise(resolve=>release=()=>resolve({items:request.items.map(item=>({...item,bodyHtml:item.bodyHtml.replace('日本語','<ruby>日本語<rt>にほんご</rt></ruby>')}))}));}
  });try{
    const text='日本語を読む。'.repeat(70);
    f.service.createArticleSources('u','a',[{id:'edited',type:'text',text,needsCorrection:false},{id:'other',type:'text',text,needsCorrection:false}]);
    f.service.heartbeat('u','a',{index:0});for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);assert.equal(batches[0].items.length,2);
    const source=f.service.getSource('u','a','edited');f.service.beginEdit('u','a','edited',{sessionId:'editor'});
    f.service.saveSource('u','a','edited',{version:source.version,text:'人が保存した本文。'});
    release();await f.service.drain();
    assert.equal(f.service.getSource('u','a','edited').text,'人が保存した本文。');assert.equal(f.service.getSource('u','a','edited').editing,true);
    assert.equal(f.service.getSource('u','a','edited').status,'pending');assert.equal(batches.length,1);
    const other=f.service.getSource('u','a','other');assert.equal(other.status,'ready');assert.match(other.bodyHtml,/<rt>にほんご<\/rt>/);
    assert.equal(f.database.prepare("SELECT status FROM source_steps WHERE scope_id=? AND step LIKE 'annotate:%' AND input_version=?").get(source.scopeId,source.version).status,'stale');
  }finally{f.close();}
});

test('opening an editor freezes its pending batch result without blocking the other source',async()=>{
  let release;let batches=0;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}),
    annotateBodies:async(_u,request)=>{batches++;return new Promise(resolve=>release=()=>resolve({items:request.items.map(item=>({...item,bodyHtml:item.bodyHtml.replace('日本語','<ruby>日本語<rt>にほんご</rt></ruby>')}))}));}
  });try{
    const text='日本語を読む。'.repeat(70);
    f.service.createArticleSources('u','a',[{id:'editing',type:'text',text,needsCorrection:false},{id:'free',type:'text',text,needsCorrection:false}]);
    f.service.heartbeat('u','a',{index:0});for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);f.service.beginEdit('u','a','editing',{sessionId:'editor'});release();await f.service.drain();
    const editing=f.service.getSource('u','a','editing');assert.equal(editing.status,'pending');assert.doesNotMatch(editing.bodyHtml,/<ruby\b/);assert.equal(batches,1);
    assert.equal(f.service.getSource('u','a','free').status,'ready');assert.match(f.service.getSource('u','a','free').bodyHtml,/<ruby\b/);
  }finally{f.close();}
});

test('failed page proofreading persists per-range local snapshots and retries without local annotation',async()=>{
  let localCalls=0,reviewCalls=0;const localTargets=[{start:0,end:3,surface:'日本語',reading:'にほんご'}];
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}),
    prepareAnnotationBodies:async(items)=>{localCalls++;return {items:items.map(item=>({...item,text:bodyText(item.bodyHtml),targets:localTargets,metrics:{localTargets:1}})),metrics:{localItems:items.length}};},
    proofreadAnnotationBodies:async(_u,{prepared})=>{reviewCalls++;if(reviewCalls===1)throw Object.assign(new Error('provider offline'),{result:{rejected:'raw review'}});return {items:prepared.items,execution:{providerId:'api_base',model:'deepseek'}};}
  });try{
    const text='日本語を読む。'.repeat(70);
    f.service.createArticleSources('u','a',[{id:'one',type:'text',text,needsCorrection:false},{id:'two',type:'text',text,needsCorrection:false}]);
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.equal(localCalls,1);assert.equal(reviewCalls,1);
    for(const source of f.service.listSources('u','a')){
      assert.equal(source.status,'failed');
      const local=f.database.prepare("SELECT status,result_json FROM source_steps WHERE scope_id=? AND step LIKE 'annotate_local:%'").get(source.scopeId);
      assert.equal(local.status,'completed');assert.deepEqual(JSON.parse(local.result_json).targets,localTargets);
      const review=f.database.prepare("SELECT status,result_json FROM source_steps WHERE scope_id=? AND step LIKE 'annotate:%'").get(source.scopeId);
      assert.equal(review.status,'failed');assert.equal(JSON.parse(review.result_json).rejected,'raw review');
    }
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0,retry:true});await f.service.drain();
    assert.equal(localCalls,1);assert.equal(reviewCalls,2);assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
  }finally{f.close();}
});

test('local page snapshots stay unpublished and do not count as ready until proofreading completes',async()=>{
  let release;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}),
    prepareAnnotationBodies:async(items)=>({items:items.map(item=>({...item,bodyHtml:item.bodyHtml.replace('日本語','<ruby>日本語<rt>にほんご</rt></ruby>'),targets:[]}))}),
    proofreadAnnotationBodies:async(_u,{prepared})=>new Promise(resolve=>release=()=>resolve({items:prepared.items}))
  });try{
    const text='日本語を読む。'.repeat(70);
    f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false},{type:'text',text,needsCorrection:false}]);
    f.service.heartbeat('u','a',{index:0});for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.ok(release);const pending=f.service.readingPages('u','a',0);
    assert.equal(pending.currentPage.ready,false);assert.deepEqual(pending.preparation,{stage:'annotate',percent:0,completed:0,total:text.length*2});assert.doesNotMatch(pending.currentPage.bodyHtml,/<ruby\b/);
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM source_steps WHERE step LIKE 'annotate_local:%' AND status='completed'").get().n,2);
    release();await f.service.drain();assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
  }finally{f.close();}
});

test('page batches retain the foreground page plus two successors and stop prefetching after leaving',async()=>{
  const calls=[];const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g))}),
    annotateBodies:async(_u,request)=>{calls.push(request);return {items:request.items};}
  });try{
    const text=('あ'.repeat(99)+'。').repeat(80);f.service.createArticleSources('u','a',[{type:'text',text,needsCorrection:false}]);
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.deepEqual(calls.map(call=>call.items.reduce((n,item)=>n+bodyText(item.bodyHtml).length,0)),[1000,1000,1000]);
    assert.deepEqual(calls.map(call=>call.priority),['foreground','background','background']);
    const initial=f.service.readingPages('u','a',0);assert.equal(initial.pages[2].ready,true);assert.equal(initial.pages[3].ready,false);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0,active:false});await f.service.drain();assert.equal(calls.length,3);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:1,active:true});await f.service.drain();
    assert.equal(calls.length,4);assert.equal(f.service.readingPages('u','a',3).currentPage.ready,true);assert.equal(f.service.readingPages('u','a',4).currentPage.ready,false);
  }finally{f.close();}
});

test('independent article page batches overlap without duplicate work in the same article',async()=>{
  let release;const batches=[];
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])}),
    annotateBodies:async(_u,request)=>{batches.push(request);if(bodyText(request.items[0].bodyHtml)==='先の文。')return new Promise(resolve=>release=()=>resolve({items:request.items}));return {items:request.items};}
  });try{
    f.service.createArticleSources('u','a',[{type:'text',text:'先の文。',needsCorrection:false}]);f.service.createArticleSources('u','b',[{type:'text',text:'別の文。',needsCorrection:false}]);
    const session=f.service.heartbeat('u','a',{index:0});for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0});f.service.heartbeat('u','b',{index:0});
    for(let i=0;i<50&&!f.service.readingPages('u','b',0).currentPage?.ready;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.equal(f.service.readingPages('u','b',0).currentPage.ready,true);assert.equal(batches.length,2);assert.equal(f.service.readingPages('u','a',0).currentPage.ready,false);
    release();await f.service.drain();assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);assert.equal(batches.length,2);
  }finally{f.close();}
});

test('stopping during local annotation persists the snapshot and resumes proofreading after restart',async()=>{
  let release,localCalls=0,reviewCalls=0;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])}),
    prepareAnnotationBodies:async(items)=>{localCalls++;return new Promise(resolve=>release=()=>resolve({items:items.map(item=>({...item,targets:[]}))}));},
    proofreadAnnotationBodies:async(_u,{prepared})=>{reviewCalls++;return {items:prepared.items};}
  });try{
    f.service.createArticleSources('u','a',[{type:'text',text:'途中の文。',needsCorrection:false}]);f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    f.service.stop();release();await f.service.drain();
    assert.equal(localCalls,1);assert.equal(reviewCalls,0);assert.equal(f.service.listSources('u','a')[0].status,'pending');
    assert.equal(f.database.prepare("SELECT count(*) AS n FROM source_steps WHERE step LIKE 'annotate_local:%' AND status='completed'").get().n,1);
    f.restart();await f.service.drain();assert.equal(localCalls,1);assert.equal(reviewCalls,1);assert.equal(f.service.readingPages('u','a',0).currentPage.ready,true);
  }finally{f.close();}
});

test('a late page annotation keeps current QA marks after a deletion without a source version change',async()=>{
  let release;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])}),
    annotateBodies:async(_u,{items})=>new Promise(resolve=>release=()=>resolve({items}))
  });try{
    const marked=markBodyRange(html('日本語を読む。'),0,3,'deleted-qa');
    f.service.createArticleSources('u','a',[{id:'qa-source',type:'text',bodyHtml:marked,needsCorrection:false}]);
    const initial=f.service.getSource('u','a','qa-source');f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    const current=f.service.hydrateDocument('u','a'),latest=markBodyRange(removeQaMarks(current.bodyHtml),3,6,'new-qa');
    f.database.prepare('UPDATE documents SET body_html=? WHERE id=?').run(latest,'a');f.service.persistDocumentMarks('u','a',latest);
    assert.equal(f.service.getSource('u','a','qa-source').version,initial.version);
    release();await f.service.drain();
    const source=f.service.getSource('u','a','qa-source');assert.equal(source.version,initial.version);assert.equal(source.status,'ready');
    for(const result of [source.bodyHtml,f.service.hydrateDocument('u','a').bodyHtml,f.service.readingPages('u','a',0).currentPage.bodyHtml])assert.deepEqual([...new Set(bodyRanges(result).qa.map(mark=>mark.id))],['new-qa']);
  }finally{f.close();}
});

test('retrying cached local annotation cannot restore deleted QA marks and retains newly added marks',async()=>{
  let localCalls=0,reviewCalls=0;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])}),
    prepareAnnotationBodies:async(items)=>{localCalls++;return {items:items.map(item=>({...item,targets:[]}))};},
    proofreadAnnotationBodies:async(_u,{prepared})=>{reviewCalls++;assert.deepEqual(bodyRanges(prepared.items[0].bodyHtml).qa.map(mark=>mark.id),['deleted-qa']);if(reviewCalls===1)throw new Error('offline');return {items:prepared.items};}
  });try{
    const marked=markBodyRange(html('日本語を読む。'),0,3,'deleted-qa');
    f.service.createArticleSources('u','a',[{id:'qa-source',type:'text',bodyHtml:marked,needsCorrection:false}]);
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const initial=f.service.getSource('u','a','qa-source');assert.equal(initial.status,'failed');assert.equal(localCalls,1);
    const latest=markBodyRange(removeQaMarks(f.service.hydrateDocument('u','a').bodyHtml),3,6,'new-qa');
    f.database.prepare('UPDATE documents SET body_html=? WHERE id=?').run(latest,'a');f.service.persistDocumentMarks('u','a',latest);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0,retry:true});await f.service.drain();
    const source=f.service.getSource('u','a','qa-source');assert.equal(localCalls,1);assert.equal(reviewCalls,2);assert.equal(source.version,initial.version);assert.equal(source.status,'ready');
    for(const result of [source.bodyHtml,f.service.hydrateDocument('u','a').bodyHtml,f.service.readingPages('u','a',0).currentPage.bodyHtml])assert.deepEqual([...new Set(bodyRanges(result).qa.map(mark=>mark.id))],['new-qa']);
  }finally{f.close();}
});

test('new PDF pages carry the last AI sentence across extraction batches before publishing it',async()=>{
  const groups=[],batches=[],tail='みんなそうしているん',head='です。';
  const sized=(length,ending)=>'あ'.repeat(length-ending.length-1)+'。'+ending;
  const texts=[sized(158,'最初。'),sized(234,'次の文。'),sized(192,'僕は、'),sized(221,tail),head+sized(167,'自分の時'),'間のほうが大切だから。最後の文'];
  const f=fixture({
    processSource:async(_u,request)=>{
      if(request.step==='extract')return {bodyHtml:html(request.source.original.text)};
      if(request.step==='correct')return {bodyHtml:request.bodyHtml};
      assert.equal(request.step,'segment');groups.push((request.sources||[request.source]).map(source=>source.original.page));
      const text=bodyText(request.bodyHtml);
      return {bodyHtml:applySentenceBoundaries(request.bodyHtml,text.match(/[^。]*。|[^。]+$/gu))};
    },annotateBodies:async(_u,request)=>{batches.push(request);return {items:request.items};},
  });try{
    f.service.createArticleSources('u','a',texts.map((text,index)=>({id:`pdf-${index+15}`,type:'scan_pdf',original:{page:index+15,text}})));
    f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const reading=f.service.readingPages('u','a',0),joined=reading.pages.map(page=>bodyText(page.bodyHtml)).join('');
    assert.equal(joined,texts.join(''));
    assert.ok(reading.pages.every(page=>!bodyText(page.bodyHtml).endsWith(tail)));
    assert.ok(reading.pages.some(page=>bodyText(page.bodyHtml).includes(tail+head)));
    const [left,right]=['pdf-18','pdf-19'].map(id=>f.service.getSource('u','a',id));
    assert.equal(bodyRanges(left.bodyHtml).sentences.at(-1).id,bodyRanges(right.bodyHtml).sentences[0].id);
    assert.ok(groups.some(group=>group.includes(18)&&group.includes(19)));
    assert.ok(reading.complete);assert.ok(joined.endsWith('最後の文'));
    const snapshot=reading.pages.map(page=>({id:page.id,ranges:page.ranges})),calls=batches.length;
    f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.deepEqual(f.service.readingPages('u','a',0).pages.map(page=>({id:page.id,ranges:page.ranges})),snapshot);
    assert.equal(batches.length,calls);
  }finally{f.close();}
});

test('PDF carry spans multiple previous sources and releases an unpunctuated ending before a blank final page',async()=>{
  const texts=['前文。'+'あ'.repeat(450),'い'.repeat(450),'う'.repeat(150),'え'.repeat(100),'お'.repeat(80),'結末',''],inputs=[];
  const f=fixture({
    processSource:async(_u,request)=>{
      if(request.step==='extract')return {bodyHtml:html(request.source.original.text)};
      if(request.step==='correct')return {bodyHtml:request.bodyHtml};
      const text=bodyText(request.bodyHtml);inputs.push(text);
      return {bodyHtml:applySentenceBoundaries(request.bodyHtml,text.match(/[^。]*。|[^。]+$/gu))};
    },annotateBodies:async(_u,request)=>({items:request.items}),
  });try{
    f.service.createArticleSources('u','a',texts.map((text,index)=>({id:`long-${index}`,type:'text_pdf',original:{text}})));
    f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const reading=f.service.readingPages('u','a',0),joined=reading.pages.map(page=>bodyText(page.bodyHtml)).join('');
    assert.equal(joined,texts.join(''));assert.ok(reading.complete);
    assert.equal(reading.pages.length,2);assert.equal(bodyText(reading.pages[1].bodyHtml),texts.join('').slice('前文。'.length));
    assert.ok(inputs.some(text=>text.includes('あ'.repeat(450)+'い'.repeat(450)+'う'.repeat(150)+'え'.repeat(100)+'お'.repeat(80)+'結末')));
  }finally{f.close();}
});

test('retrying a local annotation snapshot after PDF carry preserves the new shared sentence ID',async()=>{
  const left='前文。みんなそうしているん',right='です。終わり。';let leftLocal=0,leftReviews=0;
  const f=fixture({
    processSource:async(_u,request)=>({bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。|[^。]+$/gu))}),
    prepareAnnotationBodies:async items=>{leftLocal+=items.filter(item=>bodyText(item.bodyHtml)===left).length;return {items:items.map(item=>({...item,targets:[]}))};},
    proofreadAnnotationBodies:async(_u,{prepared})=>{if(prepared.items.some(item=>bodyText(item.bodyHtml)===left)&&++leftReviews===1)throw new Error('offline');return {items:prepared.items};},
  });try{
    f.service.createArticleSources('u','a',[{id:'left',type:'text_pdf',text:left,needsCorrection:false},{id:'right',type:'text_pdf',text:right,needsCorrection:false}]);
    const correction=f.service.prepareSource('u','a','left');await f.service.drain();assert.equal(leftLocal,1);
    f.service.heartbeat('u','a',{sessionId:correction.sessionId,active:false});
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const shared=bodyRanges(f.service.getSource('u','a','right').bodyHtml).sentences[0].id;
    assert.equal(bodyRanges(f.service.getSource('u','a','left').bodyHtml).sentences.at(-1).id,shared);
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0,retry:true});await f.service.drain();
    assert.equal(leftLocal,1);assert.equal(leftReviews,2);
    assert.equal(bodyRanges(f.service.getSource('u','a','left').bodyHtml).sentences.at(-1).id,shared);
    assert.equal(bodyRanges(f.service.getSource('u','a','right').bodyHtml).sentences[0].id,shared);
    assert.ok(f.service.readingPages('u','a',0).complete);
  }finally{f.close();}
});

test('editing a pending PDF tail keeps it unpublished until cross-source segmentation can resume',async()=>{
  const left='前文。'+'あ'.repeat(900),right='です。';let overlap=0;
  const f=fixture({
    processSource:async(_u,request)=>{if(request.sources)overlap++;return {bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。|[^。]+$/gu))};},
    annotateBodies:async(_u,{items})=>({items}),
  });try{
    f.service.createArticleSources('u','a',[{id:'left',type:'text_pdf',text:left,needsCorrection:false},{id:'right',type:'text_pdf',text:right,needsCorrection:false}]);
    const correction=f.service.prepareSource('u','a','left');await f.service.drain();
    f.service.heartbeat('u','a',{sessionId:correction.sessionId,active:false});f.service.beginEdit('u','a','left',{sessionId:'editor'});
    assert.equal(f.service.readingPages('u','a',0).pages.length,0);
    f.service.heartbeat('u','a',{index:0});await f.service.drain();assert.equal(overlap,0);assert.equal(f.service.readingPages('u','a',0).pages.length,0);
    f.service.endEdit('u','a','left',{sessionId:'editor'});await f.service.drain();
    assert.equal(overlap,1);assert.ok(f.service.readingPages('u','a',0).complete);
    assert.ok(f.service.readingPages('u','a',0).pages.some(page=>bodyText(page.bodyHtml).includes('あ'.repeat(900)+right)));
  }finally{f.close();}
});

test('PDF carry keeps published and manual sentence boundaries firm',async()=>{
  for(const manual of [false,true]){
    const inputs=[],f=fixture({processSource:async(_u,request)=>{inputs.push(bodyText(request.bodyHtml));return {bodyHtml:applySentenceBoundaries(request.bodyHtml,[bodyText(request.bodyHtml)])};},annotateBodies:async(_u,{items})=>({items})});try{
      const text=manual?'人工句界のまま':'あ'.repeat(900),bodyHtml=applySentenceBoundaries(html(text),[text]),left={id:'left',type:'text_pdf',bodyHtml,status:'ready',needsCorrection:false,manual},right={id:'right',type:'text_pdf',text:'続き。',needsCorrection:false};
      f.service.createArticleSources('u','a',manual?[left,right]:[left]);
      const before=f.service.readingPages('u','a',0).pages.map(page=>({id:page.id,ranges:page.ranges})),sentence=bodyRanges(f.service.getSource('u','a','left').bodyHtml).sentences[0].id;
      if(!manual)f.service.createArticleSources('u','a',[right]);
      f.service.heartbeat('u','a',{index:0});await f.service.drain();
      assert.equal(bodyRanges(f.service.getSource('u','a','left').bodyHtml).sentences[0].id,sentence);
      assert.deepEqual(f.service.readingPages('u','a',0).pages.slice(0,before.length).map(page=>({id:page.id,ranges:page.ranges})),before);
      assert.deepEqual(inputs,['続き。']);
    }finally{f.close();}
  }
});

test('PDF carry restores whole-word ruby and current QA without annotating completed source coverage again',async()=>{
  const left='前文。みんなそうしているん',right='です。終わり。',readings=html=>htmlToBlocks(html).flatMap(block=>block.segments.filter(segment=>segment.reading));
  let release,leftAnnotations=0;
  const f=fixture({
    processSource:async(_u,request)=>{
      const result={bodyHtml:applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。|[^。]+$/gu))};
      return request.sources?new Promise(resolve=>release=()=>resolve(result)):result;
    },annotateBodies:async(_u,{items})=>{leftAnnotations+=items.filter(item=>bodyText(item.bodyHtml)===left).length;return {items};},
  });try{
    const marked=markBodyRange(`<p data-paragraph-id="ruby"><ruby data-origin="manual">${left}<rt>まえぶんみんなそうしているん</rt></ruby></p>`,0,3,'deleted-qa');
    f.service.createArticleSources('u','a',[{id:'left',type:'text_pdf',bodyHtml:marked,needsCorrection:false},{id:'right',type:'text_pdf',text:right,needsCorrection:false}]);
    const correction=f.service.prepareSource('u','a','left');await f.service.drain();f.service.heartbeat('u','a',{sessionId:correction.sessionId,active:false});
    const before=f.service.getSource('u','a','left'),original=readings(before.bodyHtml);assert.equal(leftAnnotations,1);
    f.service.heartbeat('u','a',{index:0});for(let i=0;i<50&&!release;i++)await new Promise(resolve=>setImmediate(resolve));assert.ok(release);
    const latest=markBodyRange(removeQaMarks(f.service.hydrateDocument('u','a').bodyHtml),3,6,'new-qa');
    f.database.prepare('UPDATE documents SET body_html=? WHERE id=?').run(latest,'a');f.service.persistDocumentMarks('u','a',latest);
    release();await f.service.drain();
    const after=f.service.getSource('u','a','left');assert.equal(after.version,before.version);assert.deepEqual(readings(after.bodyHtml),original);assert.equal(leftAnnotations,1);
    assert.deepEqual(bodyRanges(after.bodyHtml).qa.map(mark=>mark.id),['new-qa']);
    assert.equal(bodyRanges(after.bodyHtml).sentences.at(-1).id,bodyRanges(f.service.getSource('u','a','right').bodyHtml).sentences[0].id);
  }finally{f.close();}
});

test('segmentation and annotation run independently after correction and merge into latest marks',async()=>{
  let finishSegment,finishRuby;
  const seen=[];
  const f=fixture({processSource:async(_u,input)=>{
    seen.push(input.step);
    if(input.step==='segment')return new Promise(resolve=>finishSegment=()=>resolve({bodyHtml:applySentenceBoundaries(input.bodyHtml,[bodyText(input.bodyHtml)])}));
    if(input.step==='annotate')return new Promise(resolve=>finishRuby=()=>resolve({bodyHtml:input.bodyHtml.replace('日本語','<ruby data-origin="generated">日本語<rt>にほんご</rt></ruby>')}));
    return {bodyHtml:input.bodyHtml};
  }});
  try{
    f.service.createArticleSources('u','a',[{id:'parallel',type:'text',text:'日本語。',needsCorrection:false}]);
    f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<20;i++)await new Promise(resolve=>setImmediate(resolve));
    assert.deepEqual(new Set(seen),new Set(['segment','annotate']));
    finishSegment();await new Promise(resolve=>setImmediate(resolve));
    const source=f.service.getSource('u','a','parallel');
    f.service.persistDocumentMarks('u','a',markBodyRange(source.bodyHtml,0,3,'parallel-qa'));
    finishRuby();await f.service.drain();
    const result=f.service.getSource('u','a','parallel');
    assert.equal(bodyRanges(result.bodyHtml).sentences.length,1);
    assert.equal(bodyRanges(result.bodyHtml).qa[0].id,'parallel-qa');
    assert.match(result.bodyHtml,/<rt>にほんご<\/rt>/);
    assert.equal(f.service.readingPages('u','a').currentPage.ready,true);
  }finally{finishSegment?.();finishRuby?.();f.close();}
});

test('a failed preparation can be deleted without heartbeat or restart recreating it',async()=>{
  let calls=0;
  const f=fixture({processSource:async()=>{calls++;throw new Error('controlled failure');}});
  try{
    f.service.createArticleSources('u','a',[{id:'failure',type:'text',text:'日本語。'}]);
    const heartbeat=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.ok(heartbeat.taskId);
    const task=f.service.taskAdapter.get('u',heartbeat.taskId);
    assert.equal(task.canDelete,true);
    f.service.taskAdapter.delete('u',task.id,{version:task.version});
    f.service.heartbeat('u','a',{index:0});await f.service.drain();
    f.restart();f.service.heartbeat('u','a',{index:0});await f.service.drain();
    assert.equal(calls,1);
    assert.equal(f.service.taskAdapter.list('u').length,0);
    const explicit=f.service.heartbeat('u','a',{index:0,retry:true});await f.service.drain();
    assert.notEqual(explicit.taskId,task.id);assert.equal(calls,2);
    assert.equal(f.service.getSource('u','a','failure').text,'日本語。');
  }finally{f.close();}
});

test('annotation completed before segmentation keeps human ruby and merges the other branch',async()=>{
  let finishSegment,finishRuby;
  const f=fixture({processSource:async(_u,input)=>{
    if(input.step==='segment')return new Promise(resolve=>finishSegment=()=>resolve({bodyHtml:applySentenceBoundaries(input.bodyHtml,[bodyText(input.bodyHtml)])}));
    if(input.step==='annotate')return new Promise(resolve=>finishRuby=()=>resolve({bodyHtml:input.bodyHtml.replace('日本語','<ruby data-origin="generated">日本語<rt>にほんご</rt></ruby>')}));
    return {bodyHtml:input.bodyHtml};
  }});
  try{
    f.service.createArticleSources('u','a',[{id:'reverse',type:'text',text:'日本語。',needsCorrection:false}]);f.service.heartbeat('u','a',{index:0});
    for(let i=0;i<10;i++)await new Promise(resolve=>setImmediate(resolve));
    const source=f.service.getSource('u','a','reverse');
    f.service.persistDocumentMarks('u','a',source.bodyHtml.replace('日本語','<ruby data-origin="manual">日本語<rt>にっぽんご</rt></ruby>'));
    finishRuby();await new Promise(resolve=>setImmediate(resolve));
    assert.match(f.service.getSource('u','a','reverse').bodyHtml,/<rt>にっぽんご<\/rt>/);
    assert.equal(f.service.readingPages('u','a').currentPage,null);
    finishSegment();await f.service.drain();
    const result=f.service.getSource('u','a','reverse');
    assert.match(result.bodyHtml,/<rt>にっぽんご<\/rt>/);
    assert.equal(bodyRanges(result.bodyHtml).sentences.length,1);
    assert.equal(f.service.readingPages('u','a').currentPage.ready,true);
  }finally{finishSegment?.();finishRuby?.();f.close();}
});

test('task history retains successful correction timing across the corrected body version',async()=>{
  const f=fixture({processSource:async(_user,input)=>{
    const execution={role:input.step,model:'history-model',elapsedMs:24};
    return {bodyHtml:input.step==='correct'?html('日本語です。'):input.step==='segment'?applySentenceBoundaries(input.bodyHtml,[bodyText(input.bodyHtml)]):input.bodyHtml,execution};
  }});
  try{
    f.service.createArticleSources('u','a',[{id:'history',type:'text',text:'日本語。'}]);
    const session=f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const task=f.service.taskAdapter.get('u',session.taskId),correction=task.steps.find(step=>step.step==='correct');
    assert.equal(correction.status,'completed');assert.equal(correction.execution.model,'history-model');assert.equal(correction.execution.elapsedMs,24);
    assert.equal(correction.inputVersion,1);assert.equal(correction.version,2);
  }finally{f.close();}
});
