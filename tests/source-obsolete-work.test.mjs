import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../server/app.mjs';
import { createAPIBaseConnection } from '../server/providers/api-base/index.mjs';
import { bodyText } from '../shared/article-html.mjs';
import { ROLE_IDS } from '../shared/ai-roles.mjs';
import { ensureSession } from './helpers/session.mjs';

const original = '旧い本文。';
const follower = '次の本文。';
const replacement = '手で直した文章。';
const model = 'codiX-agent';
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

async function until(check, message, timeout = 3000) {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value) return value;
    await delay(15);
  } while (performance.now() < deadline);
  assert.fail(message);
}

async function fixture(t, { holdSharedAnnotation = false, holdLocalText, rateLimitOriginal = false } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'yohaku-obsolete-source-'));
  const reply = deferred(), lateReply = deferred(), corrections = [], annotationBatches = [];
  let app, listener, database, localSignal, disconnected = false;
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const { messages } = JSON.parse(raw);
    const prompt = messages.at(-1).content;
    let value;
    if (prompt.includes('{"ok":true}')) value = { ok: true };
    else if (prompt.includes('\n目标正文：\n')) {
      const text = JSON.parse(prompt.split('\n目标正文：\n').at(-1));
      corrections.push(text);
      if (rateLimitOriginal && text === original && corrections.filter(value => value === original).length === 1) {
        response.writeHead(429, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'Controlled rate limit', type: 'rate_limit_error' } }));
        return;
      }
      if (text === original && !rateLimitOriginal) {
        response.once('close', () => { disconnected = !response.writableEnded; });
        await reply.promise;
      }
      value = { edits: text === original ? [{ original: '旧い', replacement: '古い' }] : [] };
    } else if (prompt.includes('\n输入正文：\n')) {
      const text = JSON.parse(prompt.split('\n输入正文：\n').at(-1).split('\n')[0]);
      value = { sentences: text.match(/[^。]*。|[^。]+$/gu) || [] };
    } else {
      const material = JSON.parse(prompt.split('\n资料：\n').at(-1));
      annotationBatches.push(material);
      if (holdSharedAnnotation && material.length > 1 && annotationBatches.length === 1) {
        response.once('close', () => { disconnected = !response.writableEnded; });
        await reply.promise;
      }
      value = { changes: [], uncertain: [] };
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model, choices: [{
      message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop',
    }] }));
    if (value.edits?.length) lateReply.resolve();
  });
  t.after(async () => {
    reply.resolve();
    await app?.shutdown();
    if (listener) {
      listener.closeAllConnections();
      await new Promise(resolve => listener.close(resolve));
    }
    if (upstream.listening) {
      upstream.closeAllConnections();
      await new Promise(resolve => upstream.close(resolve));
    }
    database?.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const provider = createAPIBaseConnection({
    storageDir: dataDir,
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init),
  });
  await provider.configure({ apiKey: 'fixture-only-key' });
  assert.equal((await provider.testModel(model, { role: 'correction' })).passed, true);
  const concurrency = process.env.AI_HTTP_CONCURRENCY;
  const timeout = process.env.AI_EXECUTION_TIMEOUT_MS;
  const retryDelay = process.env.AI_RATE_LIMIT_BACKOFF_MS;
  try {
    process.env.AI_HTTP_CONCURRENCY = '1';
    process.env.AI_EXECUTION_TIMEOUT_MS = '30000';
    if (rateLimitOriginal) process.env.AI_RATE_LIMIT_BACKOFF_MS = '1500';
    app = createApp({ dataDir, aiServices: provider, localRuby: {
      async annotate(text, { signal, onStatus } = {}) {
        if (text === holdLocalText) {
          localSignal = signal;
          onStatus?.({ state: 'running' });
          // A worker can return after its caller has canceled. A late
          // failure must not turn retired steps into failures.
          await reply.promise;
          throw new Error('late fixture annotation failure');
        }
        return { annotations: [] };
      },
      close() {},
    }, imageTaskOptions: { runnerOptions: { enabled: false } } });
  } finally {
    for (const [key, value] of [['AI_HTTP_CONCURRENCY', concurrency], ['AI_EXECUTION_TIMEOUT_MS', timeout], ['AI_RATE_LIMIT_BACKOFF_MS', retryDelay]]) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  listener = app.app.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const url = `http://127.0.0.1:${listener.address().port}`;
  const { cookie, user } = await ensureSession(url);
  database = new DatabaseSync(join(dataDir, 'yohaku.sqlite'));
  database.prepare('INSERT INTO ai_role_configurations VALUES(?,?,?,?)').run(user.id, 1, JSON.stringify({
    annotationReferenceImage: false,
    roles: Object.fromEntries(ROLE_IDS.map(role => [role, { providerId: 'api_base', model }])),
  }), new Date().toISOString());
  async function request(path, method = 'GET', input, status = 200) {
    const response = await fetch(`${url}/api${path}`, {
      method, headers: { Cookie: cookie, Connection: 'close',
        ...(input ? { 'Content-Type': 'application/json' } : {}) },
      ...(input ? { body: JSON.stringify(input) } : {}), signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function start(text) {
    const draft = await request('/imports', 'POST', { text, title: 'テスト資料' }, 201);
    const { firstDocumentId: id } = await request(`/imports/${draft.id}/confirm`, 'POST', { type: 'text' }, 201);
    const path = `/documents/${id}`;
    const { sources: [source] } = await request(`${path}/sources`);
    const { taskId } = await request(`${path}/reading-session`, 'POST', { active: true, index: 0 });
    return { id, path, taskId, source, sourcePath: `${path}/sources/${source.id}` };
  }
  const attempt = article => database.prepare(`SELECT id, state, finished_at FROM source_step_attempts
    WHERE scope_id=? AND step='correct' AND input_version=? ORDER BY rowid DESC LIMIT 1`)
    .get(article.source.scopeId, article.source.version);
  return { app, database, request, start, attempt, corrections, annotationBatches, reply, lateReply, user,
    get disconnected() { return disconnected; }, get localSignal() { return localSignal; } };
}

test('committed source edit releases the only provider slot and fences the obsolete correction', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const edited = await f.start(original);
  await until(() => f.corrections.includes(original), 'first correction did not reach the provider');
  assert.equal(f.attempt(edited).state, 'running');
  const next = await f.start(follower);
  await until(() => f.attempt(next)?.state === 'queued', 'the second chapter did not queue behind the held correction');
  assert.deepEqual(f.corrections, [original]);

  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version, text: replacement });
  await until(() => f.corrections.includes(follower), 'the committed edit did not free the held provider slot');
  await until(() => f.disconnected, 'the obsolete HTTP correction was not aborted');
  const stale = f.attempt(edited);
  assert.equal(stale.state, 'stale');
  assert.ok(stale.finished_at, 'the obsolete attempt must have a terminal timestamp');
  assert.equal(f.database.prepare("SELECT status FROM source_steps WHERE scope_id=? AND step='correct' AND input_version=?")
    .get(edited.source.scopeId, edited.source.version).status, 'stale');

  f.reply.resolve();
  await f.lateReply.promise;
  await f.app.sources.drain();
  const reading = await f.request(`${edited.path}/reading-pages`);
  assert.equal(reading.currentPage?.ready, true);
  assert.equal(bodyText(reading.currentPage.bodyHtml), replacement);
  assert.equal((await f.request(edited.sourcePath)).firstExtraction.text, original);
  assert.equal((await f.request(`${next.path}/reading-pages`)).currentPage?.ready, true);
  assert.deepEqual(f.attempt(edited), stale, 'the late reply cannot change the terminal attempt');
  const task = await f.request(`/tasks/${edited.taskId}`);
  assert.equal(task.status, 'completed');
  assert.equal(task.steps.some(step => ['queued', 'running', 'retry_wait', 'failed'].includes(step.status)), false);
});

test('a rejected or rolled-back source edit leaves the same live correction intact', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const edited = await f.start(original);
  await until(() => f.corrections.includes(original), 'first correction did not reach the provider');
  const active = f.attempt(edited);
  assert.equal(active.state, 'running');
  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version + 1, text: replacement }, 409);
  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version }, 400);
  assert.deepEqual(f.attempt(edited), active);

  // Abort the cache write after the source version and manual text have been
  // updated inside the savepoint, so the server must actually roll them back.
  f.database.exec(`CREATE TRIGGER fail_source_save BEFORE UPDATE OF body_html ON documents
    BEGIN SELECT RAISE(ABORT, 'fixture failed cache write'); END;`);
  try {
    await f.request(edited.sourcePath, 'PUT', { version: edited.source.version, text: replacement }, 500);
  } finally {
    f.database.exec('DROP TRIGGER fail_source_save');
  }
  const source = await f.request(edited.sourcePath);
  assert.equal(source.version, edited.source.version);
  assert.equal(source.text, original);
  assert.deepEqual(f.attempt(edited), active);
  assert.equal(f.disconnected, false);

  f.reply.resolve();
  await f.lateReply.promise;
  await f.app.sources.drain();
  const correction = f.attempt(edited);
  assert.equal(correction.id, active.id, 'the original provider call should finish without a restart');
  assert.equal(correction.state, 'completed');
  assert.deepEqual(f.corrections, [original]);
  const reading = await f.request(`${edited.path}/reading-pages`);
  assert.equal(reading.currentPage?.ready, true);
  assert.equal(bodyText(reading.currentPage.bodyHtml), '古い本文。');
});

