import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server/app.mjs';
import { ensureSession } from './helpers/session.mjs';
import { bodyText } from '../shared/article-html.mjs';
import { APICallError } from 'ai';
import sharp from 'sharp';

async function fixture(t,{reasoning,supportsNone=true,run,capacity}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'yohaku-hybrid-role-'));
  const calls=[],localCalls=[];let connected=true;
  const reports=[undefined,{effort:'low'}].map(reasoning=>({model:'ruby',reasoning,checks:{json:{state:'supported'},image:{state:'supported'},streaming:{state:'supported'}}}));
  const models=[{id:'ruby',reasoningOptions:{efforts:supportsNone?['none','low']:['low']}}];
  const service=(_user,providerId)=>({
    auth:{status:async()=>({connected,activeAccountId:'account',subject:'subject'})},
    credentialStatus:async()=>({connected,activeAccountId:'account',subject:'subject'}),
    knownModels:async()=>models,testReports:async()=>reports,
    validateReasoning:async(_model,input)=>{if(input?.effort&&!models[0].reasoningOptions.efforts.includes(input.effort))throw new Error('unsupported effort');return input;},
    runtime:{status:()=>({busy:false,model:'ruby'}),stop(){},async run(input){
      calls.push({providerId,...input});
      if(run)return run(input,calls.length);
      return {completed:true,model:input.model,text:JSON.stringify({changes:[],uncertain:[]})};
    }},
  });
  const localRuby={async annotate(text){localCalls.push(text);return {annotations:[{start:0,end:3,surface:'日本語',reading:'にほんご'}],engine:'fixture',elapsedMs:1};},close(){}};
  const previous=process.env.AI_HTTP_CONCURRENCY;
  let instance;
  try {
    if(capacity!==undefined)process.env.AI_HTTP_CONCURRENCY=String(capacity);
    instance=createApp({dataDir,aiServices:service,localRuby,imageTaskOptions:{runnerOptions:{enabled:false}}});
  } finally {
    if(previous===undefined)delete process.env.AI_HTTP_CONCURRENCY;else process.env.AI_HTTP_CONCURRENCY=previous;
  }
  const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');
  const url=`http://127.0.0.1:${server.address().port}`,session=await ensureSession(url);
  t.after(async()=>{await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dataDir,{recursive:true,force:true});});
  const roles=Object.fromEntries(['ocr','correction','annotation','segmentation','chat'].map(role=>[role,{providerId:'api_base',model:'ruby',...(role==='annotation'&&reasoning?{reasoning}:{})}]));
  const response=await fetch(url+'/api/ai/roles',{method:'PUT',headers:{Cookie:session.cookie,'Content-Type':'application/json'},body:JSON.stringify({version:0,roles,annotationReferenceImage:false})});
  const saved=await response.json();assert.equal(response.status,200,JSON.stringify(saved));
  return {instance,calls,localCalls,owner:session.user.id,roles,async configured(){const response=await fetch(url+'/api/ai/roles',{headers:{Cookie:session.cookie}});return response.json();},
    async configure(input){const response=await fetch(url+'/api/ai/roles',{method:'PUT',headers:{Cookie:session.cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});const value=await response.json();assert.equal(response.status,200,JSON.stringify(value));return value;},
    disconnect(){connected=false;}};
}
const items=[{id:'source-range',bodyHtml:'<p data-paragraph-id="p">日本語。</p>'}];

test('source role results and parsing/provider failures preserve safe execution usage',async t=>{
  let mode='success';const usage={inputTokens:10,outputTokens:30,totalTokens:40,reasoningTokens:25,cachedInputTokens:0,raw:{authorization:'never-persist'}};
  const controls={usage,maxOutputTokens:32768,reasoningParameterSent:false,requestHeaders:'never-persist'};
  const f=await fixture(t,{run:async input=>{
    if(mode==='provider')throw Object.assign(new Error('provider failure'),{diagnostic:{code:'AI_INCOMPLETE_OUTPUT',category:'incomplete_output',finishReason:'length'},execution:controls});
    return {completed:mode!=='incomplete',model:input.model,text:mode==='json'?'{':JSON.stringify(mode==='value'?{text:123}:{text:'日本語。'}),...controls};
  }});
  const input={step:'correct',bodyHtml:'<p>日本語。</p>'},expected={inputTokens:10,outputTokens:30,totalTokens:40,reasoningTokens:25,cachedInputTokens:0};
  const successful=await f.instance.ai.processSource(f.owner,input);assert.deepEqual(successful.execution.usage,expected);
  for(mode of ['json','value','incomplete','provider'])await assert.rejects(f.instance.ai.processSource(f.owner,input),error=>{
    assert.deepEqual(error.execution.usage,expected,mode);assert.equal(error.execution.maxOutputTokens,32768);assert.equal(error.execution.reasoningParameterSent,false);
    assert.doesNotMatch(JSON.stringify(error.execution),/never-persist|requestHeaders|authorization|raw/);return true;
  });
});

