import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSourceService} from '../server/sources.mjs';
import {blocksToHtml,bodyText,applySentenceBoundaries} from '../shared/article-html.mjs';
import {parseText} from '../shared/document.mjs';
const html=text=>blocksToHtml(parseText(text));
const tick=()=>new Promise(setImmediate);
function fixture(ai) {
  const database=new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);`);
  for(const id of ['a','b'])database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)').run(id,'u',id,'article','horizontal','[]','',html(''),'hash',new Date().toISOString(),new Date().toISOString(),'[]',null,null);
  const service=createSourceService({database,ai,now:()=>1000,requireDocument:(user,id)=>{
    const row=database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id,user);if(!row)throw Object.assign(new Error('missing'),{status:404});return row;
  },fromRow:row=>({id:row.id,bodyHtml:row.body_html,blocks:JSON.parse(row.blocks_json),revision:row.revision})});
  return {database,service,close(){service.close();database.close();}};
}
const result=request=>({bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。|[^。]+$/g)||[]):request.bodyHtml});

test('相邻PDF页等待校对时不会阻塞另一个章节启动',async()=>{
  let release;const calls=[];const f=fixture({processSource:async(_user,request)=>{
    calls.push([request.source.id,request.step]);
    if(request.source.id==='lookahead'&&request.step==='correct')await new Promise(resolve=>release=resolve);
    return result(request);
  }});
  try {
    f.service.createArticleSources('u','a',[{id:'first',type:'text_pdf',text:'前。',needsCorrection:false},{id:'lookahead',type:'text_pdf',text:'後。'}]);
    f.service.createArticleSources('u','b',[{id:'other',type:'text',text:'別章。',needsCorrection:false}]);
    f.service.heartbeat('u','a',{index:0});await tick();f.service.heartbeat('u','b',{index:0});await tick();
    assert.ok(calls.some(([id])=>id==='other'));
  } finally {release?.();await f.service.drain();f.close();}
});

test('分句只写入已经原子预留的来源，不能越过其他运行组',async()=>{
  let release;const segmentCalls=[];const f=fixture({processSource:async(_user,request)=>{
    if(request.step==='segment'){
      segmentCalls.push((request.sources||[request.source]).map(source=>source.id));
      if(request.source.id==='second'&&segmentCalls.length===1)await new Promise(resolve=>release=resolve);
    }
    return result(request);
  }});
  try {
    f.service.createArticleSources('u','a',['first','second','third'].map(id=>({id,type:'text_pdf',text:`${id}。`,needsCorrection:false})));
    f.service.prepareSource('u','a','second');await tick();f.service.heartbeat('u','a',{index:0});await tick();
    assert.equal(segmentCalls.filter(ids=>ids.includes('second')).length,1);
  } finally {release?.();await f.service.drain();f.close();}
});

for(const failedPhase of ['segment','annotate'])test(`${failedPhase}失败不会被另一个并行分支的成功清除或自动重试`,async()=>{
  let release;let failures=0;const successPhase=failedPhase==='segment'?'annotate':'segment';
  const starts=[];const f=fixture({processSource:async(_user,request)=>{
    starts.push(request.step);
    if(request.step===failedPhase){if(++failures>1)return result(request);throw Object.assign(new Error('controlled failure'),{expose:true});}
    if(request.step===successPhase&&failures===0)await new Promise(resolve=>release=resolve);
    return result(request);
  }});
  try {
    f.service.createArticleSources('u','a',[{id:'source',type:'text',text:'本文。',needsCorrection:false}]);f.service.heartbeat('u','a',{index:0});await tick();
    release?.();await f.service.drain();
    assert.equal(failures,1);assert.equal(f.service.getSource('u','a','source').status,'failed');
    const successful=f.database.prepare("SELECT COUNT(*) AS n FROM source_steps WHERE scope_id=? AND step LIKE ? AND status='completed'").get(f.service.getSource('u','a','source').scopeId,successPhase+'%');
    assert.ok(successful.n>0);
    f.service.heartbeat('u','a',{index:0,retry:true});await f.service.drain();
    assert.equal(failures,2);assert.equal(starts.filter(step=>step===successPhase).length,1);assert.equal(f.service.getSource('u','a','source').status,'ready');
  } finally {release?.();f.close();}
});


test('失败任务删除后普通心跳不复活，明确重新准备建立新代次',async()=>{
  let fail=true;const f=fixture({processSource:async(_user,request)=>{if(fail)throw new Error('failure');return result(request);}});
  try {
    f.service.createArticleSources('u','a',[{id:'source',type:'text',text:'本文。'}]);f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const task=f.service.taskAdapter.list('u')[0];f.service.taskAdapter.delete('u',task.id,{version:task.version});
    f.service.heartbeat('u','a',{index:0});await f.service.drain();assert.equal(f.service.taskAdapter.list('u').length,0);
    fail=false;f.service.prepareSource('u','a','source');await f.service.drain();
    const next=f.service.taskAdapter.list('u')[0];assert.ok(next);assert.notEqual(next.id,task.id);assert.equal(next.generation,task.generation+1);assert.equal(next.status,'completed');
  }finally{f.close();}
});

test('同一来源的不同注音范围可以并发，重叠范围只执行一次',async()=>{
  const releases=[],calls=[];
  const f=fixture({processSource:async(_user,request)=>{
    calls.push(bodyText(request.bodyHtml));await new Promise(resolve=>releases.push(resolve));return {bodyHtml:request.bodyHtml};
  }});
  try{
    const text=('あ'.repeat(99)+'。').repeat(30);
    f.service.createArticleSources('u','a',[{id:'source',type:'text',bodyHtml:applySentenceBoundaries(html(text),text.match(/[^。]*。/g)),needsCorrection:false}]);
    f.database.prepare('UPDATE article_sources SET next_step=3').run();
    const session=f.service.heartbeat('u','a',{index:0});await tick();
    f.service.heartbeat('u','a',{sessionId:session.sessionId,index:0});await tick();
    assert.equal(calls.length,3);assert.ok(calls.every(text=>text.length===1000));
  }finally{f.service.stop();releases.forEach(release=>release());await f.service.drain();f.close();}
});

test('完成任务保存不可变归档，人工修改创建独立的新代次',async()=>{
  let hold=false,release;const f=fixture({processSource:async(_user,request)=>{
    if(hold&&request.step==='segment')await new Promise(resolve=>release=resolve);return result(request);
  }});
  try{
    f.service.createArticleSources('u','a',[{id:'source',type:'text',text:'本文。',needsCorrection:false}]);f.service.heartbeat('u','a',{index:0});await f.service.drain();
    const archived=f.service.taskAdapter.list('u')[0];assert.equal(archived.status,'completed');assert.equal(archived.archived,true);
    const original=JSON.stringify(archived),source=f.service.getSource('u','a','source');hold=true;
    f.service.saveSource('u','a','source',{version:source.version,text:'修正後の本文。'});await tick();
    const tasks=f.service.taskAdapter.list('u');assert.equal(tasks.length,2);
    assert.equal(JSON.stringify(f.service.taskAdapter.get('u',archived.id)),original);
    const current=tasks.find(task=>task.id!==archived.id);assert.equal(current.generation,archived.generation+1);assert.equal(current.archived,false);assert.notEqual(current.status,'completed');
    assert.ok(f.database.prepare('SELECT snapshot_json,finished_at FROM source_preparation_requests WHERE id=?').get(archived.id).snapshot_json);
    release?.();await f.service.drain();
    const completed=f.service.taskAdapter.get('u',current.id);assert.equal(completed.status,'completed');assert.equal(completed.archived,true);
    f.service.heartbeat('u','a',{index:0});await f.service.drain();assert.equal(f.service.taskAdapter.list('u').length,2);
  }finally{release?.();f.close();}
});

test('短PDF页校正后立即注音并与分句重叠，成功范围不会重复准备',async()=>{
  let releaseSegment,releaseAnnotation;const segments=[],batches=[];
  const texts=[220,310,270,240,260,300,230,280].map((length,index)=>`${index}日本語`+'あ'.repeat(length-5)+'。');
  const f=fixture({processSource:async(_user,request)=>{
    if(request.step==='segment'){
      segments.push(request);
      if(segments.length===1)await new Promise(resolve=>releaseSegment=resolve);
    }
    return result(request);
  },annotateBodies:async(_user,request)=>{
    batches.push(request);
    if(batches.length===1)await new Promise(resolve=>releaseAnnotation=resolve);
    return {items:request.items.map(item=>({...item,bodyHtml:item.bodyHtml.replace('日本語','<ruby>日本語<rt>にほんご</rt></ruby>')}))};
  }});
  try{
    f.service.createArticleSources('u','a',texts.map((text,index)=>({id:`short-${index}`,type:'scan_pdf',text})));
    f.service.heartbeat('u','a',{index:0});await tick();
    assert.ok(releaseSegment,'首批相邻页已进入分句');
    assert.ok(releaseAnnotation,'不足1000字的已校正首段应在分句未完成时进入注音');
    assert.ok(batches[0].items.reduce((sum,item)=>sum+bodyText(item.bodyHtml).length,0)<1000);
    assert.equal(f.service.readingPages('u','a',0).pages.length,0,'不能把短原页直接发布成不稳定阅读页');
    releaseSegment();releaseAnnotation();await f.service.drain();
    const reading=f.service.readingPages('u','a',0);
    assert.ok(reading.currentPage.ready);
    assert.equal(reading.pages.map(page=>bodyText(page.bodyHtml)).join(''),texts.join(''));
    assert.ok(f.service.listSources('u','a').every(source=>source.bodyHtml.includes('<rt>にほんご</rt>')),'迟到分句不能覆盖先完成的注音');
    for(const page of reading.pages.slice(0,-1))assert.ok(page.end-page.start>=800&&page.end-page.start<=1200);
    assert.equal(batches.flatMap(batch=>batch.items).reduce((sum,item)=>sum+bodyText(item.bodyHtml).length,0),texts.join('').length,'成功注音范围只执行一次');
    const count=batches.length;f.service.heartbeat('u','a',{index:0});await f.service.drain();assert.equal(batches.length,count);
  }finally{f.service.stop();releaseSegment?.();releaseAnnotation?.();await f.service.drain();f.close();}
});

test('首批分句等待时只向前校正一个相关PDF原页，不扩展到整章',async()=>{
  let releaseSegment;const corrections=[],segments=[];
  const f=fixture({processSource:async(_user,request)=>{
    if(request.step==='correct')corrections.push(request.source.id);
    if(request.step==='segment'){
      segments.push(request);
      await new Promise(resolve=>releaseSegment=resolve);
    }
    return result(request);
  },annotateBodies:async(_user,request)=>({items:request.items})});
  try{
    f.service.createArticleSources('u','a',Array.from({length:20},(_,index)=>({id:`page-${index}`,type:'scan_pdf',text:'あ'.repeat(299)+'。'})));
    f.service.heartbeat('u','a',{index:0});await tick();
    assert.equal(segments.length,1);
    assert.deepEqual(corrections,['page-0','page-1','page-2'],'第三张校正应与前两张分句重叠，第四张继续等待');
  }finally{f.service.stop();releaseSegment?.();await f.service.drain();f.close();}
});

test('首批分句长期等待时，早注音也只准备有界前缀',async()=>{
  let release;const batches=[];
  const f=fixture({processSource:async(_user,request)=>{
    if(request.step==='segment')await new Promise(resolve=>release=resolve);
    return result(request);
  },annotateBodies:async(_user,request)=>{batches.push(request);return {items:request.items};}});
  try{
    f.service.createArticleSources('u','a',Array.from({length:20},(_,index)=>({id:`page-${index}`,type:'scan_pdf',text:'あ'.repeat(299)+'。',needsCorrection:false})));
    f.service.heartbeat('u','a',{index:0});await tick();
    const annotated=batches.flatMap(batch=>batch.items).reduce((sum,item)=>sum+bodyText(item.bodyHtml).length,0);
    assert.ok(annotated>0&&annotated<=2400,'不能因正文已校正就提前注音整章6000字');
  }finally{f.service.stop();release?.();await f.service.drain();f.close();}
});
