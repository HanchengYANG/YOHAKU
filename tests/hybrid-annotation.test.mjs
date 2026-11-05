import test from 'node:test';
import assert from 'node:assert/strict';
import { bodyText, bodyRanges, htmlToBlocks, normalizeBodyHtml } from '../shared/article-html.mjs';
import { createHybridAnnotation } from '../server/ai/hybrid-annotation.mjs';

const html = (text, id = 'p') => `<p data-paragraph-id="${id}">${text}</p>`;
const readings = (bodyHtml) => htmlToBlocks(bodyHtml).flatMap((b) => b.segments.filter((s) => s.reading));
const han = (text, choose) => [...text.matchAll(/[\p{Script=Han}〆]+/gu)].flatMap((m) => {
  const reading = choose(m[0], m.index);
  return reading === undefined ? [] : [{ start: m.index, end: m.index + m[0].length, surface: m[0], reading }];
});
function create(options = {}) {
  return createHybridAnnotation({ localRuby: { annotate: async () => ({ annotations: [] }) },
    execute: async () => ({ value: { changes: [], uncertain: [] } }), ...options });
}
const targetsIn = (prompt) => [...prompt.matchAll(/\[(\d+)\|([^|]+)\|([^\]]+)\]/g)].map((m) => ({ id: Number(m[1]), surface: m[2], reading: m[3] }));

test('全文复核本地候选，按语境纠正十分且每次出现有独立 ID', async () => {
  const calls = [], bodyHtml = html('十分かけて、十分な準備をした。'),onStatus=()=>{};
  const service = create({ localRuby: { annotate: async (text) => ({ annotations: han(text, (s) => s === '十分' ? 'じゅうぶん' : 'じゅんび'), engine: 'test' }) },
    execute: async (userId, role, input) => {
      calls.push({ userId, role, input });
      const spans = targetsIn(input.prompt);
      assert.deepEqual(spans.map((s) => s.surface), ['十分', '十分', '準備']);
      assert.equal(new Set(spans.map((s) => s.id)).size, 3);
      assert.match(input.prompt, /かけて、/);
      assert.match(input.prompt, /な/);
      return { value: { changes: [{ id: spans[0].id, r: 'じゅっぷん' }], uncertain: [] }, execution: { model: 'deepseek' } };
    } });
  const result = await service.annotateBodies('u', { items: [{ id: 'one', bodyHtml }], priority: 'background', context: { before: '前文。', after: '後文。' },onStatus });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].userId, 'u');
  assert.equal(calls[0].role, 'annotation');
  assert.equal(calls[0].input.annotationMode, 'proofread');
  assert.equal(calls[0].input.priority, 'background');
  assert.equal(calls[0].input.onStatus,onStatus);
  assert.match(calls[0].input.prompt, /前文。/);
  assert.deepEqual(readings(result.items[0].bodyHtml).map((s) => s.reading), ['じゅっぷん', 'じゅうぶん', 'じゅんび']);
  assert.equal(bodyText(result.items[0].bodyHtml), bodyText(bodyHtml));
  assert.equal(result.metrics.llmCalls, 1);
  assert.equal(result.metrics.reviewedSpans, 3);
  assert.equal(result.metrics.corrections, 1);
  assert.deepEqual(result.execution, { model: 'deepseek' });
});

test('食べる只给食注音，完整句子和外部送假名保留', async () => {
  const service = create({ localRuby: { annotate: async (text) => ({ annotations: han(text, () => 'しょく') }) },
    execute: async (_u, _r, input) => {
      assert.match(input.prompt, /\[0\|食\|しょく\]べる。/);
      return { value: { changes: [{ id: 0, r: 'た' }], uncertain: [] } };
    } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('食べる。') }] });
  assert.deepEqual(readings(result.items[0].bodyHtml).map(({ text, reading }) => ({ text, reading })), [{ text: '食', reading: 'た' }]);
  assert.equal(bodyText(result.items[0].bodyHtml), '食べる。');
});

test('本地漏注音仍交给全文复核，人名可不猜并标为不确定', async () => {
  const service = create({ execute: async (_u, _r, input) => {
    const spans = targetsIn(input.prompt);
    assert.deepEqual(spans.map((s) => [s.surface, s.reading]), [['小鳥遊', '?'], ['四月一日', '?'], ['食', '?']]);
    return { value: { changes: [{ id: spans[2].id, r: 'た' }], uncertain: [spans[0].id, spans[1].id] } };
  } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('小鳥遊と四月一日が食べる。') }] });
  assert.deepEqual(result.items[0].uncertain.map((t) => t.surface), ['小鳥遊', '四月一日']);
  assert.equal(result.metrics.missingReadings, 2);
  assert.equal(result.metrics.uncertain, 2);
  assert.deepEqual(readings(result.items[0].bodyHtml).map((s) => s.reading), ['た']);
});

