import test from 'node:test';
import assert from 'node:assert/strict';
import { paginateReadingText, sliceReadingHtml, remapReadingRanges } from '../shared/reading-pages.mjs';
import { blocksToHtml, bodyText, applySentenceBoundaries, bodyRanges } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';

test('pages preserve every character and use complete sentences around 1000 characters', () => {
  const sentences = Array.from({length: 23}, (_, i) => `${String(i).padStart(2,'0')}${'文'.repeat(97)}。`);
  const text = sentences.join('');
  let start = 0;
  const ranges = sentences.map(text => { const range={start,end:start+text.length};start=range.end;return range; });
  const pages = paginateReadingText(text, ranges);
  assert.deepEqual(pages.map(p => p.end-p.start), [1000,1000,300]);
  assert.equal(pages.map(p => text.slice(p.start,p.end)).join(''),text);
});

test('long sentences occupy their own page and unfinished tails do not predict total pages', () => {
  const text = '前'.repeat(900)+'長'.repeat(1500)+'後'.repeat(400);
  const ranges=[{start:0,end:900},{start:900,end:2400},{start:2400,end:2800}];
  assert.deepEqual(paginateReadingText(text,ranges,{complete:false}),[{start:0,end:900},{start:900,end:2400}]);
  assert.deepEqual(paginateReadingText(text,ranges),[{start:0,end:900},{start:900,end:2400},{start:2400,end:2800}]);
});

test('slicing preserves ruby, paragraph and sentence identity and quote marks', () => {
  const html=applySentenceBoundaries(blocksToHtml(parseText('{日本|にほん}。\n空。')),['日本。\n','空。']);
  const result=sliceReadingHtml(html,0,4);
  assert.equal(bodyText(result),'日本。\n');
  assert.match(result,/<ruby/);
  assert.equal(bodyRanges(result).sentences[0].id,bodyRanges(html).sentences[0].id);
});

test('every sliced range preserves paragraph separators including newline-only selections', () => {
  const inputs = [
    '<p>A</p><p>B</p>',
    '<p>A</p><p></p>',
    '<p></p><p></p><p>B</p><p></p>',
    '<p>A<br>B</p><p></p><p><ruby>日本<rt>にほん</rt></ruby>。</p>',
  ];
  for (const html of inputs) {
    const text = bodyText(html);
    for (let start = 0; start <= text.length; start++) {
      for (let end = start; end <= text.length; end++) {
        assert.equal(bodyText(sliceReadingHtml(html, start, end)), text.slice(start, end), `${JSON.stringify(text)} [${start},${end})`);
      }
    }
  }
});

test('editing a published page expands only its local range and shifts later anchors',()=>{
  const pages=[{ranges:[{sourceId:'a',paragraphId:'p',start:0,end:1000}]},{ranges:[{sourceId:'a',paragraphId:'p',start:1000,end:2000}]},{ranges:[{sourceId:'b',paragraphId:'q',start:0,end:800}]}];
  const next=remapReadingRanges(pages,{sourceId:'a',paragraphId:'p',before:'あ'.repeat(2000),after:'あ'.repeat(400)+'追加'+'あ'.repeat(1600)});
  assert.deepEqual(next.map(p=>p.ranges),[[{sourceId:'a',paragraphId:'p',start:0,end:1002}],[{sourceId:'a',paragraphId:'p',start:1002,end:2002}],[{sourceId:'b',paragraphId:'q',start:0,end:800}]]);
});

test('补回来源开头和结尾漏句时稳定页面不遗漏新增正文',()=>{
  const pages=[{ranges:[{sourceId:'a',paragraphId:'p',start:0,end:2}]},{ranges:[{sourceId:'a',paragraphId:'p',start:2,end:4}]}];
  const prepend=remapReadingRanges(pages,{sourceId:'a',paragraphId:'p',before:'あいうえ',after:'追加あいうえ'});
  assert.deepEqual(prepend.map(p=>p.ranges.map(r=>[r.start,r.end])), [[[0,4]],[[4,6]]]);
  const append=remapReadingRanges(pages,{sourceId:'a',paragraphId:'p',before:'あいうえ',after:'あいうえ追加'});
  assert.deepEqual(append.map(p=>p.ranges.map(r=>[r.start,r.end])), [[[0,2]],[[2,6]]]);
  const boundary=remapReadingRanges(pages,{sourceId:'a',paragraphId:'p',before:'あいうえ',after:'あい追加うえ'});
  assert.deepEqual(boundary.map(p=>p.ranges.map(r=>[r.start,r.end])), [[[0,4]],[[4,6]]]);
});