test('混合注音在模型支持时默认快速查错，不改变保存的角色配置',async t=>{
  const f=await fixture(t);
  assert.equal(typeof f.instance.ai.annotateBodies,'function');
  const result=await f.instance.ai.annotateBodies(f.owner,{items,priority:'foreground'});
  assert.equal(f.localCalls.length,1);assert.equal(f.calls.length,1);
  assert.equal(f.calls[0].providerId,'api_base');assert.equal(f.calls[0].model,'ruby');
  assert.deepEqual(f.calls[0].reasoning,{effort:'none'});
  assert.deepEqual(result.execution.reasoning,{effort:'none'});
  assert.equal(result.execution.annotationMode,'proofread');
  assert.equal(bodyText(result.items[0].bodyHtml),'日本語。');
  assert.equal((await f.configured()).roles.annotation.reasoning,undefined);
});

test('混合注音尊重角色显式推理设置，不替换提供方',async t=>{
  const f=await fixture(t,{reasoning:{effort:'low'}});
  await f.instance.ai.annotateBodies(f.owner,{items});
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].providerId,'api_base');
  assert.deepEqual(f.calls[0].reasoning,{effort:'low'});
});

test('没有none能力的模型使用已配置默认，不发送不支持的快速参数',async t=>{
  const f=await fixture(t,{supportsNone:false});
  await f.instance.ai.annotateBodies(f.owner,{items});
  assert.equal(f.calls[0].reasoning,undefined);
});

test('本地候选准备独立于AI授权，复核才进入提供方授权检查',async t=>{
  const f=await fixture(t);f.disconnect();
  const prepared=await f.instance.ai.prepareAnnotationBodies(items);
  assert.equal(f.localCalls.length,1);assert.equal(f.calls.length,0);
  await assert.rejects(f.instance.ai.proofreadAnnotationBodies(f.owner,{prepared}),/连接|不可用|角色/);
  assert.equal(f.calls.length,0);
});

test('来源步骤区分排队和执行，operationId贯穿事件和结果',async t=>{
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{capacity:1,run:async(input,count)=>{if(count===1){entered();await gate;}return {completed:true,model:input.model,text:JSON.stringify({text:'日本語。'})};}});
  const firstEvents=[],secondEvents=[];
  const input={step:'correct',bodyHtml:'<p>日本語。</p>',source:{type:'plain_text'}};
  const first=f.instance.ai.processSource(f.owner,{...input,onStatus:event=>firstEvents.push(event)});
  await started;
  const second=f.instance.ai.processSource(f.owner,{...input,onStatus:event=>secondEvents.push(event)});
  try{
    assert.deepEqual(firstEvents.map(event=>event.state),['queued','running']);
    assert.deepEqual(secondEvents.map(event=>event.state),['queued']);
  }finally{release();}
  const results=await Promise.all([first,second]);
  assert.deepEqual(secondEvents.map(event=>event.state),['queued','running']);
  for(const [events,result] of [[firstEvents,results[0]],[secondEvents,results[1]]]){
    assert.equal(events[0].operationId,events[1].operationId);
    assert.equal(result.execution.operationId,events[0].operationId);
    assert.equal(events[1].role,'correction');assert.equal(events[1].providerId,'api_base');
    assert.equal(events[1].model,'ruby');assert.equal(events[1].configurationVersion,1);
    assert.ok(Date.parse(events[0].queuedAt));assert.ok(Date.parse(events[1].startedAt));
    assert.ok(events[1].queueMs>=0);assert.ok(result.execution.elapsedMs>=0);
    assert.equal(result.execution.queuedAt,events[0].queuedAt);
    assert.equal(result.execution.startedAt,events[1].startedAt);
    for(const metadata of [...events,result.execution]){
      assert.equal(metadata.retryCount,0,'没有限流时不应发生自动重试');
      assert.equal(metadata.retryWaitMs,0,'没有限流时不应记录退避等待');
    }
    assert.deepEqual(Object.keys(events[1]).sort(),['state','operationId','role','providerId','model','configurationVersion','queuedAt','startedAt','queueMs','elapsedMs','retryCount','retryWaitMs'].sort());
  }
  assert.notEqual(results[0].execution.operationId,results[1].execution.operationId);
});