test('多个 HTML item合并一次全文调用，本地快照可持久化与重组复用', async () => {
  let localCalls = 0, llmCalls = 0;
  const service = create({ localRuby: { annotate: async (text) => { localCalls++; return { annotations: han(text, () => 'にほん') }; } },
    execute: async (_u, _r, input) => { llmCalls++; assert.match(input.prompt, /ひとつめ/); assert.match(input.prompt, /ふたつめ/); assert.equal(targetsIn(input.prompt).length, 2); return { value: { changes: [], uncertain: [] } }; } });
  const first = await service.prepareBodies([{ id: 'a', bodyHtml: html('ひとつめは日本。', 'a') }]);
  const second = await service.prepareBodies([{ id: 'b', bodyHtml: html('ふたつめも日本。', 'b') }]);
  const prepared = JSON.parse(JSON.stringify({ items: [...first.items, ...second.items], metrics: { reusedLocalItems: 2 } }));
  const result = await service.proofreadPrepared('u', { prepared });
  assert.equal(localCalls, 2);
  assert.equal(llmCalls, 1);
  assert.deepEqual(result.items.map((item) => item.id), ['a', 'b']);
  assert.equal(result.metrics.reusedLocalItems, 2);
});

test('保护人工与来源音、段落ID、句界及重叠QA，已有generated仍复核', async () => {
  const bodyHtml = '<p data-paragraph-id="p1" data-block-type="heading"><span data-sentence-id="s1"><span data-source-image-id="photo"><ruby data-origin="manual">眞人<rt>まひと</rt></ruby>と<ruby data-origin="source">東京<rt>とうきょう</rt></ruby>で<mark data-qa-group-ids="qa1"><ruby data-origin="generated">十分<rt>じゅうぶん</rt></ruby></mark>ほど<mark data-qa-group-ids="qa1 qa2">待つ</mark>。</span></span><br><span data-sentence-id="s2">食べる。</span></p><p data-paragraph-id="p2"><span data-sentence-id="s3">かな。</span></p>';
  const original = normalizeBodyHtml(bodyHtml);
  const service = create({ localRuby: { annotate: async (text) => ({ annotations: han(text, () => 'あ') }) },
    execute: async (_u, _r, input) => {
      const spans = targetsIn(input.prompt);
      assert.deepEqual(spans.map((s) => s.surface), ['十分', '待', '食']);
      assert.equal(spans[0].reading, 'じゅうぶん');
      return { value: { changes: [{ id: spans[0].id, r: 'じゅっぷん' }], uncertain: [] } };
    } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml }] });
  assert.equal(bodyText(result.items[0].bodyHtml), bodyText(original));
  assert.deepEqual(bodyRanges(result.items[0].bodyHtml), bodyRanges(original));
  assert.match(result.items[0].bodyHtml, /data-paragraph-id="p1" data-block-type="heading"/);
  assert.match(result.items[0].bodyHtml, /data-paragraph-id="p2"/);
  assert.deepEqual(readings(result.items[0].bodyHtml).slice(0, 2).map(({ text, reading, origin }) => ({ text, reading, origin })), [
    { text: '眞人', reading: 'まひと', origin: 'manual' }, { text: '東京', reading: 'とうきょう', origin: 'source' },
  ]);
});

test('UTF16偏移保留表情和扩展汉字，连续Han合并本地分片', async () => {
  const bodyHtml = html('😀𠮷野家と𰻞を食べる。');
  const annotations = [
    { start: 2, end: 4, surface: '𠮷', reading: 'よし' }, { start: 4, end: 6, surface: '野家', reading: 'のや' },
    { start: 7, end: 9, surface: '𰻞', reading: 'びゃん' }, { start: 10, end: 11, surface: '食', reading: 'しょく' },
  ];
  const service = create({ localRuby: { annotate: async () => ({ annotations }) }, execute: async (_u, _r, input) => {
    const spans = targetsIn(input.prompt);
    assert.deepEqual(spans.map((s) => [s.surface, s.reading]), [['𠮷野家', 'よしのや'], ['𰻞', 'びゃん'], ['食', 'しょく']]);
    return { value: { changes: [{ id: spans[2].id, r: 'た' }], uncertain: [] } };
  } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml }] });
  assert.equal(bodyText(result.items[0].bodyHtml), '😀𠮷野家と𰻞を食べる。');
  assert.deepEqual(readings(result.items[0].bodyHtml).map((s) => s.text), ['𠮷野家', '𰻞', '食']);
});