test('editing a queued source removes its obsolete correction before it reaches the provider', { timeout: 15000 }, async t => {
  const f = await fixture(t);
  const active = await f.start(original);
  await until(() => f.corrections.includes(original), 'first correction did not reach the provider');
  const edited = await f.start(follower);
  await until(() => f.attempt(edited)?.state === 'queued', 'the correction to be edited did not queue');
  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version, text: replacement });
  const stale = await until(() => {
    const attempt = f.attempt(edited);
    return attempt?.state === 'stale' && attempt;
  }, 'the obsolete queued correction did not reach a terminal state');
  assert.ok(stale.finished_at);
  assert.equal(f.attempt(active).state, 'running');
  assert.equal(f.disconnected, false);

  f.reply.resolve();
  await f.app.sources.drain();
  assert.deepEqual(f.corrections, [original], 'the old queued text must never reach the provider');
  assert.equal(bodyText((await f.request(`${edited.path}/reading-pages`)).currentPage.bodyHtml), replacement);
  assert.deepEqual(f.attempt(edited), stale);
});

test('a committed edit cancels an obsolete 429 backoff without sending its scheduled retry', { timeout: 15000 }, async t => {
  const f = await fixture(t, { rateLimitOriginal: true });
  const edited = await f.start(original);
  await until(() => f.attempt(edited)?.state === 'retry_wait', 'the correction did not enter rate-limit backoff');
  const execution = JSON.parse(f.database.prepare('SELECT execution_json FROM source_step_attempts WHERE id=?')
    .get(f.attempt(edited).id).execution_json);
  const retryAt = Date.parse(execution.nextRetryAt);
  assert.ok(Number.isFinite(retryAt));
  assert.equal(execution.retryCount, 1);

  const next = await f.start(follower);
  await until(() => f.corrections.includes(follower), 'backoff kept the provider slot from another chapter');
  assert.equal(f.attempt(edited).state, 'retry_wait', 'the original retry should still be waiting before the edit');
  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version, text: replacement });
  const stale = f.attempt(edited);
  assert.equal(stale.state, 'stale');
  assert.ok(stale.finished_at);
  await f.app.sources.drain();
  await delay(Math.max(0, retryAt - Date.now()) + 75);

  assert.deepEqual(f.corrections, [original, follower], 'the obsolete retry must never reach the provider');
  assert.deepEqual(f.attempt(edited), stale, 'the expired backoff cannot reactivate its terminal attempt');
  assert.equal(bodyText((await f.request(`${edited.path}/reading-pages`)).currentPage.bodyHtml), replacement);
  assert.equal((await f.request(`${next.path}/reading-pages`)).currentPage?.ready, true);
  assert.equal((await f.request(`/tasks/${edited.taskId}`)).status, 'completed');
});

