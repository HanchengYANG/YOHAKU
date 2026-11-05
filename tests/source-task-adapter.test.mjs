import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSourceTaskAdapter } from '../server/source-task-adapter.mjs';

function fixture(t){
  const database=new DatabaseSync(':memory:');t.after(()=>database.close());
  database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,book_id TEXT);
    CREATE TABLE source_preparation_requests(id TEXT PRIMARY KEY,user_id TEXT,document_id TEXT,generation INTEGER,version INTEGER,signature TEXT,deleted_at TEXT,created_at TEXT,updated_at TEXT,snapshot_json TEXT,finished_at TEXT);
    CREATE TABLE source_steps(scope_id TEXT,step TEXT,input_version INTEGER,status TEXT,error TEXT,updated_at TEXT);
    CREATE TABLE source_step_attempts(id TEXT PRIMARY KEY,scope_id TEXT,step TEXT,input_version INTEGER,state TEXT,queued_at TEXT,started_at TEXT,finished_at TEXT,updated_at TEXT,execution_json TEXT,diagnostic_json TEXT,message TEXT);`);
  database.exec("INSERT INTO documents VALUES('document','owner','文章',NULL)");
  const clock={value:Date.parse('2026-01-01T00:00:10.000Z')},stamp=()=>new Date(clock.value).toISOString();
  database.prepare('INSERT INTO source_preparation_requests VALUES(?,?,?,?,?,?,?,?,?,?,?)').run('request','owner','document',1,1,null,null,stamp(),stamp(),null,null);
  const rows=[],working=new Map([['work',{execution:{userId:'owner',documentId:'document'}}]]);
  const adapter=createSourceTaskAdapter({database,scopes:()=>rows,sourceIdentity:row=>({label:row.source_id,page:row.position}),working,stamp});
  function add(id,state,execution,age,nextStep=2){
    rows.push({scope_id:id,source_id:id,version:1,next_step:nextStep,status:state==='completed'?'ready':'processing',position:rows.length+1});
    const updated=new Date(clock.value-age).toISOString();
    database.prepare('INSERT INTO source_step_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id,id,'segment',1,state,updated,state==='running'?updated:null,['completed','failed','requires_review'].includes(state)?updated:null,updated,JSON.stringify(execution),null,null);
  }
  return {database,clock,rows,working,adapter,add};
}

test('live source task execution increments only its current timing category without changing version',t=>{
  const f=fixture(t);
  f.add('running','running',{elapsedMs:2000,queueMs:300,retryWaitMs:400},5000);
  f.add('queued','queued',{elapsedMs:2500,queueMs:1000,retryWaitMs:500},4000);
  f.add('backoff','retry_wait',{elapsedMs:2000,queueMs:800,retryWaitMs:500},3000);
  f.add('finished','completed',{elapsedMs:1200,queueMs:200,retryWaitMs:300},7000,3);
  const task=f.adapter.get('owner','request'),step=id=>task.steps.find(step=>step.id===`${id}:segment`);
  assert.deepEqual(step('running').execution,{elapsedMs:7000,queueMs:300,retryWaitMs:400});
  assert.deepEqual(step('queued').execution,{elapsedMs:2500,queueMs:5000,retryWaitMs:500});
  assert.deepEqual(step('backoff').execution,{elapsedMs:2000,queueMs:800,retryWaitMs:3500});
  assert.deepEqual(step('finished').execution,{elapsedMs:1200,queueMs:200,retryWaitMs:300});
  f.clock.value+=10000;const later=f.adapter.get('owner','request');
  assert.equal(later.version,task.version);assert.equal(later.updatedAt,task.updatedAt);
  assert.equal(later.steps.find(step=>step.id==='running:segment').execution.elapsedMs,17000);
  assert.deepEqual(JSON.parse(f.database.prepare("SELECT execution_json FROM source_step_attempts WHERE id='running'").get().execution_json),{elapsedMs:2000,queueMs:300,retryWaitMs:400});
});

test('completed task snapshots and completed step timings remain frozen as time advances',t=>{
  const f=fixture(t);f.add('finished','completed',{elapsedMs:1200,queueMs:200},7000,4);f.working.clear();
  const task=f.adapter.get('owner','request');assert.equal(task.archived,true);
  f.clock.value+=86400000;assert.deepEqual(f.adapter.get('owner','request'),JSON.parse(JSON.stringify(task)));
});

for(const status of ['failed','timeout','requires_review','completed'])test(`delayed first inspection preserves the real ${status} task end time`,t=>{
  const f=fixture(t),createdAt=new Date(f.clock.value-10000).toISOString(),finishedAt=new Date(f.clock.value-7000).toISOString();
  f.database.prepare('UPDATE source_preparation_requests SET created_at=?,updated_at=?').run(createdAt,createdAt);
  const state=status==='timeout'?'failed':status;
  f.add('finished',state,{elapsedMs:2000,queueMs:1000},7000,status==='completed'?4:2);f.working.clear();
  if(status!=='completed')f.database.prepare('INSERT INTO source_steps VALUES(?,?,?,?,?,?)').run('finished','segment',1,state,'safe failure',finishedAt);
  if(status==='timeout')f.database.prepare('UPDATE source_step_attempts SET diagnostic_json=?').run(JSON.stringify({category:'timeout'}));
  f.clock.value+=600000;
  const task=f.adapter.get('owner','request');
  assert.equal(task.status,status);assert.equal(task.finishedAt,finishedAt);
  assert.equal(Date.parse(task.finishedAt)-Date.parse(task.createdAt),3000,'polling delay is not processing time');
  f.clock.value+=600000;const later=f.adapter.get('owner','request');
  assert.equal(later.finishedAt,finishedAt);assert.equal(later.version,task.version);
});

test('a retried source task removes its previous terminal end time while running',t=>{
  const f=fixture(t),createdAt=new Date(f.clock.value-10000).toISOString();
  f.database.prepare('UPDATE source_preparation_requests SET created_at=?').run(createdAt);
  f.add('retry','failed',{elapsedMs:2000},7000);f.working.clear();
  f.database.prepare('INSERT INTO source_steps VALUES(?,?,?,?,?,?)').run('retry','segment',1,'failed','safe failure',new Date(f.clock.value-7000).toISOString());
  const failed=f.adapter.get('owner','request');assert.ok(failed.finishedAt);
  f.clock.value+=600000;
  f.database.prepare("UPDATE source_step_attempts SET state='running',finished_at=NULL,started_at=?,updated_at=?").run(new Date(f.clock.value).toISOString(),new Date(f.clock.value).toISOString());
  f.database.prepare("UPDATE source_steps SET status='running'").run();
  f.working.set('retry',{execution:{userId:'owner',documentId:'document'}});
  const running=f.adapter.get('owner','request');assert.equal(running.status,'running');assert.equal(running.finishedAt,undefined);
  assert.equal(f.database.prepare('SELECT finished_at FROM source_preparation_requests').get().finished_at,null);
});
