import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import { attachAIRoutes } from '../server/ai/routes.mjs';
import { createAPIBaseConnection } from '../server/providers/api-base/index.mjs';
import { ROLE_IDS } from '../shared/ai-roles.mjs';
import { bodyText, bodyRanges, initializeSentenceBoundaries } from '../shared/article-html.mjs';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('正文和新问答、续问共享同篇文章的两个 HTTP 名额，其他章节独立推进', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'yohaku-article-limits-'));
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,is_admin INTEGER,created_at TEXT);
    INSERT INTO users VALUES('u',1,'2026-01-01');
    CREATE TABLE documents(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,blocks_json TEXT,body_html TEXT,body_hash TEXT,revision INTEGER,updated_at TEXT);`);
  const html = initializeSentenceBoundaries('<p>日本語。</p>', ['日本語。']);
  const hash = createHash('sha256').update(bodyText(html)).digest('hex');
  database.prepare('INSERT INTO documents VALUES(?,?,?,?,?,?,?,?)').run('chapter', 'u', '测试章节', '[]', html, hash, 1, new Date().toISOString());
  const sourceEntered = [], calls = [], jobs = [];
  let arrived = deferred(), server, ai;
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const input = JSON.parse(raw), prompt = input.messages.at(-1).content;
    if (input.stream) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      return;
    }
    const isTest = prompt.includes('{"ok":true}'), isSource = prompt.includes('\n目标正文：\n');
    const text = isTest ? null : isSource ? JSON.parse(prompt.split('\n目标正文：\n').at(-1)) : '问答';
    if (!isTest) calls.push(text);
    if (isSource && text !== '別章。') {
      const gate = deferred(); sourceEntered.push(gate); await gate.promise;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model: 'controlled-http', choices: [{ message: { role: 'assistant',
      content: isTest ? '{"ok":true}' : isSource ? JSON.stringify({ text }) : '测试解释。' }, finish_reason: 'stop' }] }));
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  t.after(async () => {
    sourceEntered.forEach(gate => gate.resolve());
    ai?.close();
    await Promise.allSettled(jobs);
    await ai?.whenIdle();
    for (const listener of [server, upstream].filter(Boolean)) {
      const closed = new Promise(resolve => listener.close(resolve)); listener.closeAllConnections(); await closed;
    }
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  const provider = createAPIBaseConnection({ storageDir: directory,
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init),
  });
  await provider.configure({ apiKey: 'fixture-only-private-api-key' });
  for (const role of ['correction', 'chat']) assert.equal((await provider.testModel('codiX-agent', { role })).passed, true);
  const app = express();
  app.use(express.json());
  app.use((request, _response, next) => { request.user = { id: 'u' }; if (request.method === 'POST') arrived.resolve(); next(); });
  const local = { close() {}, annotate() {} };
  ai = attachAIRoutes({ app, database, storageDir: directory, services: provider, httpConcurrency: 4,
    mangaOcr: local, ndlOcr: local, localRuby: local });
  database.prepare('INSERT INTO ai_role_configurations VALUES(?,?,?,?)').run('u', 1, JSON.stringify({
    annotationReferenceImage: false,
    roles: Object.fromEntries(ROLE_IDS.map(role => [role, { providerId: 'api_base', model: 'codiX-agent' }])),
  }), new Date().toISOString());
  app.use((error, _request, response, _next) => response.status(error.status || 500).json({ error: error.message }));
  server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const correct = (text, documentId = 'chapter') => {
    const promise = ai.processSource('u', { source: { id: text, type: 'text' }, step: 'correct',
      bodyHtml: `<p>${text}</p>`, groupKey: JSON.stringify(['u', documentId]) });
    jobs.push(promise); return promise;
  };
  const waitForSources = async count => {
    const deadline = Date.now() + 2000;
    while (sourceEntered.length < count && Date.now() < deadline) await new Promise(setImmediate);
    assert.equal(sourceEntered.length, count);
  };
  async function whileBodyBusy(path, body, phase) {
    const before = sourceEntered.length, chatCalls = calls.filter(item => item === '问答').length;
    const first = correct(`${phase}一。`), second = correct(`${phase}二。`);
    await waitForSources(before + 2);
    arrived = deferred();
    let chatFinished = false;
    const question = fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(async response => { chatFinished = true; return { status: response.status, data: await response.json() }; });
    jobs.push(question);
    await arrived.promise;
    assert.equal((await correct('別章。', 'other-chapter')).text, '別章。');
    await new Promise(resolve => setTimeout(resolve, 40));
    assert.equal(calls.filter(item => item === '问答').length, chatCalls, '同章两个正文请求执行时，问答必须等待名额');
    assert.equal(chatFinished, false);
    sourceEntered[before].resolve(); await first;
    const result = await question;
    assert.ok([200, 201].includes(result.status), JSON.stringify(result.data));
    assert.equal(calls.filter(item => item === '问答').length, chatCalls + 1);
    sourceEntered[before + 1].resolve(); await second;
    return result.data;
  }
  const conversation = await whileBodyBusy('/api/documents/chapter/conversations', { question: '解释这个词',
    selection: { start: 0, end: 3, text: '日本語', bodyHash: hash, sentenceIds: bodyRanges(html).sentences.map(item => item.id) } }, '初问');
  const continued = await whileBodyBusy(`/api/conversations/${conversation.id}/messages`,
    { question: '再解释一下', groupId: conversation.groups[0].id }, '续问');
  assert.equal(continued.messages.length, 4);
});
