// Development acceptance runner. Production server/index.mjs never loads this.
// Faults are scoped by the newly imported PDF id + page + source step, and
// inserted inside the real provider execution slot. Other work uses real AI.
import {bodyText} from '../shared/article-html.mjs';
import {readFileSync,appendFileSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createApp} from '../server/app.mjs';
import {createProviderConnection} from '../server/providers/index.mjs';

const dataDir=resolve(process.env.DATA_DIR||'data');
const controlPath=resolve(process.env.ISOLATION_CONTROL||'artifacts/isolation-control.json');
const logPath=resolve(process.env.ISOLATION_LOG||'artifacts/isolation-events.jsonl');
mkdirSync(resolve('artifacts'),{recursive:true});
const pendingSources=new Map(),injected=new Set();
const record=event=>appendFileSync(logPath,JSON.stringify({at:new Date().toISOString(),...event})+'\n');
const control=()=>{try{return JSON.parse(readFileSync(controlPath,'utf8'));}catch{return {};}};
const callbackUri=`http://127.0.0.1:${process.env.PORT||4317}/auth/callback`;
const instance=createApp({dataDir,callbackUri,aiServices:(ownerId,providerId)=>{
  const connection=createProviderConnection({providerId,storageDir:join(dataDir,'users',ownerId,'providers'),callbackUri});
  const run=connection.runtime.run.bind(connection.runtime);
  const wrap=work=>async input=>{
    let target;try{target=JSON.parse(input.prompt.split('目标正文：\n').at(-1));}catch{}
    const scope=typeof target==='string'?pendingSources.get(target):null,fault=control();
    const metadata={providerId,sourceId:scope?.source?.id,page:scope?.source?.original?.page,step:scope?.step,groupKey:scope?.groupKey};
    const match=scope&&fault.importId===scope.source?.original?.importId&&fault.page===scope.source?.original?.page&&fault.step===scope.step&&fault.id&&!injected.has(fault.id);
    if(match&&['timeout','failure'].includes(fault.mode)){
      injected.add(fault.id);record({...metadata,event:'controlled_fault_started',faultId:fault.id,mode:fault.mode});
      if(fault.mode==='timeout'){
        try{await delay(600000,null,{signal:input.signal});}
        finally{record({...metadata,event:'controlled_fault_stopped',faultId:fault.id});}
      }
      throw Object.assign(new Error('GUI 验收：受控提供方失败。'),{status:502,expose:true});
    }
    record({...metadata,event:'real_provider_started'});
    try{const result=await work(input);record({...metadata,event:'real_provider_completed'});return result;}
    catch(error){record({...metadata,event:'real_provider_failed',code:error.code||null,status:error.status||null});throw error;}
  };
  connection.runtime.run=wrap(run);
  if(connection.runtime.reserveCLI){
    const reserve=connection.runtime.reserveCLI.bind(connection.runtime);
    connection.runtime.reserveCLI=input=>{const lease=reserve(input);return lease&&{...lease,run:wrap(lease.run.bind(lease))};};
  }
  return connection;
}});
for(const method of ['processSource']){
  const original=instance.ai[method].bind(instance.ai);
  instance.ai[method]=async(userId,input)=>{
    const text=bodyText(input.bodyHtml||'<p></p>');
    if(input.step==='correct')pendingSources.set(text,input);
    try{return await original(userId,input);}
    finally{if(pendingSources.get(text)===input)pendingSources.delete(text);}
  };
}
const server=instance.app.listen(Number(process.env.PORT||4317),'127.0.0.1',()=>console.log('GUI isolation acceptance backend listening'));
let stopping=false;
async function stop(){if(stopping)return;stopping=true;const beforeClose=new Promise(resolve=>server.close(resolve));await instance.shutdown({beforeClose});process.exitCode=0;}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
