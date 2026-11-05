import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { attachTaskRoutes } from '../server/tasks.mjs';

async function fixture(t) {
  const database=new DatabaseSync(':memory:'),rows=new Map(),calls={list:0,get:0};
  const adapter={type:'import',list(owner){calls.list++;return [...rows.values()].filter(row=>row.owner===owner);},
    get(owner,id){calls.get++;const row=rows.get(id);if(!row||row.owner!==owner)throw Object.assign(new Error('missing'),{status:404});return row;},
    retry(owner,id){const row=this.get(owner,id);row.status='queued';row.version++;row.canDelete=false;row.canRetry=false;return row;},
    delete(owner,id){rows.delete(id);}};
  const app=express();app.use(express.json());app.use((req,res,next)=>{req.user={id:req.headers['x-owner']||'one'};next();});
  attachTaskRoutes({app,database,adapters:[adapter]});
  app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(resolve=>server.close(resolve));database.close();});
  const url=`http://127.0.0.1:${server.address().port}`;
  async function request(path,method='GET',body,owner='one'){
    const response=await fetch(`${url}/api/tasks${path}`,{method,headers:{'content-type':'application/json','x-owner':owner},...(body?{body:JSON.stringify(body)}:{})});
    return {status:response.status,data:response.status===204?null:await response.json()};
  }
  function add(id,patch={}){rows.set(id,{id,owner:'one',title:id,status:'failed',version:1,steps:[],canRetry:true,canDelete:true,createdAt:'2026-01-01',updatedAt:'2026-01-01',...patch});}
  return {database,rows,add,request,calls};
}

test('task catalog backfills adapters, filters and isolates users',async t=>{
  const f=await fixture(t);f.add('first');f.add('complete',{status:'completed',archived:true,canDelete:false});f.add('private',{owner:'two'});
  const active=await f.request('');assert.equal(active.status,200);assert.deepEqual(active.data.tasks.map(x=>x.id),['first']);
  assert.equal(active.data.counts.archived,1);
  assert.equal((await f.request('/private')).status,404);
  assert.deepEqual((await f.request('?scope=archived&type=import')).data.tasks.map(x=>x.id),['complete']);
  assert.equal((await f.request('?type=invalid')).status,400);
});

test('task delete rechecks version and active children and tombstones backfill',async t=>{
  const f=await fixture(t);f.add('job');await f.request('');
  assert.equal((await f.request('/job','DELETE',{version:2})).status,409);
  f.rows.get('job').steps=[{id:'running',status:'running'}];
  assert.equal((await f.request('/job','DELETE',{version:1})).status,409);
  f.rows.get('job').steps=[{id:'parent',status:'failed',children:[{id:'retry',status:'retry_wait'}]}];
  assert.equal((await f.request('/job','DELETE',{version:1})).status,409);
  f.rows.get('job').steps=[];
  assert.equal((await f.request('/job','DELETE',{version:1})).status,204);
  f.add('job');assert.equal((await f.request('')).data.total,0);assert.equal((await f.request('/job')).status,404);
});

test('only failed stopped tasks retry, and concurrent duplicate retry cannot rerun it',async t=>{
  const f=await fixture(t);f.add('retry');
  const first=await f.request('/retry/retry','POST',{version:1});assert.equal(first.status,200);assert.equal(first.data.status,'queued');
  assert.equal((await f.request('/retry/retry','POST',{version:1})).status,409);
  f.add('done',{status:'completed',canRetry:false,canDelete:false,archived:true});
  assert.equal((await f.request('/done','DELETE',{version:1})).status,409);
});

test('task directory persists the native request target ranges and generation',async t=>{
  const f=await fixture(t),targets=[{mode:'reading',index:3,pageId:'page',ranges:[{sourceId:'source',start:10,end:80}],sourceVersions:{source:2}}];
  f.add('scoped',{documentId:'article',bookId:'book',generation:3,targets});
  await f.request('/scoped');
  const stored=f.database.prepare('SELECT target_json,generation FROM task_catalog WHERE id=?').get('scoped');
  assert.deepEqual(JSON.parse(stored.target_json),{documentId:'article',bookId:'book',targets});
  assert.equal(stored.generation,3);
});

test('a paginated task list reuses its native snapshots without reading every task twice',async t=>{
  const f=await fixture(t);for(let index=0;index<19;index++)f.add(`task-${index}`);
  const list=await f.request('?limit=1');assert.equal(list.status,200);assert.equal(list.data.total,19);assert.equal(list.data.tasks.length,1);
  assert.deepEqual(f.calls,{list:1,get:0});
  await f.request('?limit=1');assert.deepEqual(f.calls,{list:2,get:0});
});

test('known task detail reads only its native task, while unknown detail backfills once',async t=>{
  const f=await fixture(t);f.add('known');f.add('unrelated');await f.request('');
  f.calls.list=0;f.calls.get=0;
  assert.equal((await f.request('/known')).data.id,'known');
  assert.deepEqual(f.calls,{list:0,get:1});
  f.add('new-native-task');
  assert.equal((await f.request('/new-native-task')).data.id,'new-native-task');
  assert.deepEqual(f.calls,{list:1,get:2});
  assert.equal((await f.request('/known','GET',undefined,'two')).status,404);
});

test('stable polling does not rewrite catalog rows, while native field changes persist once',async t=>{
  const f=await fixture(t);f.add('job',{documentId:'article',generation:1});await f.request('');
  const changes=()=>f.database.prepare('SELECT total_changes() AS changes').get().changes;
  const before=changes();await f.request('');assert.equal(changes()-before,0);
  Object.assign(f.rows.get('job'),{generation:2,archived:true,status:'completed',canRetry:false,canDelete:false,updatedAt:'2026-01-02',targets:[{mode:'reading',index:4}]});
  await f.request('?scope=archived');assert.equal(changes()-before,1);
  const stored=f.database.prepare("SELECT generation,archived,target_json,updated_at FROM task_catalog WHERE id='job'").get();
  assert.equal(stored.generation,2);assert.equal(stored.archived,1);assert.equal(stored.updated_at,'2026-01-02');assert.deepEqual(JSON.parse(stored.target_json).targets,[{mode:'reading',index:4}]);
  await f.request('?scope=archived');assert.equal(changes()-before,1);
});
