import {join} from 'node:path';
import {mkdirSync,readFileSync,writeFileSync,renameSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {createCodexRuntime} from './runtime.mjs';
import {createOperationQueue} from '../../ai/operation-queue.mjs';
import {raceWithSignal} from '../abort.mjs';

// Each CLI process still has exactly one active turn. Only independent process
// homes are concurrent; persisted conversation ownership survives restarts.
export function createCodexPool({storageDir,size=process.env.OPENAI_CLI_WORKERS || 2,createRuntime=createCodexRuntime,...options}={}) {
  const workerCount=Math.max(1,Math.min(16,Math.floor(Number(size)||2)));
  mkdirSync(storageDir,{recursive:true,mode:0o700});
  const mappingFile=join(storageDir,'thread-workers.json'), owners=new Map();
  try {
    const saved=JSON.parse(readFileSync(mappingFile,'utf8'));
    for(const [thread,index] of Object.entries(saved)) if(Number.isSafeInteger(index)&&index>=0) owners.set(thread,index);
  } catch(error) {if(error.code!=='ENOENT') throw error;}
  // A configured reduction must still be able to resume old worker sessions.
  const count=Math.max(workerCount,...[...owners.values()].map(index=>index+1));
  const workers=Array.from({length:count},(_,index)=>({
    directory:index===0?storageDir:join(storageDir,`worker-${index}`), runtime:null,
    queue:createOperationQueue(),reserved:false,
  }));
  const runtime=index=>workers[index].runtime ||= createRuntime({...options,storageDir:workers[index].directory});
  function save(thread,index) {
    if(!thread||owners.get(thread)===index)return;
    owners.set(thread,index);
    const temporary=`${mappingFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary,JSON.stringify(Object.fromEntries(owners)),{mode:0o600});renameSync(temporary,mappingFile);
  }
  let stopped=false;
  const listeners=new Set();
  const occupied=()=>workers.reduce((sum,worker)=>sum+worker.queue.status().activeCount+Number(worker.reserved),0);
  const notify=()=>{for(const worker of workers)worker.queue.refresh();for(const listener of listeners)listener();};
  const owner=input=>input.threadId?(owners.get(input.threadId)??0):null;
  const idle=index=>!workers[index].reserved&&!workers[index].queue.status().activeCount&&!workers[index].queue.status().waiting;
  const availableWorker=input=>{
    if(stopped||occupied()>=workerCount)return -1;
    const fixed=owner(input);
    return fixed===null ? workers.findIndex((_,index)=>index<workerCount&&idle(index)) : idle(fixed)?fixed:-1;
  };
  async function execute(index,input,valid=()=>true){
    const result=await runtime(index).run(input);
    input.signal?.throwIfAborted();
    if(stopped||!valid())throw Object.assign(new Error('AI 请求已停止，请重试。'),{status:409,expose:true});
    save(result.threadId,index);return result;
  }
  return {
    available:(input={})=>availableWorker(input)>=0,
    onAvailable(listener){listeners.add(listener);return()=>listeners.delete(listener);},
    reserve(input={}) {
      const index=availableWorker(input);if(index<0)return null;
      const worker=workers[index];worker.reserved=true;
      let released=false,running=false,executing=false;
      return {
        async run(value){
          if(released||running)throw Object.assign(new Error('AI 进程预留已结束或正在执行，请重试。'),{status:409,expose:true});
          running=true;
          try{return await raceWithSignal(async()=>{
            executing=true;
            try{return await execute(index,value,()=>!released);}finally{executing=false;}
          },value.signal);}
          finally{running=false;}
        },
        release(){
          if(released)return;released=true;
          if(executing){worker.runtime?.stop();worker.runtime=null;}
          worker.reserved=false;notify();
        },
      };
    },
    run(input={}) {
      if(stopped) return Promise.reject(Object.assign(new Error('AI 进程池已停止，请重试。'),{status:503,expose:true}));
      let index=input.threadId?(owners.get(input.threadId)??0):0;
      if(!input.threadId)for(let candidate=1;candidate<workerCount;candidate++) {
        const a=workers[index].queue.status(),b=workers[candidate].queue.status();
        if(b.activeCount+b.waiting+Number(workers[candidate].reserved)<a.activeCount+a.waiting+Number(workers[index].reserved))index=candidate;
      }
      return workers[index].queue.run(async ({signal})=>{
        return execute(index,{...input,signal});
      },{signal:input.signal,priority:input.priority,getPriority:input.getPriority,groupKey:input.groupKey,canStart:()=>!workers[index].reserved&&occupied()<workerCount}).finally(notify);
    },
    prepare:input=>runtime(0).prepare(input),models:input=>runtime(0).models(input),
    status() {
      const states=workers.map(worker=>worker.runtime?.status());
      return {model:null,lastError:null,lastSuccessfulAt:null,...(states.find(Boolean)||{}),busy:workers.some(worker=>worker.reserved||worker.queue.status().active),
        activeCount:occupied(),
        workers:workerCount,running:states.some(state=>state?.running)};
    },
    stop() {stopped=true;for(const worker of workers){worker.queue.close();worker.runtime?.stop();}},
  };
}
