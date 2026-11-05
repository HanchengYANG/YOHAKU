import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp,rm,readFile,stat,utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { attachImportRoutes } from '../server/imports.mjs';
import { renderImportedSource,inspectImportFile } from '../server/import-parsers.mjs';
import { attachTaskRoutes } from '../server/tasks.mjs';
import { execFileSync } from 'node:child_process';

async function fixture(t,{proposal,extractChapterPage,renderSourcePreview,inspectFile}={}) {
  const storageDir=await mkdtemp(join(tmpdir(),'yohaku-import-test-'));
  const database=new DatabaseSync(':memory:');
  database.exec('CREATE TABLE books(id TEXT PRIMARY KEY,title TEXT,owner_id TEXT,revision INTEGER,created_at TEXT,updated_at TEXT)');
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.user={id:req.headers['x-user']||'one'};next();});
  const attached=[],articles=[],proposals=[],extractions=[],extractionTypes=[];let createCalls=0;
  const sources={adoptDocument(){},createArticleSources(userId,id,values){attached.push({userId,id,values});return {...articles.find(article=>article.id===id),sources:values};}};
  const ai={async proposeChapters(_user,input){proposals.push(input);return proposal?proposal(input):{chapters:[{title:'正文',startPage:1,endPage:input.metadata.pageCount,needsReview:true}]};},async saveImage(){return{id:'image-1'};}};
  const books={transaction:work=>work(),requireBook(_user,id){return database.prepare('SELECT * FROM books WHERE id=?').get(id);}};
  const imports=attachImportRoutes({app,database,storageDir,ai,sources,books,renderSourcePreview,inspectFile,extractChapterPage:async source=>{extractions.push(source.original.page);extractionTypes.push(source.type);return extractChapterPage?extractChapterPage(source):{text:`第${source.original.page}页正文。\n页脚`};},createImportedArticle(userId,value){createCalls++;const row={id:`article-${createCalls}`,...value};articles.push(row);return row;},requireDocument(_user,id){const row=articles.find(article=>article.id===id);if(!row)throw Object.assign(new Error('missing'),{status:404});return row;}});
  attachTaskRoutes({app,database,adapters:[imports.taskAdapter]});
  app.use((error,_req,res,_next)=>res.status(error.status||500).json({error:error.message}));
  const server=app.listen(0,'127.0.0.1');await once(server,'listening');const url=`http://127.0.0.1:${server.address().port}`;
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));imports.close?.();if(database.isOpen)database.close();await rm(storageDir,{recursive:true,force:true});});
  async function request(path,method='GET',body,user) {
    const response=await fetch(url+path,{method,headers:{...(body instanceof FormData?{}:body?{'Content-Type':'application/json'}:{}),...(user?{'x-user':user}:{})},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});
    return {status:response.status,headers:response.headers,data:response.headers.get('content-type')?.includes('application/json')?await response.json():response.headers.get('content-type')?.startsWith('image/')?Buffer.from(await response.arrayBuffer()):await response.text()};
  }
  async function waitChapters(path){for(let count=0;count<500;count++){const result=await request(path);if(!['queued','extracting','proposing'].includes(result.data.chapterProcessing?.status))return result;await new Promise(resolve=>setTimeout(resolve,5));}throw new Error('chapter preparation did not finish');}
  return {storageDir,request,waitChapters,attached,articles,proposals,extractions,extractionTypes,database,stopImportsAndDatabase(){imports.close();database.close();},drainImports:()=>imports.drain(),get bookCount(){return database.prepare('SELECT count(*) AS count FROM books').get().count;},get createCalls(){return createCalls;}};
}

test('pasted import confirms locally, snapshots original, and attaches paragraph groups without AI',async(t)=>{
  const f=await fixture(t);const text='  空。\n\n海。';
  const staged=await f.request('/api/imports','POST',{text,title:'原文'});
  assert.equal(staged.status,201);assert.equal(staged.data.detectedType,'text');assert.equal(f.createCalls,0);
  const {id,createdAt}=staged.data;
  assert.ok(Number.isFinite(Date.parse(createdAt)));
  assert.equal((await f.request('/api/imports')).data.drafts.find(draft=>draft.id===id).createdAt,createdAt);
  assert.equal((await f.request(`/api/imports/${id}`)).data.createdAt,createdAt);
  assert.equal((await f.request(`/api/tasks/${id}`)).data.createdAt,createdAt);
  assert.equal(f.proposals.length,0);
  const saved=await f.request(`/api/imports/${staged.data.id}/confirm`,'POST',{type:'text',title:'文章'});
  assert.equal(saved.status,201);assert.equal(saved.data.firstDocumentId,'article-1');
  assert.equal(f.attached[0].values.map(source=>source.original.snapshot).join(''),text);
  assert.equal(f.attached[0].values[0].preview.kind,'text');
  assert.equal((await f.request(`/api/imports/${staged.data.id}`,'GET',undefined,'two')).status,404);
  const again=await f.request(`/api/imports/${staged.data.id}/confirm`,'POST',{type:'text',title:'文章'});
  assert.equal(again.status,200);assert.equal(f.createCalls,1);
});

