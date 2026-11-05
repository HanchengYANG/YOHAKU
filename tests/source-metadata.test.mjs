import test from 'node:test';
import assert from 'node:assert/strict';
import { setBodySource, bodyRanges, bodyText, normalizeBodyHtml, editBodyText, applySentenceBoundaries, invalidateBodySentences } from '../shared/article-html.mjs';

test('通用来源标识独立于图片，经过正文编辑与分句仍可定位', () => {
  const html = setBodySource('<p data-paragraph-id="p"><span data-source-image-id="image">日本語。</span></p>', 'pdf-page-3');
  assert.match(html, /data-source-id="pdf-page-3"/);
  assert.match(html, /data-source-image-id="image"/);
  assert.equal(bodyRanges(html).sources[0].id, 'pdf-page-3');
  const edited = editBodyText(html, 'この日本語。');
  const split = applySentenceBoundaries(edited, [bodyText(edited)]);
  assert.deepEqual(bodyRanges(split).sources.map((s) => s.id), ['pdf-page-3']);
  assert.equal(normalizeBodyHtml(split), split);
});

test('人工修改仅失效相关句子的分句，保留其他句子ID和读音', () => {
  const html=applySentenceBoundaries('<p>最初。次の文。最後。</p>',['最初。','次の文。','最後。']);
  const old=bodyRanges(html).sentences;
  const edited=invalidateBodySentences(editBodyText(html,'最初。次の文章。最後。'),4,8);
  const retained=bodyRanges(edited).sentences;
  assert.deepEqual(retained.map(s=>s.id),[old[0].id,old[2].id]);
  assert.equal(bodyText(edited),'最初。次の文章。最後。');
});
