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

const heldText = '旧い本文。';
const siblingText = '同じ本の次章。';
const nextText = '別の文章。';
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

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'yohaku-delete-rollback-'));
  const release = deferred(), lateReply = deferred(), corrections = [];
  let app, listener, database, disconnected = false;
  const upstream = createServer(async (request, response) => {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    const prompt = JSON.parse(raw).messages.at(-1).content;
    let value;
    if (prompt.includes('{"ok":true}')) value = { ok: true };
    else if (prompt.includes('\n目标正文：\n')) {
      const text = JSON.parse(prompt.split('\n目标正文：\n').at(-1));
      corrections.push(text);
      if (text === heldText) {
        response.once('close', () => { disconnected = !response.writableEnded; });
        await release.promise;
      }
      value = { edits: text === heldText ? [{ original: '旧い', replacement: '古い' }] : [] };
    } else if (prompt.includes('\n输入正文：\n')) {
      const text = JSON.parse(prompt.split('\n输入正文：\n').at(-1).split('\n')[0]);
      value = { sentences: text.match(/[^。]*。|[^。]+$/gu) || [] };
    } else value = { changes: [], uncertain: [] };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ model, choices: [{
      message: { role: 'assistant', content: JSON.stringify(value) }, finish_reason: 'stop',
    }] }));
    if (value.edits?.length) lateReply.resolve();
  });
  t.after(async () => {
    release.resolve();
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
  const provider = createAPIBaseConnection({ storageDir: dataDir,
    fetchImpl: (url, init) => fetch(`http://127.0.0.1:${upstream.address().port}${new URL(url).pathname}`, init),
  });
  await provider.configure({ apiKey: 'fixture-only-key' });
  assert.equal((await provider.testModel(model, { role: 'correction' })).passed, true);
  const concurrency = process.env.AI_HTTP_CONCURRENCY, timeout = process.env.AI_EXECUTION_TIMEOUT_MS;
  try {
    process.env.AI_HTTP_CONCURRENCY = '1';
    process.env.AI_EXECUTION_TIMEOUT_MS = '30000';
    app = createApp({ dataDir, aiServices: provider,
      localRuby: { async annotate() { return { annotations: [] }; }, close() {} },
      imageTaskOptions: { runnerOptions: { enabled: false } },
    });
  } finally {
    for (const [key, value] of [['AI_HTTP_CONCURRENCY', concurrency], ['AI_EXECUTION_TIMEOUT_MS', timeout]]) {
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
    const result = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, JSON.stringify(result));
    return result;
  }
  async function start(text, bookId) {
    const draft = await request('/imports', 'POST', { text, title: '削除テスト' }, 201);
    const { firstDocumentId: id } = await request(`/imports/${draft.id}/confirm`, 'POST', {
      type: 'text', ...(bookId ? { bookId } : {}),
    }, 201);
    const path = `/documents/${id}`;
    const { sources: [source] } = await request(`${path}/sources`);
    const { taskId } = await request(`${path}/reading-session`, 'POST', { active: true, index: 0 });
    return { id, path, taskId, source };
  }
  const attempt = article => database.prepare(`SELECT id, state, finished_at FROM source_step_attempts
    WHERE scope_id=? AND step='correct' AND input_version=? ORDER BY rowid DESC LIMIT 1`)
    .get(article.source.scopeId, article.source.version);
  const demand = article => database.prepare('SELECT * FROM source_preparation_jobs WHERE document_id=?').all(article.id);
  return { app, database, user, request, start, attempt, demand, corrections, release, lateReply,
    get disconnected() { return disconnected; } };
}

for (const target of ['document', 'book']) {
  test(`a rolled-back ${target} DELETE keeps the live correction and its queued work intact`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const held = await f.start(heldText);
    await until(() => f.corrections.includes(heldText), 'the held correction did not reach the provider');
    const active = f.attempt(held), demand = f.demand(held);
    assert.equal(active.state, 'running');
    let book = await f.request('/books', 'POST', { title: '削除回復', documentId: held.id }, 201);
    const sibling = await f.start(siblingText, book.id);
    await until(() => f.attempt(sibling)?.state === 'queued', 'the second chapter did not queue');
    book = await f.request(`/books/${book.id}`);
    const next = await f.start(nextText);
    await until(() => f.attempt(next)?.state === 'queued', 'the other document did not queue');
    const siblingAttempt = f.attempt(sibling);
    const beforeSource = await f.request(`${held.path}/sources/${held.source.id}`);
    const beforeRequest = f.database.prepare('SELECT * FROM source_preparation_requests WHERE document_id=?').all(held.id);

    // Both routes first remove source state in their transaction. Fail the
    // final native DELETE so those changes must roll back before cancellation.
    f.database.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON ${target === 'book' ? 'books' : 'documents'}
      BEGIN SELECT RAISE(ABORT, 'fixture rejected final delete'); END;`);
    try {
      const path = target === 'book' ? `/books/${book.id}` : held.path;
      const record = target === 'book' ? book : await f.request(held.path);
      await f.request(path, 'DELETE', { revision: record.revision }, 500);
    } finally {
      f.database.exec('DROP TRIGGER reject_delete');
    }
    await delay(100);
    assert.equal(f.disconnected, false, 'a rolled-back deletion must not abort the live HTTP correction');
    assert.deepEqual(f.attempt(held), active);
    assert.deepEqual(f.demand(held), demand);
    assert.deepEqual(f.database.prepare('SELECT * FROM source_preparation_requests WHERE document_id=?').all(held.id), beforeRequest);
    assert.deepEqual(await f.request(`${held.path}/sources/${held.source.id}`), beforeSource);
    assert.deepEqual(f.attempt(sibling), siblingAttempt);
    assert.deepEqual(f.corrections, [heldText], 'the only provider slot must still belong to the original correction');

    f.release.resolve();
    await f.lateReply.promise;
    await f.app.sources.drain();
    assert.equal(f.attempt(held).id, active.id, 'rollback must preserve the same provider attempt without restarting it');
    assert.equal(f.attempt(held).state, 'completed');
    assert.equal(f.corrections.filter(text => text === heldText).length, 1);
    assert.equal(bodyText((await f.request(`${held.path}/reading-pages`)).currentPage.bodyHtml), '古い本文。');
    assert.equal((await f.request(`${next.path}/reading-pages`)).currentPage?.ready, true);
    assert.equal((await f.request(`${sibling.path}/reading-pages`)).currentPage?.ready, true);
    assert.equal((await f.request(`/books/${book.id}`)).articleCount, 2);
  });
}

for (const target of ['document', 'book']) {
  test(`a committed ${target} DELETE releases its held slot, scopes queued work, and fences late results`, { timeout: 15000 }, async t => {
    const f = await fixture(t);
    const held = await f.start(heldText);
    await until(() => f.corrections.includes(heldText), 'the held correction did not reach the provider');
    let book = await f.request('/books', 'POST', { title: '削除成功', documentId: held.id }, 201);
    const sibling = await f.start(siblingText, book.id);
    await until(() => f.attempt(sibling)?.state === 'queued', 'the second chapter did not queue');
    book = await f.request(`/books/${book.id}`);
    const siblingAttempt = f.attempt(sibling);
    const next = await f.start(nextText);
    await until(() => f.attempt(next)?.state === 'queued', 'the unrelated document did not queue');
    const path = target === 'book' ? `/books/${book.id}` : held.path;
    const record = target === 'book' ? book : await f.request(held.path);
    await f.request(path, 'DELETE', { revision: record.revision }, 204);
    await until(() => f.disconnected, 'committed deletion did not abort the held HTTP request');
    await until(() => f.corrections.includes(nextText), 'committed deletion did not release the only provider slot');
    if (target === 'book') assert.equal(f.corrections.includes(siblingText), false, 'a deleted queued chapter must never reach the provider');
    assert.equal(f.attempt(held), undefined);
    if (target === 'book') assert.equal(f.attempt(sibling), undefined);

    // The controlled provider still emits its obsolete answer after the
    // socket is closed, exercising actual late-result fencing.
    f.release.resolve();
    await f.lateReply.promise;
    await f.app.sources.drain();
    for (const article of target === 'book' ? [held, sibling] : [held]) {
      await f.request(article.path, 'GET', undefined, 404);
      await f.request(`${article.path}/reading-pages`, 'GET', undefined, 404);
      for (const table of ['article_sources', 'reading_pages', 'reading_sessions', 'source_preparation_jobs']) {
        assert.equal(f.database.prepare(`SELECT count(*) AS n FROM ${table} WHERE document_id=?`).get(article.id).n, 0, table);
      }
      assert.equal(f.attempt(article), undefined);
      assert.ok(f.database.prepare('SELECT deleted_at FROM source_preparation_requests WHERE document_id=?').get(article.id).deleted_at);
      assert.ok(f.database.prepare('SELECT 1 FROM sources WHERE id=? AND owner_id=?').get(article.source.id, f.user.id), 'original source survives deletion');
    }
    if (target === 'book') await f.request(`/books/${book.id}`, 'GET', undefined, 404);
    else {
      assert.equal((await f.request(`/books/${book.id}`)).articleCount, 1);
      assert.equal((await f.request(`${sibling.path}/reading-pages`)).currentPage?.ready, true);
      assert.equal(f.attempt(sibling).id, siblingAttempt.id, 'deleting one chapter must preserve the queued sibling attempt');
      assert.equal(f.attempt(sibling).state, 'completed');
    }
    assert.equal((await f.request(`${next.path}/reading-pages`)).currentPage?.ready, true);
    assert.equal((await f.request(`/tasks/${next.taskId}`)).status, 'completed');
    assert.equal(f.corrections.length, target === 'book' ? 2 : 3);
    assert.deepEqual(new Set(f.corrections), new Set(target === 'book' ? [heldText, nextText] : [heldText, siblingText, nextText]));
  });
}
