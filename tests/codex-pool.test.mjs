import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCodexPool} from '../server/providers/openai/pool.mjs';
import {createOperationQueue} from '../server/ai/operation-queue.mjs';

test('CLI进程池并发、旧会话回到原目录，新会话归属重启后保持',async t=>{
  const storageDir=await mkdtemp(join(tmpdir(),'codex-pool-'));t.after(()=>rm(storageDir,{recursive:true,force:true}));
  let release;const gate=new Promise(r=>release=r),calls=[];let count=0;
  const make=()=>createCodexPool({storageDir,size:2,createRuntime:options=>({
    run:async input=>{calls.push({path:options.storageDir,prompt:input.prompt});if(input.prompt==='slow')await gate;return {threadId:input.threadId||`new-${++count}`,completed:true};},
    status:()=>({}),stop(){},prepare:async()=>({model:'fixture'}),models:async()=>({models:[]}),
  })});
  const pool=make();const first=pool.run({prompt:'slow'});await new Promise(setImmediate);
  const second=await pool.run({prompt:'fast'});
  assert.equal(calls.length,2);assert.equal(calls[0].path,storageDir);assert.equal(calls[1].path,join(storageDir,'worker-1'));
  release();await first;pool.stop();
  const reopened=make();await reopened.run({prompt:'resume',threadId:second.threadId});
  assert.equal(calls.at(-1).path,join(storageDir,'worker-1'));
  await reopened.run({prompt:'legacy',threadId:'old-thread'});assert.equal(calls.at(-1).path,storageDir);reopened.stop();
});

test('CLI资源预留使等待旧会话的请求不阻塞空闲进程上的新工作',async t=>{
  const storageDir=await mkdtemp(join(tmpdir(),'codex-reserve-'));t.after(()=>rm(storageDir,{recursive:true,force:true}));
  let release;const gate=new Promise(resolve=>release=resolve),calls=[];
  const pool=createCodexPool({storageDir,size:2,createRuntime:options=>({
    run:async input=>{calls.push({path:options.storageDir,prompt:input.prompt});if(input.prompt==='slow')await gate;return {threadId:input.threadId||'new-thread',completed:true};},status:()=>({}),stop(){},
  })});t.after(()=>pool.stop());
  assert.equal(typeof pool.reserve,'function','pool must expose atomic worker admission');
  const queue=createOperationQueue({concurrency:2});
  pool.onAvailable(()=>queue.refresh());
  const run=(input,options={})=>{
    let lease;
    return queue.run(({signal})=>lease.run({...input,signal}),{...options,canStart:()=>pool.available(input),acquire:()=>{lease=pool.reserve(input);return lease?()=>lease.release():false;}});
  };
  const slow=run({prompt:'slow',threadId:'old-a'});await new Promise(setImmediate);
  const resumed=run({prompt:'resume',threadId:'old-b'},{timeoutMs:20});
  await run({prompt:'independent'});
  assert.deepEqual(calls.map(call=>call.prompt),['slow','independent']);
  assert.equal(calls[1].path,join(storageDir,'worker-1'));
  await new Promise(resolve=>setTimeout(resolve,30));release();await Promise.all([slow,resumed]);
  assert.equal(calls.at(-1).prompt,'resume');assert.equal(calls.at(-1).path,storageDir);
});

test('CLI预留请求超时后释放工作进程，迟到的会话结果不能持久化',async t=>{
  const storageDir=await mkdtemp(join(tmpdir(),'codex-reserve-timeout-'));t.after(()=>rm(storageDir,{recursive:true,force:true}));
  let release;const gate=new Promise(resolve=>release=resolve);let stopped=0;
  t.after(()=>release());
  const pool=createCodexPool({storageDir,size:1,createRuntime:()=>({
    run:async input=>{if(input.prompt==='late')await gate;return {threadId:input.prompt,completed:true};},status:()=>({}),stop(){stopped++;},
  })});t.after(()=>pool.stop());
  const lease=pool.reserve(),controller=new AbortController();
  const running=lease.run({prompt:'late',signal:controller.signal});
  let timer;
  const failed=assert.rejects(Promise.race([running,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('aborted CLI lease did not settle')),1000);})]),{name:'AbortError'}).finally(()=>clearTimeout(timer));
  await new Promise(setImmediate);controller.abort();
  await failed;lease.release();
  assert.equal(stopped,1);assert.equal(pool.available(),true);
  const fresh=pool.reserve();assert.equal((await fresh.run({prompt:'fresh'})).threadId,'fresh');fresh.release();
  release();await new Promise(setImmediate);
  assert.equal(pool.status().activeCount,0);
  assert.equal(JSON.parse(await readFile(join(storageDir,'thread-workers.json'),'utf8')).late,undefined);
});

test('CLI缩容后保留历史会话归属，直接调用仍遵守新的并发上限',async t=>{
  const storageDir=await mkdtemp(join(tmpdir(),'codex-reduced-pool-'));
  await writeFile(join(storageDir,'thread-workers.json'),JSON.stringify({retained:1}));
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve),calls=[],jobs=[];
  const pool=createCodexPool({storageDir,size:1,createRuntime:options=>({
    async run(input){calls.push({prompt:input.prompt,directory:options.storageDir});if(input.threadId==='retained'){entered();await gate;}return {threadId:input.threadId||'fresh',completed:true};},status:()=>({}),stop(){},
  })});
  t.after(async()=>{release();await Promise.allSettled(jobs);pool.stop();await rm(storageDir,{recursive:true,force:true});});
  const legacy=pool.run({threadId:'retained',prompt:'legacy'});jobs.push(legacy);await started;
  const fresh=pool.run({prompt:'fresh'});jobs.push(fresh);await new Promise(setImmediate);
  assert.equal(calls.length,1,'历史worker1执行时，新worker0也必须等待缩容后的唯一名额');
  assert.equal(pool.available(),false);
  release();await Promise.all(jobs);
  assert.deepEqual(calls.map(call=>call.prompt),['legacy','fresh']);
  assert.equal(calls[0].directory,join(storageDir,'worker-1'));
  assert.equal(pool.status().activeCount,0);
});