test('保留原generated整词读音，修改时按唯一假名锚点只投影汉字', async () => {
  const bodyHtml = html('<ruby data-origin="generated">食べる<rt>たべる</rt></ruby>。');
  const service = create({ execute: async (_u, _r, input) => {
    assert.match(input.prompt, /\[0\|食\|た\]べる。/);
    return { value: { changes: [], uncertain: [] } };
  } });
  const prepared = await service.prepareBodies([{ id: 'a', bodyHtml }]);
  assert.equal(prepared.items[0].bodyHtml, normalizeBodyHtml(bodyHtml));
  const result = await service.proofreadPrepared('u', { prepared });
  assert.equal(result.items[0].bodyHtml, normalizeBodyHtml(bodyHtml));
});

test('纯假名或全部受保护的正文零LLM调用', async () => {
  let calls = 0;
  const service = create({ localRuby: { annotate: async () => { calls++; return { annotations: [] }; } }, execute: async () => { calls++; throw Error('unexpected'); } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('かな。') }, { id: 'b', bodyHtml: html('<ruby data-origin="source">東京<rt>とうきょう</rt></ruby>', 'p2') }] });
  assert.equal(calls, 0);
  assert.equal(result.execution, null);
  assert.equal(result.metrics.llmCalls, 0);
});

test('畸形、重复、越界、正文改写和非假名响应整批拒绝，不改变快照', async () => {
  const invalid = [null, {}, { changes: [], uncertain: [], text: '改正文' },
    { changes: [{ id: 9, r: 'た' }], uncertain: [] }, { changes: [{ id: -1, r: 'た' }], uncertain: [] },
    { changes: [{ id: '0', r: 'た' }], uncertain: [] },
    { changes: [{ id: 0, r: 'た' }, { id: 0, r: 'た' }], uncertain: [] },
    { changes: [{ id: 0, r: 'た' }], uncertain: [0] }, { changes: [], uncertain: [0, 0] },
    { changes: [], uncertain: [999] }, { changes: [{ id: 0, r: '食' }], uncertain: [] },
    { changes: [{ id: 0, r: '' }], uncertain: [] }, { changes: [{ id: 0, r: 'た', text: '食べる' }], uncertain: [] },
  ];
  for (const value of invalid) {
    const service = create({ execute: async () => ({ value }) });
    const prepared = await service.prepareBodies([{ id: 'a', bodyHtml: html('食べる。') }]);
    const before = JSON.stringify(prepared);
    await assert.rejects(service.proofreadPrepared('u', { prepared }), (error) => error.status === 502);
    assert.equal(JSON.stringify(prepared), before);
  }
});

test('本地重叠、错字或坏偏移拒绝且不会调用LLM', async () => {
  for (const annotations of [
    [{ start: 0, end: 1, surface: '食', reading: 'た' }, { start: 0, end: 1, surface: '食', reading: 'た' }],
    [{ start: 0, end: 1, surface: '飲', reading: 'の' }],
    [{ start: -1, end: 1, surface: '食', reading: 'た' }],
    [{ start: 0, end: 1, surface: '食', reading: '食' }],
  ]) {
    let calls = 0;
    const service = create({ localRuby: { annotate: async () => ({ annotations }) }, execute: async () => { calls++; } });
    await assert.rejects(service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('食べる。') }] }));
    assert.equal(calls, 0);
  }
});

test('后批次失败不返回先前批次已修改结果，也不改变本地持久化快照', async () => {
  let calls = 0;
  const service = create({ execute: async (_u, _r, input) => {
    calls++;
    const spans = targetsIn(input.prompt);
    return { value: { changes: [{ id: calls === 1 ? spans[0].id : 999999, r: 'た' }], uncertain: [] } };
  } });
  const prepared = await service.prepareBodies([
    { id: 'a', bodyHtml: html('あ'.repeat(700) + '食べる。', 'a') },
    { id: 'b', bodyHtml: html('い'.repeat(700) + '食べる。', 'b') },
  ]);
  const before = JSON.stringify(prepared);
  await assert.rejects(service.proofreadPrepared('u', { prepared }));
  assert.equal(calls, 2);
  assert.equal(JSON.stringify(prepared), before);
});

