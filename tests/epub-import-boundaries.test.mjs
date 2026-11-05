import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createApp } from '../server/app.mjs';
import { bodyText } from '../shared/article-html.mjs';
import { ensureSession } from './helpers/session.mjs';
import { DatabaseSync } from 'node:sqlite';
import { inspectImportFile } from '../server/import-parsers.mjs';
import { fileURLToPath } from 'node:url';

test('EPUB imports retain long paragraph and chapter boundaries in one article or separate book articles',async(t)=>{
  const dir=await mkdtemp(join(tmpdir(),'yohaku-epub-boundaries-'));
  const instance=createApp({dataDir:join(dir,'data'),imageTaskOptions:{runnerOptions:{enabled:false}}});
  const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,{cookie}=await ensureSession(url);
  const chapters=[['前'.repeat(600)+'。','中'.repeat(600)+'。','後'.repeat(600)+'。'],['次章の本文。','終わり。']];
  const filePath=join(dir,'source.epub');
  execFileSync('python3',['-c',`
import json,sys
from zipfile import ZipFile
chapters=json.loads(sys.argv[2])
with ZipFile(sys.argv[1],'w') as z:
 z.writestr('mimetype','application/epub+zip')
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
 z.writestr('content.opf','<package><manifest>'+''.join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(chapters)))+'</manifest><spine>'+''.join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))+'</spine></package>')
 for i,paragraphs in enumerate(chapters):
  z.writestr(f'c{i}.xhtml','<html><body>'+''.join('<p>'+text+'</p>' for text in paragraphs)+'</body></html>')
`,filePath,JSON.stringify(chapters)]);
  const bytes=await readFile(filePath);
  async function request(path,method='GET',body,expected=200){
    const multipart=body instanceof FormData;
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  for(const asBook of [false,true]){
    const form=new FormData();form.append('files',new Blob([bytes],{type:'application/epub+zip'}),'source.epub');
    const draft=await request('/imports','POST',form,201);
    const imported=await request(`/imports/${draft.id}/confirm`,'POST',{type:'epub',title:'本文',asBook},201);
    assert.equal(imported.documents.length,asBook?2:1);
    for(let index=0;index<imported.documents.length;index++){
      const article=await request(`/documents/${imported.documents[index].id}`);
      const expected=(asBook?[chapters[index]]:chapters).map(paragraphs=>paragraphs.join('\n')).join('\n');
      assert.equal(bodyText(article.bodyHtml),expected);
      assert.equal(article.sources.map(source=>source.text).join(''),expected);
      assert.equal(article.sources.map(source=>source.firstExtraction.text).join(''),expected);
    }
  }
});

async function emptySpineFixture(t){
  const dir=await mkdtemp(join(tmpdir(),'yohaku-epub-empty-spine-')),dataDir=join(dir,'data');
  const instance=createApp({dataDir,imageTaskOptions:{runnerOptions:{enabled:false}}});
  const server=instance.app.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await instance.shutdown();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
  const url=`http://127.0.0.1:${server.address().port}`,{cookie}=await ensureSession(url);
  async function request(path,method='GET',body,expected=200){
    const multipart=body instanceof FormData;
    const response=await fetch(url+'/api'+path,{method,headers:{Cookie:cookie,...(body&&!multipart?{'Content-Type':'application/json'}:{})},body:body?(multipart?body:JSON.stringify(body)):undefined});
    const value=await response.json();assert.equal(response.status,expected,JSON.stringify(value));return value;
  }
  async function upload(bytes){const form=new FormData();form.append('files',new Blob([bytes],{type:'application/epub+zip'}),'source.epub');return request('/imports','POST',form,201);}
  function counts(){const db=new DatabaseSync(join(dataDir,'yohaku.sqlite'),{readOnly:true});try{return {books:db.prepare('SELECT count(*) AS n FROM books').get().n,documents:db.prepare('SELECT count(*) AS n FROM documents').get().n};}finally{db.close();}}
  return {dir,url,cookie,request,upload,counts};
}

async function epubSpines(dir,chapters){
  const path=join(dir,'spines.epub');
  execFileSync('python3',['-c',`
import json,sys
from zipfile import ZipFile
chapters=json.loads(sys.argv[2])
with ZipFile(sys.argv[1],'w') as z:
 z.writestr('mimetype','application/epub+zip')
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
 z.writestr('content.opf','<package><manifest>'+''.join(f'<item id="c{i}" href="c{i}.xhtml" media-type="application/xhtml+xml"/>' for i in range(len(chapters)))+'</manifest><spine>'+''.join(f'<itemref idref="c{i}"/>' for i in range(len(chapters)))+'</spine></package>')
 for i,paragraphs in enumerate(chapters):
  z.writestr(f'c{i}.xhtml','<html><body>'+(''.join('<p>'+text+'</p>' for text in paragraphs) if paragraphs else '<div><img src="cover.png"/></div>')+'</body></html>')
`,path,JSON.stringify(chapters)]);
  return readFile(path);
}

test('the real Japanese EPUB book skips its image-only cover and retains every text spine and original file',async t=>{
  const f=await emptySpineFixture(t),path=fileURLToPath(new URL('../fixtures/epub/pg31757-images.epub',import.meta.url));
  const bytes=await readFile(path),info=await inspectImportFile({filePath:path,type:'epub'});
  assert.equal(info.chapters.length,5);assert.equal(info.chapters[0].groups.length,0);
  const expected=info.chapters.filter(chapter=>chapter.groups.length),draft=await f.upload(bytes);
  assert.equal(draft.files[0].chapters.length,5);
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'epub',title:'お目出たき人',asBook:true},201);
  assert.equal(imported.documents.length,4);
  for(let index=0;index<expected.length;index++){
    const article=await f.request(`/documents/${imported.documents[index].id}`);
    const extracted=expected[index].groups.map(group=>bodyText(group.bodyHtml)).join('');
    assert.equal(article.title,expected[index].title);
    assert.equal(bodyText(article.bodyHtml),extracted);
    assert.equal(article.sources.map(source=>source.firstExtraction.text).join(''),extracted);
    assert.ok(article.sources.every(source=>source.original.chapterPath===expected[index].path));
  }
  const restored=await f.request(`/imports/${draft.id}`);assert.equal(restored.files[0].chapters.length,5,'staged source metadata keeps the original spine list');
  const original=await fetch(f.url+draft.files[0].previewUrl,{headers:{Cookie:f.cookie}});assert.equal(original.status,200);assert.deepEqual(Buffer.from(await original.arrayBuffer()),bytes);
  const before=f.counts();const again=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'epub',asBook:true});
  assert.equal(again.bookId,imported.bookId);assert.deepEqual(f.counts(),before,'confirming the same draft twice cannot duplicate the book');
});

