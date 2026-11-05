import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSourceService } from '../server/sources.mjs';
import { blocksToHtml, bodyText, applySentenceBoundaries } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';

const html=text=>blocksToHtml(parseText(text));
const tick=()=>new Promise(setImmediate);
function fixture(t,processSource=async(_user,request)=>({bodyHtml:request.bodyHtml}),extraAI={}){
  const database=new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);`);
  database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,1,?,?,?,?,?)').run('document','owner','長い文章','article','horizontal','[]','',html(''),'hash',new Date().toISOString(),new Date().toISOString(),'[]',null,null);
  const service=createSourceService({database,ai:{processSource,...extraAI},requireDocument:(user,id)=>{
    const row=database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id,user);
    if(!row)throw Object.assign(new Error('missing'),{status:404});return row;
  },fromRow:row=>({id:row.id,bodyHtml:row.body_html,blocks:JSON.parse(row.blocks_json),revision:row.revision})});
  const text=('あ'.repeat(99)+'。').repeat(60);
  service.createArticleSources('owner','document',[{id:'source',type:'text',bodyHtml:applySentenceBoundaries(html(text),text.match(/[^。]*。/g)),needsCorrection:false}]);
  database.prepare('UPDATE article_sources SET next_step=3').run();
  t.after(()=>{service.close();database.close();});
  return {database,service};
}

test('ready requested pages archive a scoped task while unread annotation ranges remain pending',async t=>{
  const f=fixture(t),session=f.service.heartbeat('owner','document',{index:0});
  await f.service.drain();
  const reading=f.service.readingPages('owner','document',0);
  assert.ok(reading.currentPage.ready);
  assert.equal(reading.complete,false,'unvisited tail remains unfinished');
  assert.ok(reading.pages.slice(3).some(page=>!page.ready));
  const task=f.service.taskAdapter.list('owner')[0];
  assert.equal(task.status,'completed','requested scope must not wait for unvisited tail');
  assert.equal(task.archived,true);
  assert.ok(task.targets.every(target=>target.mode==='reading'&&target.index<3));
  assert.ok(task.steps.every(step=>step.step==='annotate'),'only actual nodes belong to this generation');
  assert.equal(task.progress.completed,task.progress.total);
  const snapshot=JSON.stringify(task);
  f.service.heartbeat('owner','document',{sessionId:session.sessionId,index:0});await f.service.drain();
  assert.equal(f.service.taskAdapter.list('owner').length,1,'renewing a ready page must not create work');
  f.service.heartbeat('owner','document',{sessionId:session.sessionId,index:3});await f.service.drain();
  const tasks=f.service.taskAdapter.list('owner');assert.equal(tasks.length,2);
  const next=tasks.find(value=>value.id!==task.id);
  assert.equal(next.generation,task.generation+1);assert.equal(next.status,'completed');
  assert.ok(next.targets.some(target=>target.index===3));
  assert.equal(JSON.stringify(f.service.taskAdapter.get('owner',task.id)),snapshot,'old archive cannot adopt later ranges');
});

test('active prefetch is visible and prevents scope archival after the current page is ready',async t=>{
  const releases=[];let calls=0;
  const f=fixture(t,async(_user,request)=>{
    calls++;if(calls>1)await new Promise(resolve=>releases.push(resolve));return {bodyHtml:request.bodyHtml};
  });
  f.service.heartbeat('owner','document',{index:0});await tick();
  try{
    assert.ok(f.service.readingPages('owner','document',0).currentPage.ready);
    const task=f.service.taskAdapter.list('owner')[0];
    assert.equal(task.archived,false);assert.ok(['running','queued'].includes(task.status));
    assert.equal(task.canDelete,false);assert.ok(task.steps.some(step=>['running','queued'].includes(step.status)));
  }finally{releases.forEach(release=>release());await f.service.drain();}
  assert.equal(f.service.taskAdapter.list('owner')[0].status,'completed');
});

test('failed scoped retry reuses successful ranges without preparing the unread tail',async t=>{
  let fail=true;const starts=[];
  const f=fixture(t,async(_user,request)=>{
    starts.push(bodyText(request.bodyHtml));
    if(fail&&starts.length===2)throw Object.assign(new Error('controlled timeout'),{expose:true,code:'ETIMEDOUT'});
    return {bodyHtml:request.bodyHtml};
  });
  const session=f.service.heartbeat('owner','document',{index:0});await f.service.drain();
  const task=f.service.taskAdapter.list('owner')[0];assert.ok(['failed','timeout'].includes(task.status));
  const successful=f.database.prepare("SELECT step FROM source_step_attempts WHERE state='completed'").all().map(row=>row.step);
  fail=false;f.service.taskAdapter.retry('owner',task.id,{version:task.version});await f.service.drain();
  const completed=f.service.taskAdapter.get('owner',task.id);assert.equal(completed.status,'completed');
  assert.equal(starts.length,4,'only one failed range is retried');
  assert.ok(f.service.readingPages('owner','document',0).pages.slice(3).some(page=>!page.ready));
  for(const step of successful)assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM source_step_attempts WHERE step=? AND state='completed'").get(step).count,1);
  f.service.heartbeat('owner','document',{sessionId:session.sessionId,index:3});await f.service.drain();
  assert.equal(f.service.taskAdapter.list('owner').length,2);
});

test('leaving retires completed requested scope even when speculative prefetch stopped halfway',async t=>{
  let release;
  const f=fixture(t,async(_user,request)=>{
    if(request.source.id==='next'&&request.step==='correct')await new Promise(resolve=>release=resolve);
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g)):request.bodyHtml};
  });
  f.service.deleteDocument('owner','document');
  f.service.createArticleSources('owner','document',['current','next','tail'].map(id=>({id,type:'text',text:('あ'.repeat(99)+'。').repeat(10)})));
  const session=f.service.heartbeat('owner','document',{index:0});await tick();
  assert.ok(f.service.readingPages('owner','document',0).currentPage.ready);
  assert.ok(release,'a speculative source correction is still executing');
  f.service.heartbeat('owner','document',{sessionId:session.sessionId,index:0,active:false});
  release?.();await f.service.drain();
  const task=f.service.taskAdapter.list('owner')[0];assert.equal(task.status,'completed');
  assert.ok(task.steps.some(step=>step.sourceId==='next'&&step.step==='correct'),'the completed speculative node remains in the archive');
  assert.equal(f.database.prepare("SELECT next_step FROM article_sources WHERE source_id='next'").get().next_step,2,'prefetch stopped after its active node');
});

test('legacy scope backfill preserves the task id and archives a ready requested page only once',async t=>{
  const f=fixture(t);f.service.heartbeat('owner','document',{index:0});await f.service.drain();
  const before=f.service.taskAdapter.list('owner')[0];
  f.database.prepare('UPDATE source_preparation_requests SET target_json=NULL,snapshot_json=NULL,finished_at=NULL,signature=NULL WHERE id=?').run(before.id);
  f.database.prepare('UPDATE source_step_attempts SET request_id=NULL').run();
  const migrated=f.service.taskAdapter.list('owner')[0];assert.equal(migrated.id,before.id);assert.equal(migrated.status,'completed');
  assert.ok(migrated.targets.every(target=>target.mode==='reading'&&target.index===0));
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM source_step_attempts WHERE request_id IS NULL').get().n,0);
  assert.deepEqual(f.service.taskAdapter.list('owner'),JSON.parse(JSON.stringify([migrated])));
});

test('retrying a failed speculative node runs that node even when the requested page is already ready',async t=>{
  let release,fail=true;const starts=[];
  const f=fixture(t,async(_user,request)=>{
    starts.push([request.source.id,request.step]);
    if(request.source.id==='next'&&request.step==='correct'&&fail){await new Promise(resolve=>release=resolve);throw Object.assign(new Error('prefetch failure'),{expose:true});}
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g)):request.bodyHtml};
  });
  f.service.deleteDocument('owner','document');
  f.service.createArticleSources('owner','document',['current','next','tail'].map(id=>({id,type:'text',text:('あ'.repeat(99)+'。').repeat(10)})));
  const session=f.service.heartbeat('owner','document',{index:0});await tick();
  assert.ok(release);assert.ok(f.service.readingPages('owner','document',0).currentPage.ready);
  f.service.heartbeat('owner','document',{sessionId:session.sessionId,index:0,active:false});release();await f.service.drain();
  const task=f.service.taskAdapter.list('owner')[0];assert.equal(task.status,'failed');assert.equal(task.canRetry,true);
  const before=starts.length;fail=false;f.service.taskAdapter.retry('owner',task.id,{version:task.version});await f.service.drain();
  assert.deepEqual(starts.slice(before),[['next','correct']]);
  assert.equal(f.service.taskAdapter.get('owner',task.id).status,'completed');
});

test('scoped task tombstone survives repeated heartbeats without losing original source data',async t=>{
  const f=fixture(t,async()=>{throw Object.assign(new Error('controlled failure'),{expose:true});});
  const session=f.service.heartbeat('owner','document',{index:0});await f.service.drain();
  const failed=f.service.taskAdapter.list('owner')[0],source=f.service.getSource('owner','document','source');
  f.service.taskAdapter.delete('owner',failed.id,{version:failed.version});
  for(let index=0;index<3;index++)f.service.heartbeat('owner','document',{sessionId:session.sessionId,index});
  await f.service.drain();assert.deepEqual(f.service.taskAdapter.list('owner'),[]);
  assert.equal(f.database.prepare('SELECT count(*) AS n FROM source_preparation_requests').get().n,1);
  assert.deepEqual(f.service.getSource('owner','document','source').preview,source.preview);
  assert.equal(f.service.getSource('owner','document','source').text,source.text);
});

test('a manual source version invalidates old failed nodes without losing their execution history',async t=>{
  let fail=true;
  const f=fixture(t,async(_user,request)=>{
    if(fail)throw Object.assign(new Error('old version failure'),{expose:true});
    return {bodyHtml:request.step==='segment'?applySentenceBoundaries(request.bodyHtml,bodyText(request.bodyHtml).match(/[^。]*。/g)):request.bodyHtml};
  });
  f.service.heartbeat('owner','document',{index:0});await f.service.drain();
  const task=f.service.taskAdapter.list('owner')[0];assert.equal(task.status,'failed');
  const source=f.service.getSource('owner','document','source');fail=false;
  f.service.saveSource('owner','document','source',{version:source.version,text:'新しい本文。'});await f.service.drain();
  const updated=f.service.taskAdapter.get('owner',task.id);assert.equal(updated.status,'completed');
  assert.ok(f.database.prepare("SELECT count(*) AS n FROM source_step_attempts WHERE state='failed' AND input_version=?").get(source.version).n>0,'invalidated history remains auditable');
});

test('a failed local annotation retries its dependent parent and then performs remote proofreading',async t=>{
  let fail=true,localCalls=0,remoteCalls=0;
  const f=fixture(t,undefined,{
    prepareAnnotationBodies:async items=>{localCalls++;if(fail)throw Object.assign(new Error('local annotation failure'),{expose:true});return {items};},
    proofreadAnnotationBodies:async(_user,{prepared})=>{remoteCalls++;return {items:prepared.items};}
  });
  f.service.deleteDocument('owner','document');
  const text='日本語。'.repeat(60);
  f.service.createArticleSources('owner','document',[{id:'short',type:'text',bodyHtml:applySentenceBoundaries(html(text),text.match(/[^。]*。/g)),needsCorrection:false}]);
  f.database.prepare('UPDATE article_sources SET next_step=3').run();
  f.service.heartbeat('owner','document',{index:0});await f.service.drain();
  const task=f.service.taskAdapter.list('owner')[0];assert.equal(task.status,'failed');assert.equal(localCalls,1);assert.equal(remoteCalls,0);
  fail=false;f.service.taskAdapter.retry('owner',task.id,{version:task.version});await f.service.drain();
  assert.equal(localCalls,2);assert.equal(remoteCalls,1);assert.equal(f.service.taskAdapter.get('owner',task.id).status,'completed');
});