test('1200字阅读页及跨来源阅读页均只查错一次', async () => {
  const sentence = 'あ'.repeat(598) + '食。';
  for (const items of [[{ id: 'a', bodyHtml: html(sentence.repeat(2)) }], [
    { id: 'a', bodyHtml: html(sentence, 'a') }, { id: 'b', bodyHtml: html(sentence, 'b') },
  ]]) {
    let calls = 0;
    const service = create({ execute: async () => { calls++; return { value: { changes: [], uncertain: [] } }; } });
    const result = await service.annotateBodies('u', { items });
    assert.equal(calls, 1);
    assert.equal(result.metrics.llmCalls, 1);
    assert.deepEqual(result.items.map((item) => item.text), items.map((item) => bodyText(item.bodyHtml)));
  }
});

test('超长单item按约1200字全文批次复核，所有目标恰好出现一次', async () => {
  const seen = [], bodyHtml = html('あ'.repeat(1000) + '食べる。' + 'い'.repeat(1000) + '飲む。');
  const service = create({ execute: async (_u, _r, input) => {
    const spans = targetsIn(input.prompt);
    seen.push(...spans.map((span) => span.surface));
    const material = JSON.parse(input.prompt.split('\n资料：\n')[1]);
    const chars = material.reduce((sum, item) => sum + item.text.replace(/\[\d+\|([^|]+)\|[^\]]+\]/g, '$1').length, 0);
    assert.ok(chars <= 1200, `Expected a page-sized batch, got ${chars} characters`);
    return { value: { changes: spans.map((span) => ({ id: span.id, r: span.surface === '食' ? 'た' : 'の' })), uncertain: [] } };
  } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml }] });
  assert.deepEqual(seen, ['食', '飲']);
  assert.equal(result.metrics.llmCalls, 2);
  assert.equal(bodyText(result.items[0].bodyHtml), bodyText(bodyHtml));
  assert.deepEqual(readings(result.items[0].bodyHtml).map((segment) => segment.reading), ['た', 'の']);
});

test('保护连续Han内部的手工读音，LLM只补其余部分', async () => {
  const service = create({ localRuby: { annotate: async (text) => ({ annotations: han(text, () => 'とうきょう') }) },
    execute: async (_u, _r, input) => {
      assert.deepEqual(targetsIn(input.prompt).map((target) => [target.surface, target.reading]), [['京', '?']]);
      return { value: { changes: [{ id: 0, r: 'きょう' }], uncertain: [] } };
    } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('<ruby data-origin="manual">東<rt>あずま</rt></ruby>京。') }] });
  assert.deepEqual(readings(result.items[0].bodyHtml).map(({ text, reading, origin }) => ({ text, reading, origin })), [
    { text: '東', reading: 'あずま', origin: 'manual' }, { text: '京', reading: 'きょう', origin: 'generated' },
  ]);
});

test('已有generated整词纠错只更新Han，保留原送假名', async () => {
  const service = create({ execute: async (_u, _r, input) => {
    assert.deepEqual(targetsIn(input.prompt).map((target) => [target.surface, target.reading]), [['行', 'い']]);
    return { value: { changes: [{ id: 0, r: 'おこな' }], uncertain: [] } };
  } });
  const result = await service.annotateBodies('u', { items: [{ id: 'a', bodyHtml: html('<ruby data-origin="generated">行う<rt>いう</rt></ruby>。') }] });
  assert.equal(bodyText(result.items[0].bodyHtml), '行う。');
  assert.deepEqual(readings(result.items[0].bodyHtml).map(({ text, reading }) => ({ text, reading })), [{ text: '行', reading: 'おこな' }]);
});

test('持久化快照缺目标或重叠目标时拒绝，校对前重新核验正文锚点', async () => {
  let calls = 0;
  const service = create({ execute: async () => { calls++; throw Error('unexpected'); } });
  for (const mutate of [(item) => item.targets.push({ ...item.targets[0] }), (item) => { item.targets[0].surface = '飲'; }, (item) => { item.text = '飲む'; }]) {
    const prepared = await service.prepareBodies([{ id: 'a', bodyHtml: html('食べる。') }]);
    mutate(prepared.items[0]);
    await assert.rejects(service.proofreadPrepared('u', { prepared }));
  }
  assert.equal(calls, 0);
});