test('来源步骤在调用及授权失败时保留安全诊断和执行身份',async t=>{
  const secret='sk-routing-private-key';
  const f=await fixture(t,{run:async()=>{throw new APICallError({message:secret,url:`https://example.invalid/${secret}`,requestBodyValues:{secret},statusCode:503,responseBody:secret,responseHeaders:{authorization:secret}});}});
  const events=[],input={step:'correct',bodyHtml:'<p>日本語。</p>',onStatus:event=>events.push(event)};
  await assert.rejects(f.instance.ai.processSource(f.owner,input),error=>{
    assert.equal(error.diagnostic.category,'upstream_http');assert.equal(error.diagnostic.httpStatus,503);
    assert.equal(error.execution.operationId,events[0].operationId);
    assert.equal(error.execution.operationId,events[1].operationId);
    assert.equal(error.execution.role,'correction');assert.equal(error.execution.providerId,'api_base');
    assert.doesNotMatch(JSON.stringify({diagnostic:error.diagnostic,execution:error.execution}),new RegExp(secret));return true;
  });
  f.disconnect();const authorizationEvents=[];
  await assert.rejects(f.instance.ai.processSource(f.owner,{...input,onStatus:event=>authorizationEvents.push(event)}),error=>{
    assert.equal(error.diagnostic.code,'AI_AUTH_REQUIRED');
    assert.equal(error.execution.operationId,authorizationEvents[0].operationId);
    assert.equal(error.execution.role,'correction');assert.equal(error.execution.model,'ruby');
    assert.equal(error.execution.startedAt,undefined);return true;
  });
  assert.deepEqual(authorizationEvents.map(event=>event.state),['queued']);
  assert.equal(f.calls.length,1);
});

test('状态回调失败不影响AI结果，JSON错误和未完成输出有独立诊断',async t=>{
  let response={completed:true,model:'ruby',text:JSON.stringify({text:'日本語。'})};
  const f=await fixture(t,{run:async()=>response});
  const input={step:'correct',bodyHtml:'<p>日本語。</p>',onStatus:()=>{throw new Error('closed observer');}};
  const result=await f.instance.ai.processSource(f.owner,input);assert.equal(result.text,'日本語。');
  response={completed:true,model:'ruby',text:'{'};
  await assert.rejects(f.instance.ai.processSource(f.owner,input),error=>error.diagnostic.category==='invalid_json'&&!!error.execution.operationId);
  response={completed:false,model:'ruby',text:'{}'};
  await assert.rejects(f.instance.ai.processSource(f.owner,input),error=>error.diagnostic.category==='incomplete_output'&&!!error.execution.operationId);
});

test('排队期间修改角色配置后，授权失败记录实际的新路线',async t=>{
  let release,entered;
  const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{capacity:1,run:async input=>{entered();await gate;return {completed:true,model:input.model,text:JSON.stringify({text:'日本語。'})};}});
  const input={step:'correct',bodyHtml:'<p>日本語。</p>'},events=[];
  const first=f.instance.ai.processSource(f.owner,input);await started;
  const second=f.instance.ai.processSource(f.owner,{...input,onStatus:event=>events.push(event)}).catch(error=>error);
  try{
    await new Promise(setImmediate);
    assert.deepEqual(events.map(event=>event.state),['queued']);
    assert.equal(f.calls.length,1,'唯一HTTP名额被占用时，第二步保持等待状态');
    await f.configure({version:1,roles:{...f.roles,correction:{providerId:'openai',model:'ruby'}},annotationReferenceImage:false});
    f.disconnect();
  }finally{release();}
  await first;const error=await second;
  assert.equal(events[0].providerId,'api_base');assert.equal(events[0].configurationVersion,1);
  assert.equal(error.diagnostic.code,'AI_AUTH_REQUIRED');assert.equal(error.execution.providerId,'openai');
  assert.equal(error.execution.configurationVersion,2);assert.equal(error.execution.operationId,events[0].operationId);
  assert.equal(error.execution.startedAt,undefined);assert.equal(f.calls.length,1);
});

test('照片来源识别也报告排队执行状态，失败时保留同一操作诊断',async t=>{
  let failure=false;
  const f=await fixture(t,{run:async input=>{
    if(failure)throw new APICallError({message:'private request body',url:'https://example.invalid',requestBodyValues:{},statusCode:503});
    return {completed:true,model:input.model,text:JSON.stringify({text:'日本語。'})};
  }});
  const pixels=await sharp({create:{width:4,height:6,channels:3,background:'white'}}).png().toBuffer();
  const image=await f.instance.ai.saveImage(f.owner,pixels,{mimeType:'image/png',originalName:'fixture.png'});
  const events=[],input={step:'extract',source:{type:'photo',original:{imageId:image.id}},onStatus:event=>events.push(event)};
  const result=await f.instance.ai.processSource(f.owner,input);
  assert.deepEqual(events.map(event=>event.state),['queued','running']);assert.equal(events[1].role,'ocr');
  assert.equal(result.execution.operationId,events[0].operationId);assert.equal(result.execution.operationId,events[1].operationId);
  assert.equal(bodyText(result.bodyHtml),'日本語。');
  failure=true;events.length=0;
  await assert.rejects(f.instance.ai.processSource(f.owner,input),error=>{
    assert.equal(error.diagnostic.category,'upstream_http');assert.equal(error.execution.operationId,events[0].operationId);return true;
  });
});
