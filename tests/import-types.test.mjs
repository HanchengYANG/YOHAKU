import test from 'node:test';
import assert from 'node:assert/strict';
import { guessImportType, assertHomogeneousImport, validateChapterRanges, groupParagraphs } from '../shared/import-types.mjs';

test('local import guessing recognizes signatures and lets users distinguish photos from screenshots', () => {
  assert.equal(guessImportType({name:'book.pdf',mimeType:'application/pdf',head:Buffer.from('%PDF-1.7')}),'text_pdf');
  assert.equal(guessImportType({name:'Screenshot 2026.png',mimeType:'image/png',head:Buffer.from([137,80,78,71,13,10,26,10])}),'screenshot');
  assert.equal(guessImportType({name:'page.jpg',mimeType:'image/jpeg',head:Buffer.from([255,216,255])}),'photo');
  assert.equal(guessImportType({name:'notes.txt',mimeType:'text/plain',head:Buffer.from('本文。')}),'text');
  assert.throws(()=>guessImportType({name:'book.pdf',mimeType:'application/pdf',head:Buffer.from('not pdf')}), /格式|文件/);
});

test('mixed kinds reject before AI or article creation', () => {
  assert.equal(assertHomogeneousImport(['photo','screenshot']),'photo');
  assert.equal(assertHomogeneousImport(['pdf_scan','pdf_text']),'text_pdf');
  assert.throws(()=>assertHomogeneousImport(['text','photo']), /混合/);
});

test('chapter confirmation uses actual page ranges, permits exclusions and reordering, rejects overlaps', () => {
  const input=[{title:'后章',startPage:7,endPage:10},{title:'前章',startPage:2,endPage:6},{title:'扉页',startPage:1,endPage:1,excluded:true}];
  const actual=validateChapterRanges(input,10);
  assert.equal(actual[0].startPage,7);
  assert.equal(actual[2].excluded,true);
  assert.throws(()=>validateChapterRanges([{title:'一',startPage:1,endPage:4},{title:'二',startPage:4,endPage:8}],10), /重叠/);
  assert.throws(()=>validateChapterRanges([{title:'一',startPage:0,endPage:4}],10), /实际页码/);
  assert.throws(()=>validateChapterRanges([{title:'一',startPage:1,endPage:11}],10), /实际页码/);
  assert.equal(validateChapterRanges([{title:'一',startPage:1,endPage:10,needsReview:true}],10)[0].needsReview,true);
});

test('paragraph grouping preserves paragraph boundaries and exact original snapshot', () => {
  const original='空を見る。\n\n海を見る。\n'+ '長'.repeat(1300);
  const groups=groupParagraphs(original,1000);
  assert.equal(groups.map(group=>group.text).join(''),original);
  assert.equal(groups.length,2);
  assert.ok(groups[1].text.length>1200);
});


test('oversized paragraphs become reusable sentence groups without loss, including UTF8 head boundaries',()=>{
  const text='空を見る。'.repeat(500);
  const groups=groupParagraphs(text);
  assert.equal(groups.map(group=>group.text).join(''),text);
  assert.ok(groups.length>=3);assert.ok(groups.every(group=>group.text.length<=1200));
  const head=Buffer.from('あ'.repeat(1400)).subarray(0,4096);
  assert.equal(guessImportType({name:'日本語.txt',mimeType:'text/plain',head}),'text');
});


test('adjacent chapters can share one PDF page only with explicit disjoint local ranges',()=>{
  const chapters=validateChapterRanges([{title:'前章',startPage:1,endPage:1,endOffset:100},{title:'後章',startPage:1,endPage:2,startOffset:100}],2);
  assert.equal(chapters[0].endOffset,100);assert.equal(chapters[1].startOffset,100);
  assert.throws(()=>validateChapterRanges([{title:'前章',startPage:1,endPage:1,endOffset:101},{title:'後章',startPage:1,endPage:2,startOffset:100}],2),/重叠/);
  assert.throws(()=>validateChapterRanges([{title:'前章',startPage:1,endPage:1,startOffset:10,endOffset:5}],2),/范围/);
});
