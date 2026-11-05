import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectImportFile, extractImportedSource, renderImportedSource } from '../server/import-parsers.mjs';
import { normalizeBodyHtml, bodyText } from '../shared/article-html.mjs';

// A small hand-written PDF keeps parser verification independent of network fixtures.
function pdf() {
  const objects=[
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length 49 >>\nstream\nBT /F1 12 Tf 20 200 Td (Original source.) Tj ET\nendstream',
  ];
  let content='%PDF-1.4\n', offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(content));content+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(content);
  content+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>`${String(offset).padStart(10,'0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(content);
}

test('PDF inspection reads metadata and a bounded sample; extraction reads only requested actual page',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'yohaku-parser-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const filePath=join(dir,'book.pdf'); await writeFile(filePath,pdf());
  const info=await inspectImportFile({filePath,type:'text_pdf'});
  assert.equal(info.pageCount,1); assert.equal(info.detectedType,'text_pdf');
  assert.equal(info.pages[0].page,1); assert.match(info.pages[0].text,/Original source/);
  const source={type:'text_pdf',original:{filePath,page:1}};
  const extracted=await extractImportedSource(source); assert.match(extracted.text,/Original source/);
  const rendered=await renderImportedSource(source); assert.equal((await readFile(rendered.path)).subarray(1,4).toString(),'PNG'); await rendered.cleanup();
  assert.deepEqual(await readFile(filePath),pdf());
  await assert.rejects(extractImportedSource({...source,original:{filePath,page:2}}), /页码|page/i);
});

test('EPUB spine extraction preserves paragraphs and existing ruby without evaluating content',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'yohaku-epub-parser-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const filePath=join(dir,'book.epub');
  execFileSync('python3',['-c',`
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1],'w') as z:
 z.writestr('mimetype','application/epub+zip')
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
 z.writestr('content.opf','<package><metadata><title>読む本</title></metadata><manifest><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>')
 z.writestr('one.xhtml','<html><body><h1>前章</h1><p>空を見る。</p><p><ruby>日本<rt>にほん</rt></ruby>を読む。</p><script>alert(1)</script></body></html>')
 z.writestr('two.xhtml','<html><body><h1>後章</h1><p><strong>海</strong>を<em>見る</em>。<br/>次の行。</p></body></html>')
`,filePath]);
  const info=await inspectImportFile({filePath,type:'epub'});
  assert.equal(info.chapters.length,2);assert.equal(info.chapters[0].title,'前章');assert.equal(info.chapters[1].title,'後章');
  assert.match(info.chapters[0].groups[0].bodyHtml,/<ruby data-origin="source">日本<rt>にほん<\/rt><\/ruby>/);
  assert.equal(info.chapters[0].groups[0].text,'前章\n空を見る。\n日本を読む。');
  assert.ok(info.chapters.every(chapter=>chapter.groups.every(group=>!/<script|onload=|javascript:/i.test(group.bodyHtml))));
  for(const chapter of info.chapters)for(const group of chapter.groups)assert.equal(bodyText(normalizeBodyHtml(group.bodyHtml)),group.text);
});

test('text extraction preserves an immutable snapshot including whitespace',async()=>{
  const source={type:'text',original:{snapshot:'  空。\n\n海。\n'}};
  assert.equal((await extractImportedSource(source)).text,source.original.snapshot);
});

async function epubWithChapter(t, chapter) {
  const dir=await mkdtemp(join(tmpdir(),'yohaku-epub-content-'));t.after(()=>rm(dir,{recursive:true,force:true}));
  const filePath=join(dir,'content.epub');
  execFileSync('python3',['-c',`
from zipfile import ZipFile
import sys
with ZipFile(sys.argv[1],'w') as z:
 z.writestr('mimetype','application/epub+zip')
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
 z.writestr('content.opf','<package><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="chapter"/></spine></package>')
 z.writestr('chapter.xhtml',sys.argv[2])
`,filePath,`<html><body>${chapter}</body></html>`]);
  return inspectImportFile({filePath,type:'epub'});
}

test('EPUB normalizes multiple implicit and explicit ruby bases into supported source readings',async(t)=>{
  const info=await epubWithChapter(t,'<p><ruby>日<rt>に</rt>本<rt>ほん</rt></ruby>と<ruby><rb>東</rb><rb>京</rb><rt>とう</rt><rt>きょう</rt></ruby>。</p>');
  const group=info.chapters[0].groups[0],normalized=normalizeBodyHtml(group.bodyHtml);
  assert.equal(bodyText(normalized),'日本と東京。');
  for(const [base,reading] of [['日','に'],['本','ほん'],['東','とう'],['京','きょう']])assert.match(normalized,new RegExp(`<ruby data-origin="source">${base}<rp>（</rp><rt>${reading}</rt>`));
});

test('EPUB paragraph groups preserve all original boundaries when joined as continuous sources',async(t)=>{
  const paragraphs=['前'.repeat(600)+'。','中'.repeat(600)+'。','後'.repeat(600)+'。'];
  const {chapters:[chapter]}=await epubWithChapter(t,paragraphs.map(text=>`<p>${text}</p>`).join(''));
  assert.equal(chapter.groups.length,3);
  const text=paragraphs.join('\n');
  assert.equal(chapter.groups.map(group=>bodyText(normalizeBodyHtml(group.bodyHtml))).join(''),text);
  assert.equal(chapter.groups.map(group=>group.text).join(''),text);
  let joined=normalizeBodyHtml(chapter.groups[0].bodyHtml);
  for(const group of chapter.groups.slice(1))joined=normalizeBodyHtml(joined.slice(0,-4)+normalizeBodyHtml(group.bodyHtml).replace(/^<p\b[^>]*>/,''));
  assert.equal(bodyText(joined),text);
  assert.equal(bodyText(normalizeBodyHtml(chapter.bodyHtml)),text);
});

test('EPUB mixed containers retain direct text, inline ruby and tails beside headings and paragraphs',async(t)=>{
  const cases=[
    {html:'<h1>章</h1><div>本文。<br/>続き。</div>末尾。',text:'章\n本文。\n続き。\n末尾。'},
    {html:'冒頭。<h1>章</h1><div>前<span>本文<ruby>日本<rt>にほん</rt></ruby></span>。<p>段落。</p>後<span>続き。</span></div>末尾。',text:'冒頭。\n章\n前本文日本。\n段落。\n後続き。\n末尾。',ruby:true},
  ];
  for(const value of cases){
    const {chapters:[chapter]}=await epubWithChapter(t,value.html);
    const normalized=normalizeBodyHtml(chapter.bodyHtml);
    assert.equal(bodyText(normalized),value.text);
    assert.equal(chapter.groups.map(group=>group.text).join(''),value.text);
    assert.equal(chapter.groups.map(group=>bodyText(normalizeBodyHtml(group.bodyHtml))).join(''),value.text);
    if(value.ruby)assert.match(normalized,/<ruby data-origin="source">日本<rp>（<\/rp><rt>にほん<\/rt>/);
  }
});
