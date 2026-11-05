import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSourceService} from '../server/sources.mjs';
import {blocksToHtml,bodyText,applySentenceBoundaries} from '../shared/article-html.mjs';
import {parseText} from '../shared/document.mjs';

function fixture(t,correct){
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT)');
  const text='日本語。',html=blocksToHtml(parseText(text));
  database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run('document','owner','文章','article','horizontal',JSON.stringify(parseText(text)),text,html,'hash',1,new Date(1000).toISOString(),new Date(1000).toISOString(),'[]',null,null);
  const service=createSourceService({database,now:()=>1000,requireDocument:(user,id)=>database.prepare('SELECT * FROM documents WHERE owner_id=? AND id=?').get(user,id),fromRow:row=>({id:row.id,bodyHtml:row.body_html}),ai:{processSource:async(user,input)=>{
    if(input.step==='correct')return correct(input);
    return {bodyHtml:input.step==='segment'?applySentenceBoundaries(input.bodyHtml,[bodyText(input.bodyHtml)]):input.bodyHtml};
  }}});
  t.after(()=>{service.close();database.close();});
  service.createArticleSources('owner','document',[{id:'source',type:'text',text}]);
  const start=async()=>{service.heartbeat('owner','document',{index:0});await service.drain();};
  const attempt=()=>database.prepare("SELECT state,execution_json FROM source_step_attempts WHERE step='correct'").get();
  return {database,service,start,attempt};
}

for(const failure of [false,true])test(`source attempts persist safe usage and request controls on ${failure?'failure':'success'}`,async t=>{
  const final={operationId:'operation',role:'correction',queueMs:12,elapsedMs:345,
    usage:{inputTokens:120,outputTokens:70,totalTokens:190,reasoningTokens:20,cachedInputTokens:0,raw:'private-usage'},
    maxOutputTokens:20000,reasoningParameterSent:true,reasoningEffort:'high',rawResponse:'private-response',headers:{authorization:'private-token'}};
  let pending;
  const f=fixture(t,async input=>{
    input.onStatus({state:'queued',queuedAt:new Date(1000).toISOString(),usage:{inputTokens:2,raw:'private-event'},maxOutputTokens:20000,reasoningParameterSent:true,reasoningEffort:'high',prompt:'private-prompt'});
    pending=JSON.parse(f.attempt().execution_json);
    if(failure)throw Object.assign(new Error('safe failure'),{execution:final});
    return {bodyHtml:input.bodyHtml,execution:final};
  });
  await f.start();
  const row=f.attempt(),execution=JSON.parse(row.execution_json);
  assert.deepEqual(pending.usage,{inputTokens:2});assert.equal(pending.maxOutputTokens,20000);
  assert.equal(row.state,failure?'failed':'completed');
  assert.deepEqual(execution.usage,{inputTokens:120,outputTokens:70,totalTokens:190,reasoningTokens:20,cachedInputTokens:0});
  assert.equal(execution.maxOutputTokens,20000);assert.equal(execution.reasoningParameterSent,true);assert.equal(execution.reasoningEffort,'high');
  assert.equal(execution.queueMs,12);assert.equal(execution.elapsedMs,345);
  assert.doesNotMatch(row.execution_json,/private-|authorization|rawResponse|prompt/);
});

test('source execution diagnostics omit missing or invalid usage instead of inventing zero values',async t=>{
  const f=fixture(t,async input=>({bodyHtml:input.bodyHtml,execution:{queueMs:0,elapsedMs:0,usage:{inputTokens:-1,outputTokens:1.2,totalTokens:'7',reasoningTokens:Number.MAX_SAFE_INTEGER+1,cachedInputTokens:null},maxOutputTokens:Infinity,reasoningParameterSent:'false',reasoningEffort:'private\nvalue',raw:'private-result'}}));
  await f.start();const execution=JSON.parse(f.attempt().execution_json);
  for(const key of ['usage','maxOutputTokens','reasoningParameterSent','reasoningEffort','raw'])assert.equal(Object.hasOwn(execution,key),false,key);
  assert.equal(execution.queueMs,0);assert.equal(execution.elapsedMs,0);
});
