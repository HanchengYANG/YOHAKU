import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { attachAIRoutes } from '../server/ai/routes.mjs';
import { createAPIBaseConnection } from '../server/providers/api-base/index.mjs';
import { ROLE_IDS } from '../shared/ai-roles.mjs';
import { createSourceService } from '../server/sources.mjs';
import { attachTaskRoutes } from '../server/tasks.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(t, { respond,responseUsage,responseFinishReason='stop', ...options } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'yohaku-rate-limit-'));
  const database = new DatabaseSync(':memory:');
  database.exec("CREATE TABLE users(id TEXT PRIMARY KEY,is_admin INTEGER,created_at TEXT);INSERT INTO users VALUES('u',1,'2026-01-01');");
  const calls = [];
  const cleanup = [];
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = input.messages.at(-1).content;
    if (prompt.includes('{"ok":true}')) {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{"ok":true}' }, finish_reason: 'stop' }] }));
      return;
    }
    const role = prompt.includes('\n目标正文：\n') ? 'correction' : prompt.includes('\n输入正文：\n') ? 'segmentation' : 'annotation';
    const text = role === 'correction' ? JSON.parse(prompt.split('\n目标正文：\n').at(-1))
      : role === 'segmentation' ? JSON.parse(prompt.split('\n输入正文：\n').at(-1).split('\n')[0]) : 'annotation';
    calls.push(text);
    const details = { text, calls, role, input };
    const status = await respond?.(details) || 200;
    const output = role === 'correction' ? { edits: [] } : role === 'segmentation' ? { sentences: text.match(/[^。]*。|[^。]+$/gu) || [] } : { changes: [], uncertain: [] };
    response.writeHead(status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(status === 200
      ? { model: 'controlled-http', choices: [{ message: { role: 'assistant', content: JSON.stringify(output) }, finish_reason: typeof responseFinishReason==='function'?responseFinishReason(role,details):responseFinishReason }],...(responseUsage?{usage:responseUsage}:{}) }
      : { error: { message: 'Controlled HTTP failure', type: 'rate_limit_error' } }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const provider = createAPIBaseConnection({ storageDir: directory,
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init),
  });
  await provider.configure({ apiKey: 'fixture-only-private-api-key' });
  assert.equal((await provider.testModel('codiX-agent', { role: 'correction' })).passed, true);
  const local = { close() {}, annotate() { throw new Error('Local annotation is not used by correction tests'); } };
  const app=express(),ai = attachAIRoutes({ app, database, storageDir: directory, services: provider,
    mangaOcr: local, ndlOcr: local, localRuby: local, ...options });
  database.prepare('INSERT INTO ai_role_configurations VALUES(?,?,?,?)').run('u', 1, JSON.stringify({
    annotationReferenceImage: false,
    roles: Object.fromEntries(ROLE_IDS.map(role => [role, { providerId: 'api_base', model: 'codiX-agent' }])),
  }), new Date().toISOString());
  t.after(async () => {
    for (const close of cleanup) await close();
    ai.close();
    await ai.whenIdle();
    const closed = new Promise(resolve => upstream.close(resolve));
    upstream.closeAllConnections();
    await closed;
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  return { ai, app,calls, database, cleanup, correct(text, input = {}) {
    return ai.processSource('u', { source: { id: text, type: 'text' }, step: 'correct',
      bodyHtml: `<p>${text}</p>`, groupKey: text, ...input });
  } };
}

test('HTTP 429 退避释放资源，其他章节先完成，退避不消耗执行超时', async t => {
  const waiting = deferred(), states = [];
  const f = await fixture(t, { httpConcurrency: 1, executionTimeoutMs: 200,
    sourceRetryDelayMs: 300, sourceRateLimitRetries: 2,
    respond: ({ text, calls }) => text === '第一章。' && calls.filter(item => item === text).length === 1 ? 429 : 200 });
  const first = f.correct('第一章。', { onStatus: event => { states.push(event); if (event.state === 'retry_wait') waiting.resolve(); } });
  await Promise.race([waiting.promise, first.then(() => assert.fail('Expected retry wait'))]);
  let idle = false;
  const allIdle = f.ai.whenIdle().then(() => { idle = true; });
  assert.equal(f.calls.length, 1);
  const second = await f.correct('第二章。');
  assert.equal(second.text, '第二章。');
  assert.deepEqual(f.calls, ['第一章。', '第二章。']);
  assert.equal(idle, false, '服务整体仍有等待重试的工作');
  const result = await first;
  await allIdle;
  assert.equal(result.text, '第一章。');
  assert.deepEqual(f.calls, ['第一章。', '第二章。', '第一章。']);
  assert.deepEqual(states.map(event => event.state), ['queued', 'running', 'retry_wait', 'queued', 'running']);
  assert.equal(states[2].retryCount, 1);
  assert.equal(states[2].retryDelayMs, 300);
  assert.ok(Date.parse(states[2].nextRetryAt));
  assert.equal(result.execution.retryCount, 1);
  assert.ok(result.execution.retryWaitMs >= 280);
  assert.ok(result.execution.elapsedMs < 200, '执行计时不应包含退避时间');
});

for(const scenario of ['successful source processing','length failure','screenshot recovery'])test(`real HTTP usage survives ${scenario} through unified task responses`,async t=>{
  const truncated=scenario==='length failure',recovers=scenario==='screenshot recovery',requests=[];
  const usage={prompt_tokens:12,completion_tokens:40,total_tokens:52,completion_tokens_details:{reasoning_tokens:35},prompt_tokens_details:{cached_tokens:4},rawResponse:'private-provider-response'};
  const f=await fixture(t,{responseUsage:usage,
    respond:({role,input})=>{if(role==='correction')requests.push(input);},
    responseFinishReason:role=>role==='correction'&&(truncated||recovers&&requests.length===1)?'length':'stop',
    localRuby:{close(){},async annotate(){return {annotations:[]};}}});
  f.database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);
    INSERT INTO documents VALUES('usage-article','u','用量文章','article','horizontal','[]','','<p></p>','',1,'2026-01-01','2026-01-01','[]',NULL,NULL);`);
  const sources=createSourceService({database:f.database,ai:f.ai,requireDocument:(user,id)=>f.database.prepare('SELECT * FROM documents WHERE owner_id=? AND id=?').get(user,id),fromRow:row=>({id:row.id,bodyHtml:row.body_html,blocks:JSON.parse(row.blocks_json),revision:row.revision})});
  f.cleanup.push(async()=>{sources.stop();await sources.drain();sources.close();});
  f.app.use(express.json());f.app.use((req,_res,next)=>{req.user={id:'u'};next();});
  attachTaskRoutes({app:f.app,database:f.database,adapters:[sources.taskAdapter]});
  const server=f.app.listen(0,'127.0.0.1');await once(server,'listening');f.cleanup.push(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  sources.createArticleSources('u','usage-article',[{id:'usage-source',type:recovers?'screenshot':'text',text:'日本語。'}]);
  const request=sources.heartbeat('u','usage-article',{index:0});await sources.drain();
  const response=await fetch(`http://127.0.0.1:${server.address().port}/api/tasks/${request.taskId}`),task=await response.json();assert.equal(response.status,200);
  const correction=task.steps.find(step=>step.step==='correct');
  assert.equal(correction.status,truncated?'failed':'completed');
  const count=recovers?2:1;
  assert.deepEqual(correction.execution.usage,{inputTokens:12*count,outputTokens:40*count,totalTokens:52*count,reasoningTokens:35*count,cachedInputTokens:4*count});
  assert.equal(correction.execution.maxOutputTokens,32768);assert.equal(correction.execution.reasoningParameterSent,false);
  if(truncated){assert.equal(correction.diagnostic.finishReason,'length');assert.equal(f.calls.length,1,'non-screenshot length failures remain explicit');}
  if(recovers){
    assert.equal(task.status,'completed');
    assert.equal(requests.length,2);
    assert.deepEqual(requests[1],requests[0],'the retry must use the same correction input and role controls');
    assert.equal(correction.execution.retryCount,1);
    assert.equal(correction.children.length,1);
    assert.ok(correction.execution.operationId);
    assert.equal(correction.children[0].execution.operationId,correction.execution.operationId);
    assert.equal(f.database.prepare("SELECT COUNT(*) AS count FROM source_step_attempts WHERE request_id=? AND step='correct'").get(request.taskId).count,1);
    assert.equal(sources.getSource('u','usage-article','usage-source').firstExtraction.text,'日本語。');
  }
  assert.doesNotMatch(JSON.stringify(task),/private-provider-response|fixture-only-private-api-key|rawResponse/);
});

test('截图校对连续两次被截断后停止自动重试',async t=>{
  const text='截断。',states=[];
  const f=await fixture(t,{responseFinishReason:'length'});
  await assert.rejects(f.correct(text,{source:{id:'screenshot',type:'screenshot'},onStatus:event=>states.push(event)}),error=>{
    assert.equal(error.diagnostic.code,'AI_INCOMPLETE_OUTPUT');
    assert.equal(error.diagnostic.finishReason,'length');
    assert.equal(error.execution.retryCount,1);
    assert.ok(error.execution.operationId);
    assert.equal(new Set([...states.map(event=>event.operationId),error.execution.operationId]).size,1);
    return true;
  });
  assert.deepEqual(f.calls,[text,text]);
});

test('截图校对截断后重新排队，已经等待的另一章节先执行',{timeout:8000},async t=>{
  const text='截图。',otherText='别章。',firstEntered=deferred(),firstReply=deferred(),otherQueued=deferred();
  const states=[];
  const f=await fixture(t,{httpConcurrency:1,executionTimeoutMs:3000,
    respond:async ({text:target,calls})=>{
      if(target===text&&calls.length===1){firstEntered.resolve();await firstReply.promise;}
    },
    responseFinishReason:(_role,{text:target,calls})=>target===text&&calls.length===1?'length':'stop'});
  const correction=f.correct(text,{source:{id:'screenshot',type:'screenshot'},onStatus:event=>states.push(event)});
  let other;
  try{
    await Promise.race([firstEntered.promise,correction.then(()=>assert.fail('expected the held first request'))]);
    other=f.correct(otherText,{onStatus:event=>{if(event.state==='queued')otherQueued.resolve();}});
    await otherQueued.promise;
    firstReply.resolve();
    assert.equal((await other).text,otherText);
    assert.equal((await correction).text,text);
    assert.deepEqual(f.calls,[text,otherText,text]);
    assert.deepEqual(states.map(event=>event.state),['queued','running','queued','running']);
  }finally{
    firstReply.resolve();
    await Promise.allSettled([correction,other]);
  }
});

test('截图校对重试只用剩余执行预算，超时释放执行位',{timeout:10000},async t=>{
  const text='截图。',otherText='别章。',retryEntered=deferred(),allowLateReply=deferred();
  let attempts=0,lateReply=false,otherRanBeforeLateReply=false;
  const f=await fixture(t,{httpConcurrency:1,executionTimeoutMs:1200,
    respond:async ({text:target})=>{
      if(target===otherText){otherRanBeforeLateReply=!lateReply;return;}
      if(++attempts===1){await delay(600);return;}
      retryEntered.resolve();
      let timer;
      await Promise.race([allowLateReply.promise,new Promise(resolve=>{timer=setTimeout(resolve,950);})]).finally(()=>clearTimeout(timer));
      lateReply=true;
    },
    responseFinishReason:(_role,{text:target})=>target===text&&attempts===1?'length':'stop'});
  const result=f.correct(text,{source:{id:'screenshot',type:'screenshot'}}).then(value=>({value}),error=>({error}));
  let other;
  try{
    const retried=await Promise.race([retryEntered.promise.then(()=>true),result.then(()=>false)]);
    assert.equal(retried,true,'the first length error must launch a retry');
    other=f.correct(otherText);
    const [{error},otherResult]=await Promise.all([result,other]);
    assert.equal(error?.diagnostic?.category,'timeout');
    assert.equal(error.execution.retryCount,1);
    assert.equal(otherResult.text,otherText);
    assert.equal(otherRanBeforeLateReply,true);
    assert.deepEqual(f.calls,[text,text,otherText]);
  }finally{
    allowLateReply.resolve();
    await Promise.allSettled([result,other]);
  }
});

test('HTTP 429 自动重试有界，非 429 错误不自动重试', async t => {
  const states = [];
  const f = await fixture(t, { sourceRetryDelayMs: 5, sourceRateLimitRetries: 2,
    respond: ({ text }) => text === '限流。' ? 429 : 500 });
  await assert.rejects(f.correct('限流。', { onStatus: event => states.push(event) }), error => {
    assert.equal(error.status, 429);
    assert.equal(error.diagnostic.category, 'rate_limit');
    assert.equal(error.execution.retryCount, 2);
    return true;
  });
  assert.equal(f.calls.length, 3);
  assert.equal(states.filter(event => event.state === 'retry_wait').length, 2);
  await assert.rejects(f.correct('失败。'));
  assert.equal(f.calls.filter(text => text === '失败。').length, 1);
});

test('429 自动重试可显式设为零', async t => {
  const f = await fixture(t, { sourceRateLimitRetries: 0, respond: () => 429 });
  await assert.rejects(f.correct('关闭重试。'), error => error.status === 429 && error.execution.retryCount === 0);
  assert.equal(f.calls.length, 1);
});

test('取消或停止会中止 429 退避，不能发起迟到请求', async t => {
  const f = await fixture(t, { sourceRetryDelayMs: 40, respond: () => 429 });
  const abort = new AbortController();
  await assert.rejects(f.correct('取消。', { signal: abort.signal,
    onStatus: event => { if (event.state === 'retry_wait') abort.abort(); } }), error => error.name === 'AbortError');
  await delay(60);
  assert.equal(f.calls.length, 1);
  await assert.rejects(f.correct('停止。', {
    onStatus: event => { if (event.state === 'retry_wait') f.ai.close(); } }), error => error.code === 'AI_STOPPED');
  await f.ai.whenIdle();
  await delay(60);
  assert.equal(f.calls.length, 2);
});

test('原生正文任务记录自动退避，等待时删除返回 409，结束后删除不复活', async t => {
  const waiting = deferred();
  const f = await fixture(t, { sourceRetryDelayMs: 25, respond: () => 429 });
  f.database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);
    INSERT INTO documents VALUES('article','u','限流文章','article','horizontal','[]','','<p></p>','',1,'2026-01-01','2026-01-01','[]',NULL,NULL);`);
  const sources = createSourceService({ database: f.database,
    ai: { ...f.ai, processSource: (user, input) => f.ai.processSource(user, { ...input,
      onStatus: event => { input.onStatus?.(event); if (event.state === 'retry_wait') waiting.resolve(); } }) },
    requireDocument: (user, id) => {
      const row = f.database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id, user);
      if (!row) throw Object.assign(new Error('missing document'), { status: 404 });
      return row;
    }, fromRow: row => ({ id: row.id, bodyHtml: row.body_html, blocks: JSON.parse(row.blocks_json), revision: row.revision }),
  });
  f.cleanup.push(async () => { sources.stop(); await sources.drain(); sources.close(); });
  sources.createArticleSources('u', 'article', [{ id: 'limited-source', type: 'text_pdf', text: '限流。' }]);
  const request = sources.heartbeat('u', 'article', { index: 0 });
  await waiting.promise;
  const task = sources.taskAdapter.get('u', request.taskId);
  const correction = task.steps.find(step => step.step === 'correct');
  assert.equal(correction.status, 'retry_wait');
  assert.equal(correction.execution.retryCount, 1);
  assert.equal(correction.execution.retryDelayMs, 25);
  assert.ok(Date.parse(correction.execution.nextRetryAt));
  assert.equal(task.canDelete, false);
  assert.equal(task.canRetry, false);
  assert.throws(() => sources.taskAdapter.delete('u', task.id, { version: task.version }), error => error.status === 409);
  await sources.drain();
  assert.equal(f.calls.length, 3);
  const failed = sources.taskAdapter.get('u', task.id);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.canDelete, true);
  sources.taskAdapter.delete('u', failed.id, { version: failed.version });
  sources.heartbeat('u', 'article', { index: 0 });
  await sources.drain();
  assert.equal(sources.taskAdapter.list('u').length, 0);
  assert.equal(f.calls.length, 3);
  assert.equal(sources.getSource('u', 'article', 'limited-source').text, '限流。');
});

test('真实 HTTP 链路中短 PDF 页的分句和注音同时执行，仍遵守同章两个名额', async t => {
  const segmentEntered = deferred(), annotationEntered = deferred(), segmentGate = deferred(), annotationGate = deferred();
  let active = 0, maximum = 0, heldSegment = false, heldAnnotation = false;
  const f = await fixture(t, { httpConcurrency: 4, localRuby: { close() {},
    async annotate(text) { return { annotations: [{ start: 0, end: 3, surface: text.slice(0, 3), reading: 'にほんご' }] }; },
  }, respond: async ({ role }) => {
    active++; maximum = Math.max(maximum, active);
    try {
      if (role === 'segmentation' && !heldSegment) { heldSegment = true; segmentEntered.resolve(); await segmentGate.promise; }
      if (role === 'annotation' && !heldAnnotation) { heldAnnotation = true; annotationEntered.resolve(); await annotationGate.promise; }
      return 200;
    } finally { active--; }
  } });
  f.database.exec(`CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,kind TEXT,orientation TEXT,blocks_json TEXT,plain_text TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,created_at TEXT,updated_at TEXT,source_images_json TEXT,source_image_id TEXT,recognition_json TEXT);
    INSERT INTO documents VALUES('short-pdf','u','短页PDF','article','horizontal','[]','','<p></p>','',1,'2026-01-01','2026-01-01','[]',NULL,NULL);`);
  const sources = createSourceService({ database: f.database, ai: f.ai,
    requireDocument: (user, id) => f.database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(id, user),
    fromRow: row => ({ id: row.id, bodyHtml: row.body_html, blocks: JSON.parse(row.blocks_json), revision: row.revision }),
  });
  f.cleanup.push(async () => { sources.stop(); segmentGate.resolve(); annotationGate.resolve(); await sources.drain(); sources.close(); });
  const texts = Array.from({ length: 6 }, () => '日本語' + 'あ'.repeat(296) + '。');
  sources.createArticleSources('u', 'short-pdf', texts.map((text, index) => ({ id: `short-${index}`, type: 'scan_pdf', text })));
  sources.heartbeat('u', 'short-pdf', { index: 0 });
  let timer;
  await Promise.race([Promise.all([segmentEntered.promise, annotationEntered.promise]),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('短页分句和注音未能重叠')), 2000); }),
  ]).finally(() => clearTimeout(timer));
  assert.equal(active, 2);
  assert.equal(maximum, 2);
  assert.equal(sources.readingPages('u', 'short-pdf', 0).currentPage, null);
  segmentGate.resolve(); annotationGate.resolve(); await sources.drain();
  const reading = sources.readingPages('u', 'short-pdf', 0);
  assert.equal(reading.currentPage.ready, true);
  assert.ok(maximum <= 2);
  assert.ok(reading.currentPage.bodyHtml.includes('<rt>にほんご</rt>'));
});