function blankPdf(pageCount=1){
  return Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [${Array.from({length:pageCount},(_,i)=>`${i+3} 0 R`).join(' ')}] /Count ${pageCount} >> endobj\n${Array.from({length:pageCount},(_,i)=>`${i+3} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj`).join('\n')}\ntrailer << /Root 1 0 R /Size ${pageCount+3} >>\n%%EOF`);
}

test('PDF chapter proposals receive all locally extracted pages and reuse persisted extraction on retry',async(t)=>{
  const bytes=blankPdf(151),f=await fixture(t),form=new FormData();form.append('files',new Blob([bytes],{type:'application/pdf'}),'whole-book.pdf');
  const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  assert.equal(stage.status,201);assert.equal(stage.data.files[0].pageCount,151);
  const proposed=await f.request(path+'/chapters','POST',{type:'scan_pdf'});
  assert.equal(proposed.status,202);assert.equal(proposed.data.chapterAttempted,true);
  const completed=await f.waitChapters(path);assert.equal(completed.data.chapterProcessing.status,'done');
  const input=f.proposals[0];assert.equal(input.pages.length,151);assert.deepEqual(input.pages.map(value=>value.page),Array.from({length:151},(_,i)=>i+1));assert.equal(input.pages[150].text,'第151页正文。\n页脚');
  assert.equal(input.image,undefined);assert.equal(input.document,undefined);assert.equal(f.extractions.length,151);
  assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);await f.waitChapters(path);assert.equal(f.extractions.length,151);assert.equal(f.proposals.length,2);
});

test('PDF extraction caches and chapter exclusions remain bound to the confirmed extraction type',async(t)=>{
  const f=await fixture(t,{extractChapterPage:async source=>({text:source.type+'正文。\n'+source.type+'页脚'}),proposal:input=>({chapters:[{title:'正文',startPage:1,endPage:1,needsReview:false}],exclusions:input.metadata.type==='scan_pdf'?[{page:1,startLine:2,endLine:2,reason:'扫描页脚'}]:[]})});
  const form=new FormData();form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),'types.pdf');
  const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});const scanned=await f.waitChapters(path);
  const confirmation={title:'正文',asBook:true,chapters:scanned.data.chapters};
  assert.equal((await f.request(path+'/confirm','POST',{...confirmation,type:'text_pdf'})).status,409);
  await f.request(path+'/chapters','POST',{type:'text_pdf'});const text=await f.waitChapters(path);
  assert.deepEqual(f.extractionTypes,['scan_pdf','text_pdf']);
  assert.equal(f.proposals.at(-1).pages[0].text,'text_pdf正文。\ntext_pdf页脚');
  assert.deepEqual(text.data.exclusions,[]);
  assert.equal((await f.request(path+'/confirm','POST',{...confirmation,type:'text_pdf',exclusions:scanned.data.exclusions})).status,400);
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});const rescanned=await f.waitChapters(path);
  assert.deepEqual(f.extractionTypes,['scan_pdf','text_pdf']);
  assert.equal(f.proposals.at(-1).pages[0].text,'scan_pdf正文。\nscan_pdf页脚');
  const saved=await f.request(path+'/confirm','POST',{...confirmation,type:'scan_pdf',exclusions:rescanned.data.exclusions});
  assert.equal(saved.status,201);const source=f.attached[0].values[0];
  assert.equal(source.text,'scan_pdf正文。');assert.equal(source.firstExtraction.text,'scan_pdf正文。\nscan_pdf页脚');assert.equal(source.firstExtraction.label,'本地 OCR 首次提取结果');
});

test('closing imports discards queued chapter jobs before they touch a closed database',async(t)=>{
  let release;const gate=new Promise(resolve=>release=resolve),unhandled=[];
  const f=await fixture(t,{extractChapterPage:()=>gate});
  const paths=[];
  for(let index=0;index<2;index++){
    const form=new FormData();form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),`queued-${index}.pdf`);
    const staged=await f.request('/api/imports','POST',form);paths.push(`/api/imports/${staged.data.id}`);
  }
  const capture=error=>unhandled.push(error.message);process.on('unhandledRejection',capture);t.after(()=>process.off('unhandledRejection',capture));
  for(const path of paths)assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);
  assert.equal(f.extractions.length,2);
  f.stopImportsAndDatabase();release({text:'已完成。'});await f.drainImports();await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(unhandled,[]);assert.equal(f.extractions.length,2);
});

test('independent PDF proposals overlap and failed task deletion retains its original', {timeout:10000},async t=>{
  let release,entered,calls=0;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,{proposal:async input=>{calls++;if(calls===1){entered();await gate;throw Object.assign(new Error('controlled failure'),{status:400,expose:true});}return{chapters:[{title:'正文',startPage:1,endPage:1,needsReview:false}]};}});
  t.after(()=>release());
  const drafts=[];for(let index=0;index<2;index++){const form=new FormData();form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),`book-${index}.pdf`);drafts.push((await f.request('/api/imports','POST',form)).data);}
  await f.request(`/api/imports/${drafts[0].id}/chapters`,'POST',{type:'scan_pdf'});await started;
  const active=(await f.request(`/api/tasks/${drafts[0].id}`)).data;assert.equal(active.canDelete,false);assert.equal((await f.request(`/api/tasks/${drafts[0].id}`,'DELETE',{version:active.version})).status,409);
  await f.request(`/api/imports/${drafts[1].id}/chapters`,'POST',{type:'scan_pdf'});
  assert.equal((await f.waitChapters(`/api/imports/${drafts[1].id}`)).data.chapterProcessing.status,'done');
  assert.equal((await f.request(`/api/imports/${drafts[0].id}`)).data.chapterProcessing.status,'proposing');
  release();await f.waitChapters(`/api/imports/${drafts[0].id}`);
  const failed=(await f.request(`/api/tasks/${drafts[0].id}`)).data;assert.equal(failed.canDelete,true);
  assert.equal((await f.request(`/api/tasks/${failed.id}`,'DELETE',{version:failed.version})).status,204);
  assert.equal((await f.request(`/api/tasks/${failed.id}`)).status,404);
  assert.equal((await f.request(drafts[0].files[0].previewUrl)).status,200);
  const extractionCount=f.extractions.length;
  await f.request(`/api/imports/${drafts[0].id}/chapters`,'POST',{type:'scan_pdf'});await f.waitChapters(`/api/imports/${drafts[0].id}`);
  const revived=(await f.request('/api/tasks')).data.tasks.find(task=>task.importId===drafts[0].id);
  assert.ok(revived);assert.notEqual(revived.id,failed.id);assert.equal(f.extractions.length,extractionCount);
});

test('initial PDF inspection failures appear as failed parse tasks and retry only failed files',{timeout:10000},async t=>{
  let calls=0,release,entered;const gate=new Promise(resolve=>{release=resolve;}),started=new Promise(resolve=>{entered=resolve;});t.after(()=>release());
  const f=await fixture(t,{inspectFile:async input=>{calls++;if(calls===2)throw Object.assign(new Error('temporary parser unavailable'),{status:503,expose:true});if(calls===3){entered();await gate;}return inspectImportFile(input);}});
  const form=new FormData();for(let index=0;index<2;index++)form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),`parse-${index}.pdf`);
  const draft=(await f.request('/api/imports','POST',form)).data;
  let task=(await f.request(`/api/tasks/${draft.id}`)).data;
  assert.equal(task.status,'failed');assert.equal(task.canRetry,true);assert.equal(task.canDelete,true);
  assert.ok(task.steps.some(step=>step.step==='parse'&&step.status==='failed'));
  assert.equal((await f.request(`/api/tasks/${task.id}/retry`,'POST',{version:task.version})).status,200);await started;
  task=(await f.request(`/api/tasks/${task.id}`)).data;assert.equal(task.canDelete,false);assert.equal(task.status,'running');
  assert.equal((await f.request(`/api/tasks/${task.id}`,'DELETE',{version:task.version})).status,409);
  release();await f.drainImports();task=(await f.request(`/api/tasks/${task.id}`)).data;
  assert.equal(task.status,'draft');assert.equal(calls,3);assert.ok(task.steps.find(step=>step.step==='parse').children.every(step=>step.status==='completed'));
  assert.equal((await f.request(draft.files[1].previewUrl)).status,200);
});

test('deleting failed parser tasks preserves originals and explicit inspection starts a new generation',async t=>{
  let calls=0;const f=await fixture(t,{inspectFile:async input=>{if(!calls++)throw Object.assign(new Error('parser unavailable'),{status:503,expose:true});return inspectImportFile(input);}});
  const form=new FormData();form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),'parse.pdf');
  const draft=(await f.request('/api/imports','POST',form)).data,task=(await f.request('/api/tasks/'+draft.id)).data;
  assert.equal(task.canDelete,true);assert.equal((await f.request('/api/tasks/'+task.id,'DELETE',{version:task.version})).status,204);
  assert.equal((await f.request(draft.files[0].previewUrl)).status,200);assert.equal((await f.request('/api/tasks/'+task.id)).status,404);
  assert.equal((await f.request('/api/imports/'+draft.id+'/inspect','POST',{})).status,202);await f.drainImports();
  const next=(await f.request('/api/tasks')).data.tasks.find(item=>item.importId===draft.id);assert.ok(next);assert.notEqual(next.id,task.id);assert.equal(next.status,'draft');
});

test('failed AI chapter attempts stay visible and permit valid manual chapter confirmation',async(t)=>{
  const f=await fixture(t,{proposal:()=>{throw Object.assign(new Error('分章结果格式不完整，请手动调整章节。'),{status:502,expose:true});}}),form=new FormData();
  form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),'blank.pdf');
  const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  const confirmation={type:'scan_pdf',title:'人工核对章节',asBook:true,chapters:[{title:'正文',startPage:1,endPage:1,needsReview:true}]};
  assert.equal((await f.request(path+'/confirm','POST',confirmation)).status,409);
  assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);
  const restored=await f.waitChapters(path);assert.equal(restored.data.chapterProcessing.status,'failed');assert.equal(restored.data.chapterAttempted,true);assert.match(restored.data.chapterError,/手动调整章节/);assert.deepEqual(restored.data.chapters,[]);
  const saved=await f.request(path+'/confirm','POST',confirmation);assert.equal(saved.status,201);assert.equal(saved.data.documents.length,1);
});

test('rejects mixed uploads and type mismatch before creating articles or starting AI',async(t)=>{
  const f=await fixture(t);const form=new FormData();
  form.append('files',new Blob(['本文'],{type:'text/plain'}),'input.txt');
  form.append('files',new Blob([Buffer.from([137,80,78,71,13,10,26,10])],{type:'image/png'}),'picture.png');
  assert.equal((await f.request('/api/imports','POST',form)).status,400);
  const staged=await f.request('/api/imports','POST',{text:'本文',title:'标题'});
  assert.equal((await f.request(`/api/imports/${staged.data.id}/confirm`,'POST',{type:'photo'})).status,400);
  assert.equal(f.createCalls,0);assert.equal(f.proposals.length,0);
});

test('file previews require ownership, keep original bytes and never expose private paths',async(t)=>{
  const f=await fixture(t);const form=new FormData();
  form.append('files',new Blob(['原文\n'],{type:'text/plain'}),'../input.txt');
  const staged=await f.request('/api/imports','POST',form);assert.equal(staged.status,201);
  const file=staged.data.files[0];assert.equal(file.name,'input.txt');assert.equal(JSON.stringify(staged.data).includes('filePath'),false);
  const raw=`/api/imports/${staged.data.id}/files/${file.id}/raw`;
  assert.equal((await f.request(raw)).data,'原文\n');assert.equal((await f.request(raw,'GET',undefined,'two')).status,404);
  await f.request(`/api/imports/${staged.data.id}/confirm`,'POST',{type:'text',title:'原文'});
  assert.equal((await f.request(raw)).data,'原文\n');
});

test('Japanese upload names and older multipart draft names retain their UTF-8 spelling',async(t)=>{
  const f=await fixture(t),form=new FormData(),name='小説ファイル.txt';
  form.append('files',new Blob(['日本語の本文。'],{type:'text/plain'}),name);
  const stage=await f.request('/api/imports','POST',form);assert.equal(stage.status,201);
  assert.equal(stage.data.files[0].name,name);assert.equal(stage.data.title,'小説ファイル');
  const id=stage.data.id,row=f.database.prepare('SELECT draft_json FROM import_drafts WHERE id=?').get(id),legacy=JSON.parse(row.draft_json);
  legacy.files[0].name=Buffer.from(name,'utf8').toString('latin1');legacy.title=Buffer.from('小説ファイル','utf8').toString('latin1');
  f.database.prepare('UPDATE import_drafts SET draft_json=? WHERE id=?').run(JSON.stringify(legacy),id);
  const restored=await f.request(`/api/imports/${id}`);assert.equal(restored.data.files[0].name,name);assert.equal(restored.data.title,'小説ファイル');
  assert.equal((await f.request(`/api/imports/${id}/confirm`,'POST',{type:'text'})).status,201);
  const persisted=JSON.parse(f.database.prepare('SELECT draft_json FROM import_drafts WHERE id=?').get(id).draft_json);
  assert.equal(persisted.files[0].name,name);assert.equal(persisted.title,'小説ファイル');assert.equal(f.attached[0].values[0].original.name,name);
});


test('PDF book import requires an AI proposal and preserves uncertain boundary markers after confirmation',async(t)=>{
  const f=await fixture(t);const form=new FormData();
  // A minimal blank PDF; local inspection does not start OCR.
  const file=Buffer.from('%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] >> endobj\ntrailer << /Root 1 0 R /Size 4 >>\n%%EOF');
  form.append('files',new Blob([file],{type:'application/pdf'}),'book.pdf');
  const stage=await f.request('/api/imports','POST',form);assert.equal(stage.status,201);assert.equal(stage.data.files[0].pageCount,1);
  const path=`/api/imports/${stage.data.id}`;
  assert.equal((await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters:[{title:'本文',startPage:1,endPage:1}]})).status,409);
  assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);
  const proposal=await f.waitChapters(path);
  assert.equal(proposal.status,200);assert.equal(f.proposals.length,1);assert.equal(f.proposals[0].pages[0].text,'第1页正文。\n页脚');
  const chapters=proposal.data.chapters;
  const saved=await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters});
  assert.equal(saved.status,201);assert.ok(saved.data.bookId);assert.equal(f.attached[0].values[0].original.page,1);assert.equal(f.attached[0].values[0].text,'第1页正文。\n页脚');assert.equal(f.attached[0].values[0].original.boundaryNeedsReview,true);
});

test('chapter filtering preserves first local OCR and only removes confirmed lines',async t=>{
  const f=await fixture(t,{proposal:()=>({chapters:[{title:'正文',startPage:1,endPage:1,needsReview:false}],exclusions:[{page:1,startLine:2,endLine:2,reason:'页脚'}]})}),form=new FormData();
  form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),'book.pdf');
  const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});const proposal=await f.waitChapters(path);
  assert.equal(proposal.data.exclusions[0].text,'页脚');
  const saved=await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters:proposal.data.chapters,exclusions:proposal.data.exclusions});
  assert.equal(saved.status,201);const value=f.attached[0].values[0];assert.equal(value.text,'第1页正文。');assert.equal(value.firstExtraction.text,'第1页正文。\n页脚');assert.equal(value.firstExtraction.label,'本地 OCR 首次提取结果');assert.equal(value.importExclusions[0].reason,'页脚');
});

test('interrupted local extraction retries only missing pages and duplicate requests share one job',async t=>{
  let release,failed=false;const gate=new Promise(resolve=>{release=resolve;});
  const f=await fixture(t,{extractChapterPage:async source=>{const page=source.original.page;if(page===2&&!failed){await gate;failed=true;throw Object.assign(new Error('本地第2页失败'),{expose:true});}return {text:`页${page}。`};}}),form=new FormData();
  form.append('files',new Blob([blankPdf(3)],{type:'application/pdf'}),'book.pdf');
  const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);
  assert.equal((await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'不能抢先保存'})).status,409);
  release();const failedResult=await f.waitChapters(path);assert.equal(failedResult.data.chapterProcessing.status,'failed');assert.equal(f.proposals.length,0);
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});const done=await f.waitChapters(path);assert.equal(done.data.chapterProcessing.status,'done');assert.deepEqual(f.extractions,[1,2,2,3]);assert.equal(f.proposals.length,1);
});


test('photo and screenshot batches create one article and cannot import directly as a book',async(t)=>{
  const f=await fixture(t);const form=new FormData();
  for(const name of ['first.png','second.png'])form.append('files',new Blob([Buffer.from([137,80,78,71,13,10,26,10])],{type:'image/png'}),name);
  const draft=await f.request('/api/imports','POST',form);assert.equal(draft.status,201);
  for(const type of ['photo','screenshot']) {
    const rejected=await f.request(`/api/imports/${draft.data.id}/confirm`,'POST',{type,title:'多张图片',asBook:true});
    assert.equal(rejected.status,400);assert.match(rejected.data.error,/文章/);assert.equal(f.bookCount,0);assert.equal(f.createCalls,0);
  }
  const saved=await f.request(`/api/imports/${draft.data.id}/confirm`,'POST',{type:'photo',title:'一篇文章'});
  assert.equal(saved.status,201);assert.equal(saved.data.documents.length,1);assert.equal(f.attached[0].values.length,2);assert.equal(f.bookCount,0);
});

const imageBytes=marker=>Buffer.from([137,80,78,71,13,10,26,10,marker]);
async function stageImages(f,files,user){
  const form=new FormData();
  for(const [name,bytes] of files)form.append('files',new Blob([bytes],{type:'image/png'}),name);
  const result=await f.request('/api/imports','POST',form,user);
  assert.equal(result.status,201);
  return result.data;
}

test('image import suggests the latest confirmed type for identical bytes only within the account',async t=>{
  const f=await fixture(t),bytes=imageBytes(1),digest=createHash('sha256').update(bytes).digest('hex');
  const first=await stageImages(f,[['7.png',bytes]]),firstPath=`/api/imports/${first.id}`;
  assert.equal(first.detectedType,'photo');assert.equal(first.suggestedType??null,null);
  assert.equal((await f.request(`${firstPath}/confirm`,'POST',{type:'screenshot'})).status,201);
  const saved=JSON.parse(f.database.prepare('SELECT draft_json FROM import_drafts WHERE id=?').get(first.id).draft_json);
  assert.equal(saved.confirmedType,'screenshot');assert.equal(saved.files[0].contentHash,digest);
  assert.equal(f.attached[0].values[0].type,'screenshot');

  const repeat=await stageImages(f,[['renamed.png',bytes]]),repeatPath=`/api/imports/${repeat.id}`;
  assert.equal(repeat.detectedType,'photo');assert.equal(repeat.suggestedType,'screenshot');
  assert.deepEqual(repeat.allowedTypes,['photo','screenshot']);
  const reopened=await f.request(repeatPath),task=await f.request(`/api/tasks/${repeat.id}`);
  assert.equal(reopened.data.suggestedType,'screenshot');assert.equal(task.data.draft.suggestedType,'screenshot');
  for(const draft of [first,repeat,reopened.data,task.data]){
    assert.equal(JSON.stringify(draft).includes(digest),false);
    assert.equal(Object.hasOwn(draft.files[0],'contentHash'),false);
  }
  const different=await stageImages(f,[['7.png',imageBytes(2)]]);
  assert.equal(different.files[0].bytes,repeat.files[0].bytes);assert.equal(different.suggestedType??null,null);
  assert.equal((await stageImages(f,[['7.png',bytes]],'two')).suggestedType??null,null);

  assert.equal((await f.request(`${repeatPath}/confirm`,'POST',{type:'photo',asBook:true})).status,400);
  assert.equal((await stageImages(f,[['7.png',bytes]])).suggestedType,'screenshot','failed confirmation does not change the preference');
  assert.equal((await f.request(`${repeatPath}/confirm`,'POST',{type:'photo'})).status,201);
  assert.equal((await f.request(`${firstPath}/confirm`,'POST',{type:'screenshot'})).status,200);
  const overridden=await stageImages(f,[['screenshot.png',bytes]]);
  assert.equal(overridden.detectedType,'screenshot');assert.equal(overridden.suggestedType,'photo');
});

test('image import only suggests a batch type when every image has the same confirmed choice',async t=>{
  const f=await fixture(t),first=imageBytes(3),second=imageBytes(4),photo=imageBytes(5),unknown=imageBytes(6);
  const screenshots=await stageImages(f,[['first.png',first],['second.png',second]]);
  assert.equal((await f.request(`/api/imports/${screenshots.id}/confirm`,'POST',{type:'screenshot'})).status,201);
  const photoDraft=await stageImages(f,[['photo.png',photo]]);
  assert.equal((await f.request(`/api/imports/${photoDraft.id}/confirm`,'POST',{type:'photo'})).status,201);

  const agrees=await stageImages(f,[['second-renamed.png',second],['first-renamed.png',first]]);
  assert.equal(agrees.detectedType,'photo');assert.equal(agrees.suggestedType,'screenshot');
  assert.deepEqual(agrees.files.map(file=>file.name),['second-renamed.png','first-renamed.png']);
  assert.equal((await stageImages(f,[['known.png',first],['unknown.png',unknown]])).suggestedType??null,null);
  assert.equal((await stageImages(f,[['known.png',first],['different-choice.png',photo]])).suggestedType??null,null);
});

test('legacy image confirmation falls back to exact original bytes and the matching saved source',async t=>{
  const f=await fixture(t),bytes=imageBytes(7),first=await stageImages(f,[['7.png',bytes]]);
  const saved=await f.request(`/api/imports/${first.id}/confirm`,'POST',{type:'screenshot'});
  assert.equal(saved.status,201);
  const row=f.database.prepare('SELECT draft_json,result_json FROM import_drafts WHERE id=?').get(first.id);
  const draft=JSON.parse(row.draft_json),result=JSON.parse(row.result_json),file=draft.files[0];
  delete draft.confirmedType;delete file.contentHash;
  const [source]=result.documents[0].sources;
  assert.equal(source.id,file.id);assert.equal(source.original.importId,first.id);
  result.documents[0].sources.unshift(
    {...source,id:'other-source',type:'photo'},
    {...source,type:'photo',original:{...source.original,importId:'other-import'}},
  );
  f.database.prepare('UPDATE import_drafts SET draft_json=?,result_json=? WHERE id=?').run(JSON.stringify(draft),JSON.stringify(result),first.id);
  assert.deepEqual(await readFile(join(f.storageDir,'imports',first.id,file.id)),bytes);

  const legacy=await stageImages(f,[['legacy-renamed.png',bytes]]);
  assert.equal(legacy.detectedType,'photo');assert.equal(legacy.suggestedType,'screenshot');
  assert.equal((await stageImages(f,[['7.png',imageBytes(8)]])).suggestedType??null,null);
  assert.equal((await stageImages(f,[['legacy-renamed.png',bytes]],'two')).suggestedType??null,null);
});


test('blank optional staging title gets a local fallback before confirmation',async(t)=>{
  const f=await fixture(t);const draft=await f.request('/api/imports','POST',{text:'貼り付けた本文。',title:''});
  assert.equal(draft.status,201);assert.equal(draft.data.title,'粘贴文字');assert.equal(f.createCalls,0);
  assert.equal((await f.request(`/api/imports/${draft.data.id}/confirm`,'POST',{type:'text',title:''})).status,400);
});

test('pending import drafts can be resumed from another tab without exposing another account',async t=>{
  const f=await fixture(t);const own=await f.request('/api/imports','POST',{text:'本文。',title:'恢复草稿',bookId:'book-target'});
  await f.request('/api/imports','POST',{text:'其他用户。',title:'私有草稿'},'two');
  const listed=await f.request('/api/imports');assert.equal(listed.status,200);assert.equal(listed.data.drafts.length,1);assert.equal(listed.data.drafts[0].id,own.data.id);assert.deepEqual(listed.data.drafts[0].context,{bookId:'book-target',targetId:null});
  await f.request(`/api/imports/${own.data.id}/confirm`,'POST',{type:'text',title:'正文'});assert.deepEqual((await f.request('/api/imports')).data.drafts,[]);
});

test('confirmed filtering of all nonbody lines leaves a readable empty PDF source',async t=>{
  const f=await fixture(t,{extractChapterPage:async()=>({text:'章末页眉'}),proposal:()=>({chapters:[{title:'正文',startPage:1,endPage:1,needsReview:false}],exclusions:[{page:1,startLine:1,endLine:1,reason:'仅含重复页眉的插图页'}]})}),form=new FormData();
  form.append('files',new Blob([blankPdf()],{type:'application/pdf'}),'book.pdf');const stage=await f.request('/api/imports','POST',form),path=`/api/imports/${stage.data.id}`;
  await f.request(path+'/chapters','POST',{type:'scan_pdf'});const proposal=await f.waitChapters(path);
  const saved=await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters:proposal.data.chapters,exclusions:proposal.data.exclusions});assert.equal(saved.status,201);
  const source=f.attached[0].values[0];assert.equal(source.text,'');assert.equal(source.status,'ready');assert.equal(source.firstExtraction.text,'章末页眉');
});


test('PDF page previews render PNG once, reuse persistent cache, and never start OCR or AI',async t=>{
  let renders=0,cleanups=0,temporaryPath,release;
  const gate=new Promise(resolve=>release=resolve);
  const f=await fixture(t,{renderSourcePreview:async source=>{
    renders++;await gate;
    const rendered=await renderImportedSource(source);temporaryPath=rendered.path;
    return {path:rendered.path,async cleanup(){cleanups++;await rendered.cleanup();}};
  }}),form=new FormData(),original=blankPdf(2);
  form.append('files',new Blob([original],{type:'application/pdf'}),'preview.pdf');
  const stage=await f.request('/api/imports','POST',form);assert.equal(stage.status,201);
  const file=stage.data.files[0],base=`/api/imports/${stage.data.id}/files/${file.id}`;
  const requests=[f.request(base+'/pages/1'),f.request(base+'/pages/1')];
  await new Promise(resolve=>setImmediate(resolve));release();
  const [first,concurrent]=await Promise.all(requests);
  assert.equal(first.status,200);assert.equal(first.headers.get('content-type'),'image/png');
  assert.deepEqual(first.data.subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
  assert.deepEqual(concurrent.data,first.data);assert.equal(renders,1);assert.equal(cleanups,1);
  await assert.rejects(stat(temporaryPath),{code:'ENOENT'});
  const cache=join(f.storageDir,'imports',stage.data.id,'previews',file.id,'1.png');
  assert.deepEqual(await readFile(cache),first.data);
  const before=new Date('2020-01-01T00:00:00Z');await utimes(cache,before,before);
  const cached=await f.request(base+'/pages/1');assert.deepEqual(cached.data,first.data);assert.equal(renders,1);assert.equal((await stat(cache)).mtimeMs,before.getTime());
  const originalPath=JSON.parse(f.database.prepare('SELECT draft_json FROM import_drafts WHERE id=?').get(stage.data.id).draft_json).files[0].filePath;
  assert.deepEqual(await readFile(originalPath),original);assert.equal(f.extractions.length,0);assert.equal(f.proposals.length,0);
});

test('PDF page preview validates ownership, file type and actual integer page before rendering',async t=>{
  let renders=0;const f=await fixture(t,{renderSourcePreview:()=>{renders++;throw new Error('must not render');}}),form=new FormData();
  form.append('files',new Blob([blankPdf(2)],{type:'application/pdf'}),'preview.pdf');
  const stage=await f.request('/api/imports','POST',form),file=stage.data.files[0],base=`/api/imports/${stage.data.id}/files/${file.id}`;
  for(const page of ['0','-1','3','1.5','abc','9007199254740992'])assert.equal((await f.request(base+'/pages/'+page)).status,400,page);
  assert.equal((await f.request(base+'/pages/1','GET',undefined,'two')).status,404);
  assert.equal((await f.request(`/api/imports/${stage.data.id}/files/missing/pages/1`)).status,404);
  const text=await f.request('/api/imports','POST',{text:'原文。'});
  assert.equal((await f.request(`/api/imports/${text.data.id}/files/${text.data.files[0].id}/pages/1`)).status,400);
  assert.equal(renders,0);assert.equal(f.extractions.length,0);assert.equal(f.proposals.length,0);
});

function progressEpub(){return execFileSync('python3',['-c',`import io,sys
from zipfile import ZipFile
b=io.BytesIO()
with ZipFile(b,'w') as z:
 z.writestr('mimetype','application/epub+zip')
 z.writestr('META-INF/container.xml','<container><rootfiles><rootfile full-path="content.opf"/></rootfiles></container>')
 z.writestr('content.opf','<package><manifest><item id="c" href="c.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c"/></spine></package>')
 z.writestr('c.xhtml','<html><head><title>章</title></head><body><p>日本語の原文。</p></body></html>')
sys.stdout.buffer.write(b.getvalue())`]);}

for(const type of ['photo','epub','text','scan_pdf'])test(`${type} import progress counts parsed files and confirmation without claiming source preparation`,async t=>{
  const f=await fixture(t),count=type==='photo'?2:1;
  let staged;
  if(type==='text')staged=await f.request('/api/imports','POST',{text:'原文。',title:'資料'});
  else{
    const form=new FormData(),bytes=type==='epub'?progressEpub():type==='scan_pdf'?blankPdf(3):Buffer.from([137,80,78,71,13,10,26,10]);
    for(let index=0;index<count;index++)form.append('files',new Blob([bytes],{type:type==='epub'?'application/epub+zip':type==='scan_pdf'?'application/pdf':'image/png'}),`${index}.${type==='epub'?'epub':type==='scan_pdf'?'pdf':'png'}`);
    staged=await f.request('/api/imports','POST',form);
  }
  assert.equal(staged.status,201);const id=staged.data.id;
  const draft=(await f.request(`/api/tasks/${id}`)).data;
  assert.equal(draft.status,'draft');assert.equal(draft.archived,false);assert.deepEqual(draft.progress,{completed:count,total:count+1,unit:'step'});
  assert.equal(draft.steps.find(step=>step.step==='confirm').status,'requires_review');
  assert.equal(draft.steps.some(step=>step.step==='extract'),false,'on-demand source extraction is a separate task');
  const saved=await f.request(`/api/imports/${id}/confirm`,'POST',{type,title:'資料',asBook:type==='epub'});assert.equal(saved.status,201);
  const archived=(await f.request(`/api/tasks/${id}`)).data;
  assert.equal(archived.status,'completed');assert.equal(archived.archived,true);assert.deepEqual(archived.progress,{completed:count+1,total:count+1,unit:'step'});
  assert.equal(archived.steps.find(step=>step.step==='confirm').status,'completed');
  assert.ok(f.attached.flatMap(item=>item.values).every(source=>source.status!=='ready'),'import completion must not mark source correction/annotation ready');
  assert.equal(f.extractions.length,0);assert.equal(f.proposals.length,0);
});

test('a failed EPUB parse does not count parsing or confirmation as completed',async t=>{
  const f=await fixture(t,{inspectFile:async()=>{throw Object.assign(new Error('parser unavailable'),{status:503,expose:true});}}),form=new FormData();
  form.append('files',new Blob([progressEpub()],{type:'application/epub+zip'}),'book.epub');
  const staged=await f.request('/api/imports','POST',form);assert.equal(staged.status,201);
  const task=(await f.request(`/api/tasks/${staged.data.id}`)).data;
  assert.equal(task.status,'failed');assert.equal(task.archived,false);assert.deepEqual(task.progress,{completed:0,total:2,unit:'step'});
  assert.equal(task.steps.find(step=>step.step==='parse').status,'failed');assert.equal(task.steps.find(step=>step.step==='confirm').status,'dependency_wait');assert.equal(f.createCalls,0);
});

test('PDF chapter extraction progress stays page-based and reports partial OCR checkpoints',async t=>{
  let release,entered;const gate=new Promise(resolve=>release=resolve),started=new Promise(resolve=>entered=resolve);t.after(()=>release());
  const f=await fixture(t,{extractChapterPage:async source=>{if(source.original.page===2){entered();await gate;}return{text:'原文。'};}}),form=new FormData();
  form.append('files',new Blob([blankPdf(3)],{type:'application/pdf'}),'book.pdf');
  const staged=await f.request('/api/imports','POST',form),path=`/api/imports/${staged.data.id}`;
  assert.equal((await f.request(path+'/chapters','POST',{type:'scan_pdf'})).status,202);await started;
  const partial=(await f.request(`/api/tasks/${staged.data.id}`)).data;
  assert.equal(partial.status,'running');assert.deepEqual(partial.progress,{completed:1,total:3,unit:'page'});assert.equal(partial.archived,false);
  assert.deepEqual(partial.steps.find(step=>step.step==='extract').children.map(step=>step.status),['completed','running','dependency_wait']);
  release();const completed=await f.waitChapters(path);
  const review=(await f.request(`/api/tasks/${staged.data.id}`)).data;assert.equal(review.status,'requires_review');assert.deepEqual(review.progress,{completed:3,total:3,unit:'page'});assert.equal(review.archived,false);
  assert.equal((await f.request(path+'/confirm','POST',{type:'scan_pdf',title:'本',asBook:true,chapters:completed.data.chapters})).status,201);
  const saved=(await f.request(`/api/tasks/${staged.data.id}`)).data;assert.equal(saved.archived,true);assert.deepEqual(saved.progress,{completed:3,total:3,unit:'page'});
});
