import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalWorkerPool} from '../server/ocr/worker-pool.mjs';

test('local pool bounds workers, queues independently and aborts only the affected worker',async()=>{
  let next=0;const workers=[],calls=[];
  const pool=createLocalWorkerPool({workers:2,label:'本地处理',method:'execute',create(){
    const worker={id:++next,closed:false,execute(input){calls.push([this.id,input]);return input==='hang'?new Promise(()=>{}):Promise.resolve(this.id);},close(){this.closed=true;}};
    workers.push(worker);return worker;
  }});
  const controller=new AbortController(),hung=pool.execute('hang',{signal:controller.signal});
  assert.equal(await pool.execute('next'),2);
  controller.abort();await assert.rejects(hung,{name:'AbortError'});
  assert.ok(workers[0].closed);assert.equal(workers[1].closed,false);
  assert.equal(await pool.execute('new'),3);pool.close();assert.ok(workers.every(worker=>worker.closed));
});

test('queued local cancellation never starts work; close rejects active and waiting jobs',async()=>{
  let runs=0;const pool=createLocalWorkerPool({workers:1,label:'本地处理',method:'execute',create:()=>({execute(){runs++;return new Promise(()=>{});},close(){}})});
  const active=pool.execute('hang'),controller=new AbortController(),queued=pool.execute('queued',{signal:controller.signal});
  controller.abort();await assert.rejects(queued,{name:'AbortError'});assert.equal(runs,1);
  const waiting=pool.execute('waiting');pool.close();await assert.rejects(active,{status:503});await assert.rejects(waiting,{status:503});
});

test('local execution status reports resource queue separately and observer failures cannot stop work',async()=>{
  const states=[];let release;
  const pool=createLocalWorkerPool({workers:1,label:'本地处理',method:'execute',create:()=>({execute:input=>input==='first'?new Promise(resolve=>{release=resolve;}):Promise.resolve(input),close(){}})});
  const first=pool.execute('first');
  const second=pool.execute('second',{onStatus:status=>{states.push(status.state);if(status.state==='running')throw new Error('observer');}});
  assert.deepEqual(states,['queued']);release('first');await first;assert.equal(await second,'second');assert.deepEqual(states,['queued','running']);pool.close();
});

test('local cancellation while announcing execution does not start cancelled work',async()=>{
  let runs=0;const controller=new AbortController(),pool=createLocalWorkerPool({method:'execute',create:()=>({execute(){runs++;return Promise.resolve();},close(){}})});
  await assert.rejects(pool.execute('cancel',{signal:controller.signal,onStatus:status=>{if(status.state==='running')controller.abort();}}),{name:'AbortError'});
  assert.equal(runs,0);pool.close();
});
