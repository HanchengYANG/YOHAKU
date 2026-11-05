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