test('an edit to one source preserves the other member of a live shared annotation batch', { timeout: 15000 }, async t => {
  const f = await fixture(t, { holdSharedAnnotation: true });
  const { id } = await f.request('/documents', 'POST', {
    title: '共有注音', kind: 'article', orientation: 'horizontal', content: '準備中。',
  }, 201);
  const path = `/documents/${id}`;
  const texts = ['日本語。', '青空。'];
  f.app.sources.createArticleSources(f.user.id, id, texts.map((text, index) => ({
    id: `batch-source-${index}`, type: 'text_pdf', text, needsCorrection: false,
  })));
  const { sources: [edited, partner] } = await f.request(`${path}/sources`);
  await f.request(`${path}/reading-session`, 'POST', { active: true, index: 0 });
  await until(() => f.annotationBatches[0]?.length === 2, 'both sources did not reach the same provider batch');
  const attempt = source => f.database.prepare(`SELECT id,state,finished_at FROM source_step_attempts
    WHERE scope_id=? AND step LIKE 'annotate:%' AND input_version=? ORDER BY rowid DESC LIMIT 1`)
    .get(source.scopeId, source.version);
  const editedAttempt = attempt(edited), partnerAttempt = attempt(partner);
  assert.equal(editedAttempt?.state, 'running');
  assert.equal(partnerAttempt?.state, 'running');

  await f.request(`${path}/sources/${edited.id}`, 'PUT', { version: edited.version, text: 'あたらしい。' });
  assert.deepEqual(attempt(partner), partnerAttempt, 'the untouched source still needs its reserved result');
  assert.equal(f.disconnected, false);
  f.reply.resolve();
  await f.app.sources.drain();

  assert.equal(attempt(edited).id, editedAttempt.id);
  assert.equal(attempt(edited).state, 'stale');
  assert.equal(attempt(partner).id, partnerAttempt.id);
  assert.equal(attempt(partner).state, 'completed');
  assert.equal(f.annotationBatches.length, 1, 'the valid sibling must not be sent for proofreading again');
  const reading = await f.request(`${path}/reading-pages`);
  assert.equal(reading.currentPage?.ready, true);
  assert.equal(bodyText(reading.currentPage.bodyHtml), 'あたらしい。青空。');
});