test('EPUB book import skips empty leading, middle and final spines without creating empty articles',async t=>{
  const f=await emptySpineFixture(t),chapters=[null,['前章','空を見る。'],null,['後章','海を見る。'],null];
  const draft=await f.upload(await epubSpines(f.dir,chapters));
  const imported=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'epub',title:'本文',asBook:true},201);
  assert.equal(imported.documents.length,2);
  for(let index=0;index<2;index++){
    const article=await f.request(`/documents/${imported.documents[index].id}`);
    assert.equal(bodyText(article.bodyHtml),chapters[index?3:1].join('\n'));assert.ok(article.sources.length>0);
  }
});

test('an EPUB containing only empty image spines leaves a recoverable draft and no empty book',async t=>{
  const f=await emptySpineFixture(t),draft=await f.upload(await epubSpines(f.dir,[null,null])),before=f.counts();
  const rejected=await f.request(`/imports/${draft.id}/confirm`,'POST',{type:'epub',title:'空书',asBook:true},422);
  assert.match(rejected.error,/EPUB|正文|章节/);assert.deepEqual(f.counts(),before,'the failed confirmation rolls back its book and articles');
  const restored=await f.request(`/imports/${draft.id}`);assert.equal(restored.status,'staged');assert.equal(restored.files[0].chapters.length,2);
});