test('a late local annotation failure cannot reactivate either retired annotation step', { timeout: 15000 }, async t => {
  const text = '本地注音の原文。';
  const f = await fixture(t, { holdLocalText: text });
  const edited = await f.start(text);
  await until(() => f.localSignal, 'the local annotation worker did not start');
  const steps = () => f.database.prepare(`SELECT step,status,error FROM source_steps
    WHERE scope_id=? AND input_version=? AND step LIKE 'annotate%' ORDER BY step`)
    .all(edited.source.scopeId, edited.source.version);
  const attempts = () => f.database.prepare(`SELECT step,state,finished_at,message FROM source_step_attempts
    WHERE scope_id=? AND input_version=? AND step LIKE 'annotate%' ORDER BY rowid`)
    .all(edited.source.scopeId, edited.source.version);
  assert.deepEqual(steps().map(step => step.status), ['running', 'running']);
  assert.equal(attempts().length, 1, 'only the local worker has started; its parent is reserved');
  assert.equal(attempts()[0].state, 'running');
  assert.equal(f.localSignal.aborted, false);

  const editedText = 'あたらしい。';
  await f.request(edited.sourcePath, 'PUT', { version: edited.source.version, text: editedText });
  assert.equal(f.localSignal.aborted, true);
  const staleSteps = steps(), staleAttempts = attempts();
  assert.deepEqual(staleSteps.map(step => step.status), ['stale', 'stale']);
  assert.equal(staleAttempts.length, 1);
  assert.equal(staleAttempts[0].state, 'stale');
  assert.ok(staleAttempts[0].finished_at);

  f.reply.resolve();
  await f.app.sources.drain();
  assert.deepEqual(steps(), staleSteps);
  assert.deepEqual(attempts(), staleAttempts);
  assert.equal(f.annotationBatches.length, 0);
  const reading = await f.request(`${edited.path}/reading-pages`);
  assert.equal(reading.currentPage?.ready, true);
  assert.equal(bodyText(reading.currentPage.bodyHtml), editedText);
  assert.equal((await f.request(`/tasks/${edited.taskId}`)).status, 'completed');
});
