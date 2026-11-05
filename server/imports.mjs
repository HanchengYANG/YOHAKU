import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm, stat, copyFile, rename } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { IMPORT_TYPES, guessImportType, assertHomogeneousImport, validateConfirmedType, validateChapterRanges, groupParagraphs } from '../shared/import-types.mjs';
import { inspectImportFile, extractImportedSource, renderImportedSource } from './import-parsers.mjs';
import { createNdlOcr } from './ocr/ndl.mjs';
import { blocksToHtml } from '../shared/article-html.mjs';
import { parseText } from '../shared/document.mjs';
import { createLocalWorkerPool } from './ocr/worker-pool.mjs';
const fail=(status,message)=>Object.assign(new Error(message),{status,expose:true});
const utf8Name=value=>{
  const text=String(value||'');
  if([...text].some(character=>character.charCodeAt(0)>255))return text;
  try{return new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(text,'latin1'));}catch{return text;}
};
const cleanName=value=>basename(utf8Name(value||'导入文件').replaceAll('\\','/')).replace(/[\x00-\x1f\x7f]/g,'').slice(0,200)||'导入文件';
const titleInput=(value,fallback)=>{
  const title=value===undefined?fallback:value;
  if(typeof title!=='string'||!title.trim()||title.trim().length>160)throw fail(400,'标题需要填写，最多 160 个字符。');
  return title.trim();
};
const isPdf=type=>type==='text_pdf'||type==='scan_pdf';
const publicFile=file=>{
  const {filePath,text,info,imageId,...value}=file;
  return {...value,...(info?.pageCount?{pageCount:info.pageCount}:{}),...(info?.toc?{toc:info.toc}:{}),...(info?.chapters?{chapters:info.chapters.map(({id,title})=>({id,title}))}:{}),...(info?.error?{extractionError:info.error}:{})};
};

export function attachImportRoutes({app,database,storageDir,ai,sources,books,createImportedArticle,requireDocument,extractChapterPage,renderSourcePreview=renderImportedSource,localOcr:providedOcr,inspectFile=inspectImportFile}) {
  database.exec(`CREATE TABLE IF NOT EXISTS import_drafts (
    id TEXT PRIMARY KEY,user_id TEXT NOT NULL,title TEXT NOT NULL,type TEXT NOT NULL,
    status TEXT NOT NULL,draft_json TEXT NOT NULL,result_json TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS import_drafts_owner ON import_drafts(user_id,created_at);
  CREATE TABLE IF NOT EXISTS import_page_extractions(import_id TEXT NOT NULL,file_id TEXT NOT NULL,page INTEGER NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(import_id,file_id,page));`);
  const columns=database.prepare('PRAGMA table_info(import_drafts)').all().map(column=>column.name);
  for(const [name,definition] of [['version','INTEGER NOT NULL DEFAULT 1'],['task_generation','INTEGER NOT NULL DEFAULT 1'],['task_deleted_at','TEXT']])if(!columns.includes(name))database.exec(`ALTER TABLE import_drafts ADD COLUMN ${name} ${definition}`);
  const localOcr=providedOcr||createNdlOcr(),jobs=new Map(),previewJobs=new Map();let closed=false;
  const parserPool=createLocalWorkerPool({method:'inspect',workers:process.env.LOCAL_PARSE_WORKERS||1,label:'本地文件解析',create(){
    const controller=new AbortController();return{inspect:input=>inspectFile({...input,signal:controller.signal}),close:()=>controller.abort()};
  }});
  async function inspectFileEntry(file,{signal,onStatus}={}){
    file.inspection={status:'queued'};let started;
    try{
      const info=await parserPool.inspect({filePath:file.filePath,type:file.type},{signal,onStatus:status=>{
        if(status.state==='running')started=performance.now();
        file.inspection={status:status.state,execution:status};onStatus?.(status);
      }});
      file.info=info;file.type=info.detectedType||file.type;
      file.inspection={...file.inspection,status:'completed',finishedAt:new Date().toISOString(),
        execution:{...file.inspection.execution,elapsedMs:Math.round(performance.now()-(started??performance.now()))}};
      return true;
    }catch(error){
      file.info={...(file.info||{}),detectedType:file.type,error:error.expose?error.message:'本地文件解析未完成，请重试。'};
      file.inspection={...file.inspection,status:error.status===504?'timeout':'failed',error:file.info.error,httpStatus:error.status||502,finishedAt:new Date().toISOString(),
        execution:{...file.inspection.execution,elapsedMs:started===undefined?0:Math.round(performance.now()-started)}};
      return false;
    }
  }
  const cachedResults=(draft,file,page)=>{const row=database.prepare('SELECT result_json FROM import_page_extractions WHERE import_id=? AND file_id=? AND page=?').get(draft.id,file.id,page);return row?JSON.parse(row.result_json):null;};
  const cachedPage=(draft,file,page,type)=>cachedResults(draft,file,page)?.byType?.[type]||null;
  function cachePage(draft,file,page,type,result){
    const previous=cachedResults(draft,file,page),stored=previous?.byType?previous:previous?{legacy:previous}:{};
    stored.byType={...(stored.byType||{}),[type]:result};
    database.prepare('INSERT INTO import_page_extractions VALUES(?,?,?,?,?) ON CONFLICT(import_id,file_id,page) DO UPDATE SET result_json=excluded.result_json')
      .run(draft.id,file.id,page,JSON.stringify(stored),new Date().toISOString());
  }
  const extractPage=extractChapterPage||(async(source,{signal}={})=>{
    if(source.type==='text_pdf')return extractImportedSource(source,{signal});
    const rendered=await renderImportedSource(source,{signal});
    try{const result=await localOcr.recognize(rendered.path,{allowEmpty:true,signal});return {...result,text:result.text??result.regions.map(region=>region.text).join('\n')};}
    finally{await rendered.cleanup();}
  });
  const upload=multer({storage:multer.memoryStorage(),limits:{fileSize:50*1024*1024,files:100,fields:4,fieldSize:200000}});
  function get(userId,id) {
    const row=database.prepare('SELECT * FROM import_drafts WHERE id=? AND user_id=?').get(id,userId);
    if(!row)throw fail(404,'找不到这次导入。');
    const draft=JSON.parse(row.draft_json);
    draft.title=utf8Name(draft.title);draft.files=draft.files.map(file=>({...file,name:cleanName(file.name)}));
    return {...draft,status:row.status,version:row.version,generation:row.task_generation,taskDeletedAt:row.task_deleted_at,result:row.result_json?JSON.parse(row.result_json):null};
  }
  const present=draft=>({id:draft.id,taskId:taskId(draft),version:draft.version,title:draft.title,detectedType:draft.detectedType,allowedTypes:IMPORT_TYPES.filter(type=>
    isPdf(draft.detectedType)?isPdf(type):['photo','screenshot'].includes(draft.detectedType)?['photo','screenshot'].includes(type):type===draft.detectedType),
    files:draft.files.map(publicFile),context:draft.context||{bookId:null,targetId:null},chapters:draft.chapters||[],exclusions:draft.exclusions||[],chapterAttempted:draft.chapterAttempted===true,...(draft.chapterProcessing?{chapterProcessing:draft.chapterProcessing}:{}),...(draft.chapterError?{chapterError:draft.chapterError}:{}),status:draft.status,...(draft.execution?{execution:draft.execution}:{}),...(draft.result?{result:draft.result}:{}),
    ...(draft.files.some(file=>file.info?.error)?{extractionWarning:'部分来源提取失败。可以继续导入，并在校对正文中对照原文人工录入。'}:{})});
  function persist(draft) {
    database.prepare('UPDATE import_drafts SET title=?,type=?,status=?,draft_json=?,updated_at=?,version=version+1 WHERE id=? AND user_id=?')
      .run(draft.title,draft.detectedType,draft.status,JSON.stringify({...draft,result:undefined}),new Date().toISOString(),draft.id,draft.userId);
  }
  // A restart keeps every completed local extraction. A new explicit attempt
  // resumes those pages without silently repeating a provider request.
  for(const row of database.prepare("SELECT * FROM import_drafts WHERE status='staged'").all()){
    const draft=JSON.parse(row.draft_json);
    if(['queued','extracting','proposing'].includes(draft.chapterProcessing?.status)){
      draft.chapterError='分章准备被服务重启中断。请重试；已完成的本地提取会继续复用。';
      draft.chapterProcessing={...draft.chapterProcessing,status:'failed',error:draft.chapterError};persist(draft);
    }
    if(['queued','running'].includes(draft.inspectionProcessing?.status)){
      const error='原文件解析被服务重启中断。请重试；已经解析成功的文件会继续复用。';
      draft.inspectionProcessing={status:'failed',error};
      for(const file of draft.files)if(['queued','running'].includes(file.inspection?.status))file.inspection={...file.inspection,status:'failed',error};
      persist(draft);
    }
  }
  function validAttempt(userId,id,generation){return !closed&&!!database.prepare('SELECT id FROM import_drafts WHERE id=? AND user_id=? AND task_generation=? AND task_deleted_at IS NULL').get(id,userId,generation);}
  async function prepareChapters(userId,id,type,generation,signal){
    if(closed)return;
    let draft;
    try{
      if(!validAttempt(userId,id,generation))return;
      draft=get(userId,id);const file=draft.files[0],totalPages=file.info.pageCount,pages=[];
      draft.chapterProcessing={...draft.chapterProcessing,status:'extracting',startedAt:new Date().toISOString()};persist(draft);
      for(let page=1;page<=totalPages;page++){
        if(!validAttempt(userId,id,generation))return;
        let result=cachedPage(draft,file,page,type);
        if(!result){
          const started=performance.now();
          result=await extractPage({type,original:{filePath:file.filePath,page}}, {signal});
          if(!validAttempt(userId,id,generation))return;
          if(typeof result.text!=='string')throw fail(502,`PDF 第 ${page} 页未返回有效的本地提取结果。`);
          result={...result,execution:{...(result.execution||{}),elapsedMs:Math.round(performance.now()-started)}};
          cachePage(draft,file,page,type,result);
        }
        pages.push({page,text:result.text});
        draft.chapterProcessing={...draft.chapterProcessing,status:'extracting',type,completedPages:page,totalPages};persist(draft);
      }
      if(!validAttempt(userId,id,generation))return;
      draft.chapterProcessing={...draft.chapterProcessing,status:'proposing',type,completedPages:totalPages,totalPages,extractionFinishedAt:new Date().toISOString(),proposalStartedAt:new Date().toISOString()};persist(draft);
      const onStatus=status=>{
        if(!validAttempt(userId,id,generation))return;
        const state=typeof status==='string'?status:status?.state||status?.status;
        const {state:ignoredState,status:ignoredStatus,...execution}=typeof status==='object'?status:{};
        draft.chapterProcessing={...draft.chapterProcessing,providerState:state||'running',execution:status?.execution||execution};persist(draft);
      };
      const result=await ai.proposeChapters(userId,{metadata:{title:draft.title,pageCount:totalPages,fileName:file.name,type},pages,toc:file.info.toc||[],priority:'background',groupKey:`import:${id}`,signal,onStatus});
      if(!validAttempt(userId,id,generation))return;
      const chapters=Array.isArray(result)?result:result?.chapters;
      if(!Array.isArray(chapters)||!chapters.length)throw fail(502,'AI 未返回可用的章节建议，可重试，或对照原文件手动添加章节。');
      const proposed=chapters.map((chapter,index)=>({id:randomUUID(),title:String(chapter.title||`第 ${index+1} 章`).slice(0,160),startPage:chapter.startPage,endPage:chapter.endPage,excluded:chapter.excluded===true,needsReview:chapter.needsReview!==false}));
      validateChapterRanges(proposed.map(chapter=>({...chapter,needsReview:false})),totalPages);
      const exclusions=(result.exclusions||[]).map(value=>{
        const lines=pages[value.page-1]?.text.split('\n');
        if(!lines||!Number.isSafeInteger(value.startLine)||!Number.isSafeInteger(value.endLine)||value.startLine<1||value.endLine<value.startLine||value.endLine>lines.length)throw fail(502,'AI 排除内容的原文行号无效，请重试分章。');
        return {page:value.page,startLine:value.startLine,endLine:value.endLine,reason:String(value.reason||'非正文内容').slice(0,500),text:lines.slice(value.startLine-1,value.endLine).join('\n'),excluded:true};
      });
      draft.chapters=proposed;draft.exclusions=exclusions;draft.chapterProposalType=type;if(result.execution)draft.execution=result.execution;
      delete draft.chapterError;draft.chapterProcessing={...draft.chapterProcessing,status:'done',type,completedPages:totalPages,totalPages,finishedAt:new Date().toISOString()};persist(draft);
    }catch(error){
      if(!draft||!validAttempt(userId,id,generation))return;
      draft.chapterError=error.expose?error.message:'AI 分章未完成，可重试，或对照原文件手动添加章节。';
      draft.chapterProcessing={...draft.chapterProcessing,status:error.status===504?'timeout':'failed',error:draft.chapterError,finishedAt:new Date().toISOString(),execution:error.execution};persist(draft);
    }
  }
  app.post('/api/imports', (req,res,next)=> {
    if(req.is('multipart/form-data'))upload.array('files',100)(req,res,next);else next();
  },async(req,res)=>{
    const files=req.files||[];
    if(files.length && typeof req.body?.text==='string' && req.body.text.trim())throw fail(400,'文件和粘贴文字请分别导入，不支持混合类型。');
    const pasted=!files.length && typeof req.body?.text==='string'?req.body.text:null;
    if(pasted!==null && (!pasted.trim()||pasted.length>2_000_000))throw fail(400,'粘贴正文需要填写，最多 2000000 个字符。');
    if(!files.length && pasted===null)throw fail(400,'请先上传文件或粘贴文字。');
    if(files.reduce((sum,file)=>sum+file.size,0)>200*1024*1024)throw fail(413,'单次导入最大 200 MB，请分批上传。');
    const detected=files.map(file=>guessImportType({name:file.originalname,mimeType:file.mimetype,head:file.buffer.subarray(0,4096)}));
    if(files.length)assertHomogeneousImport(detected);
    const id=randomUUID(),directory=join(storageDir,'imports',id),now=new Date().toISOString();
    const context={bookId:req.body?.bookId||null,targetId:req.body?.targetId||null};
    if([context.bookId,context.targetId].some(value=>value!==null&&(typeof value!=='string'||value.length>160)))throw fail(400,'导入目标格式无效。');
    const draft={id,userId:req.user.id,context,title:titleInput(typeof req.body?.title==='string'&&!req.body.title.trim()?undefined:req.body?.title,pasted!==null?'粘贴文字':cleanName(files[0]?.originalname).replace(/\.[^.]+$/,'').slice(0,160)),detectedType:pasted!==null?'text':detected[0],files:[],chapters:[],status:'staged'};
    await mkdir(directory,{recursive:true,mode:0o700});
    try {
      const incoming=pasted!==null?[{buffer:Buffer.from(pasted),originalname:'粘贴文字.txt',mimetype:'text/plain'}]:files;
      for(let index=0;index<incoming.length;index++) {
        const uploaded=incoming[index],fileId=randomUUID(),filePath=join(directory,fileId);
        await writeFile(filePath,uploaded.buffer,{mode:0o400,flag:'wx'});
        const type=pasted!==null?'text':detected[index];
        const file={id:fileId,name:cleanName(uploaded.originalname),mimeType:uploaded.mimetype||'application/octet-stream',bytes:uploaded.buffer.length,filePath,type,previewUrl:`/api/imports/${id}/files/${fileId}/raw`};
        const parsed=await inspectFileEntry(file);
        if(!parsed&&!isPdf(type)&&type!=='epub')throw fail(file.inspection.httpStatus,file.info.error);
        let imageId;
        if(type==='photo'||type==='screenshot') imageId=(await ai.saveImage(req.user.id,uploaded.buffer,{mimeType:uploaded.mimetype,originalName:cleanName(uploaded.originalname)})).id;
        draft.files.push({...file,...(imageId?{imageId}:{})});
      }
      draft.detectedType=assertHomogeneousImport(draft.files.map(file=>file.type));
      database.prepare('INSERT INTO import_drafts(id,user_id,title,type,status,draft_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(id,req.user.id,draft.title,draft.detectedType,'staged',JSON.stringify(draft),now,now);
    }catch(error){await rm(directory,{recursive:true,force:true});throw error;}
    res.status(201).json(present(draft));
  });
  app.get('/api/imports',(req,res)=>{
    const rows=database.prepare("SELECT id FROM import_drafts WHERE user_id=? AND status='staged' AND task_deleted_at IS NULL ORDER BY updated_at DESC LIMIT 30").all(req.user.id);
    res.json({drafts:rows.map(row=>present(get(req.user.id,row.id)))});
  });
  app.get('/api/imports/:id',(req,res)=>res.json(present(get(req.user.id,req.params.id))));
  function cachedPreview(draft,file,page) {
    const key=`${draft.id}:${file.id}:${page}`;
    if(previewJobs.has(key))return previewJobs.get(key);
    const job=(async()=>{
      const directory=join(storageDir,'imports',draft.id,'previews',file.id),path=join(directory,`${page}.png`);
      try {if((await stat(path)).isFile())return path;}
      catch(error){if(error.code!=='ENOENT')throw error;}
      await mkdir(directory,{recursive:true,mode:0o700});
      const temporary=join(directory,`${page}.${randomUUID()}.tmp`);
      let rendered;
      try {
        rendered=await renderSourcePreview({type:file.type,original:{filePath:file.filePath,page}});
        await copyFile(rendered.path,temporary);
        await rename(temporary,path);
        return path;
      } finally {
        await rm(temporary,{force:true});
        await rendered?.cleanup();
      }
    })();
    previewJobs.set(key,job);
    void job.then(()=>previewJobs.delete(key),()=>previewJobs.delete(key));
    return job;
  }
  app.get('/api/imports/:id/files/:fileId/pages/:page',async(req,res)=>{
    if(closed)throw fail(503,'导入服务正在停止，请稍后重试。');
    const draft=get(req.user.id,req.params.id),file=draft.files.find(file=>file.id===req.params.fileId);
    if(!file)throw fail(404,'找不到原始文件。');
    if(!isPdf(file.type))throw fail(400,'只有 PDF 文件可以按原页预览。');
    const page=Number(req.params.page);
    if(!/^\d+$/.test(req.params.page)||!Number.isSafeInteger(page)||page<1||!Number.isSafeInteger(file.info?.pageCount)||page>file.info.pageCount)
      throw fail(400,'请使用原 PDF 范围内的实际整数页码。');
    const path=await cachedPreview(draft,file,page);
    res.set({'X-Content-Type-Options':'nosniff','Cache-Control':'private, no-store'});
    res.type('image/png').sendFile(path);
  });
  app.get('/api/imports/:id/files/:fileId/raw',(req,res)=>{
    const draft=get(req.user.id,req.params.id),file=draft.files.find(file=>file.id===req.params.fileId);
    if(!file)throw fail(404,'找不到原始文件。');
    res.set({'X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; sandbox"});
    // Only safe formats are rendered inline; all paths come from the owned draft.
    res.type(file.type==='text'?'text/plain; charset=utf-8':isPdf(file.type)?'application/pdf':file.type==='epub'?'application/epub+zip':file.mimeType);
    res.sendFile(file.filePath);
  });
  app.post('/api/imports/:id/chapters',async(req,res)=>{
    if(closed)throw fail(503,'导入服务正在停止，请稍后重试。');
    const draft=get(req.user.id,req.params.id);
    if(draft.status==='confirmed')throw fail(409,'这次导入已经确认。');
    const type=validateConfirmedType(draft.detectedType,req.body?.type||draft.detectedType);
    if(!isPdf(type)||draft.files.length!==1)throw fail(400,'请一次选择一个 PDF 文件进行书籍分章。');
    const file=draft.files[0];if(!file.info?.pageCount)throw fail(422,'PDF 页数尚未提取成功，请检查本地 PDF 解析依赖后重试。');
    draft.title=titleInput(req.body?.title,draft.title);
    if(jobs.has(draft.id))return res.status(202).json(present(draft));
    startChapters(draft,type);
    res.status(202).json(present(get(req.user.id,draft.id)));
  });
  function startChapters(draft,type){
    if(draft.taskDeletedAt){
      database.prepare('UPDATE import_drafts SET task_generation=task_generation+1,task_deleted_at=NULL,version=version+1 WHERE id=? AND user_id=?').run(draft.id,draft.userId);
      draft=get(draft.userId,draft.id);
    }
    const file=draft.files[0];
    draft.chapterAttempted=true;draft.chapterAttemptType=type;delete draft.chapterError;
    if(draft.chapterProposalType!==type){draft.chapters=[];draft.exclusions=[];delete draft.chapterProposalType;delete draft.execution;}
    const completedPages=database.prepare('SELECT result_json FROM import_page_extractions WHERE import_id=? AND file_id=?').all(draft.id,file.id).filter(row=>JSON.parse(row.result_json)?.byType?.[type]).length;
    draft.chapterProcessing={status:'queued',type,completedPages,totalPages:file.info.pageCount,queuedAt:new Date().toISOString()};persist(draft);
    const controller=new AbortController(),generation=draft.generation||1;
    const job=Promise.resolve().then(()=>prepareChapters(draft.userId,draft.id,type,generation,controller.signal));
    jobs.set(draft.id,{promise:job,controller,generation});
    void job.finally(()=>{if(jobs.get(draft.id)?.generation===generation)jobs.delete(draft.id);}).catch(()=>{});
  }
  function startInspection(draft){
    if(draft.taskDeletedAt){database.prepare('UPDATE import_drafts SET task_generation=task_generation+1,task_deleted_at=NULL,version=version+1 WHERE id=? AND user_id=?').run(draft.id,draft.userId);draft=get(draft.userId,draft.id);}
    const controller=new AbortController(),generation=draft.generation||1;
    draft.inspectionProcessing={status:'queued'};persist(draft);
    const job=Promise.resolve().then(async()=>{
      try{
        for(const file of draft.files.filter(file=>file.info?.error)){
          if(!validAttempt(draft.userId,draft.id,generation))return;
          await inspectFileEntry(file,{signal:controller.signal,onStatus:status=>{
            if(!validAttempt(draft.userId,draft.id,generation))return;
            draft.inspectionProcessing={status:status.state,execution:status};persist(draft);
          }});
          if(!validAttempt(draft.userId,draft.id,generation))return;
          persist(draft);
        }
        if(!validAttempt(draft.userId,draft.id,generation))return;
        if(!draft.files.some(file=>file.info?.error))draft.detectedType=assertHomogeneousImport(draft.files.map(file=>file.type));
        draft.inspectionProcessing={status:draft.files.some(file=>file.info?.error)?'failed':'done'};persist(draft);
      }catch(error){
        if(!validAttempt(draft.userId,draft.id,generation))return;
        draft.inspectionProcessing={status:error.status===504?'timeout':'failed',error:error.expose?error.message:'本地文件解析未完成，请重试。'};persist(draft);
      }
    });
    jobs.set(draft.id,{promise:job,controller,generation});
    void job.finally(()=>{if(jobs.get(draft.id)?.generation===generation)jobs.delete(draft.id);}).catch(()=>{});
  }
  app.post('/api/imports/:id/inspect',(req,res)=>{
    if(closed)throw fail(503,'导入服务正在停止。');
    const draft=get(req.user.id,req.params.id);
    if(draft.status==='confirmed')throw fail(409,'这次导入已经确认。');
    if(!jobs.has(draft.id))startInspection(draft);
    res.status(202).json(present(get(req.user.id,draft.id)));
  });
  function descriptors(draft,file,type,range) {
    const base={importId:draft.id,fileId:file.id,filePath:file.filePath,name:file.name,mimeType:file.mimeType};
    const raw=file.previewUrl;
    if(type==='photo'||type==='screenshot')return [{id:file.id,type,original:{...base,imageId:file.imageId},preview:{kind:'image',url:raw},skipCorrection:type==='photo',firstExtractionLabel:type==='photo'?'AI 识别与校正结果':'本地 OCR 首次提取结果'}];
    if(isPdf(type)) {
      if(!file.info?.pageCount)throw fail(422,'PDF 原页范围尚不可用，请检查解析依赖后重新上传。');
      const start=range?.startPage||1,end=range?.endPage||file.info.pageCount;
      return Array.from({length:end-start+1},(_,index)=>{
        const page=start+index,extraction=cachedPage(draft,file,page,type),excluded=(draft.confirmedExclusions||[]).filter(value=>value.page===page),label=type==='scan_pdf'?'本地 OCR 首次提取结果':'PDF 首次提取结果';
        const text=extraction?.text.split('\n').filter((_line,i)=>!excluded.some(value=>value.startLine<=i+1&&value.endLine>=i+1)).join('\n');
        return {id:`${file.id}:page:${page}`,type,...(range&&(range.startOffset!==undefined||range.endOffset!==undefined)?{localRange:{start:page===start?(range.startOffset||0):0,...(page===end&&range.endOffset!==undefined?{end:range.endOffset}:{})}}:{}),original:{...base,page,...(range?.needsReview?{boundaryNeedsReview:true}:{}),...(excluded.length?{importExclusions:excluded}:{})},preview:{kind:'pdf',url:raw,page,pageCount:file.info.pageCount,...(range?.needsReview?{boundaryNeedsReview:true}:{})},firstExtractionLabel:label,
          ...(extraction?{text,firstExtraction:{...extraction,bodyHtml:blocksToHtml(parseText(extraction.text)),label},...(excluded.length?{importExclusions:excluded,execution:draft.execution,...(!text.trim()?{status:'ready',needsCorrection:false}:{})}:{})}:{})};
      });
    }
    if(type==='epub') {
      const chapters=range?.chapter?[range.chapter]:file.info.chapters;
      if(!chapters?.length)return [{type,original:base,preview:{kind:'text',text:'原始 EPUB 提取失败，请下载原文件对照。',url:raw},extractionError:file.info.error}];
      return chapters.flatMap((chapter,chapterIndex)=>chapter.groups.map((group,index)=>{
        const separator=chapterIndex<chapters.length-1&&index===chapter.groups.length-1;
        const text=group.text+(separator?'\n':''),bodyHtml=group.bodyHtml+(separator?'<p></p>':'');
        return {id:`${file.id}:${chapter.id}:group:${index+1}`,type,original:{...base,chapter:chapter.id,chapterTitle:chapter.title,chapterPath:chapter.path,group:index+1,snapshot:text,html:bodyHtml,chapterHtml:chapter.bodyHtml},preview:{kind:'html',html:bodyHtml,chapterTitle:chapter.title,group:index+1},text,bodyHtml,firstExtractionLabel:'EPUB 首次提取结果'};
      }));
    }
    return groupParagraphs(file.info.text||'').map((group,index)=>({id:`${file.id}:group:${index+1}`,type:'text',original:{...base,snapshot:group.text,group:index+1,start:group.start,end:group.end},preview:{kind:'text',text:group.text,group:index+1},text:group.text,firstExtractionLabel:'首次提取结果'}));
  }
  app.post('/api/imports/:id/confirm',async(req,res)=>{
    const draft=get(req.user.id,req.params.id);
    if(draft.status==='confirmed')return res.json(draft.result);
    if(jobs.has(draft.id))throw fail(409,'正在准备章节，请等待完成后确认。');
    const type=validateConfirmedType(draft.detectedType,req.body?.type);
    const title=titleInput(req.body?.title,draft.title),asBook=req.body?.asBook===true;
    if(asBook&&['photo','screenshot'].includes(type))throw fail(400,'照片和截图请按文章导入；多张图片会组成一篇文章，可再将文章加入书籍。');
    const targetId=req.body?.targetId,requestedBookId=req.body?.bookId;
    if(targetId!==undefined&&(typeof targetId!=='string'||!targetId))throw fail(400,'目标文章无效。');
    if(requestedBookId!==undefined&&requestedBookId!==null&&(typeof requestedBookId!=='string'||!requestedBookId))throw fail(400,'请选择有效的书籍。');
    if(targetId && asBook)throw fail(400,'追加到文章时不能同时创建新书籍。');
    let chapters;
    if(asBook&&isPdf(type)){
      if(!draft.chapterAttempted&&!draft.chapters?.length)throw fail(409,'请先由 AI 提议章节，再核对标题与正文范围后确认。');
      if(draft.chapterAttemptType!==type)throw fail(409,'来源类型已改变，请按当前类型重新准备章节后确认。');
      if(draft.files.length!==1)throw fail(400,'请一次选择一个 PDF 文件进行书籍分章。');
      chapters=validateChapterRanges(req.body?.chapters,draft.files[0].info?.pageCount).filter(chapter=>!chapter.excluded);
      const selected=req.body?.exclusions??draft.exclusions??[];
      if(!Array.isArray(selected))throw fail(400,'排除内容格式无效。');
      draft.confirmedExclusions=selected.filter(value=>value.excluded!==false).map(value=>{
        const original=draft.chapterProposalType===type&&(draft.exclusions||[]).find(candidate=>candidate.page===value.page&&candidate.startLine===value.startLine&&candidate.endLine===value.endLine);
        if(!original)throw fail(400,'排除范围必须来自本次原文分章建议。');return original;
      });
    }
    const result=books.transaction(()=>{
      let bookId=requestedBookId||null;
      if(bookId&&!books.requireBook(req.user.id,bookId))throw fail(404,'找不到这本书。');
      if(asBook){bookId=randomUUID();const now=new Date().toISOString();database.prepare('INSERT INTO books(id,title,owner_id,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)').run(bookId,title,req.user.id,now,now);}
      const created=[];
      function attach(article,values){const document=sources.createArticleSources(req.user.id,article.id,values);created.push(document||article);}
      if(targetId){
        const article=requireDocument(req.user.id,targetId);
        if(bookId&&(article.book_id||article.bookId)!==bookId)throw fail(400,'目标文章不属于选择的书籍。');
        sources.adoptDocument(req.user.id,targetId);
        attach({...article,id:targetId},draft.files.flatMap(file=>descriptors(draft,file,type)));
        bookId=article.book_id||article.bookId||null;
      }else if(asBook&&isPdf(type)){
        for(const chapter of chapters){const article=createImportedArticle(req.user.id,{title:chapter.title,kind:'book',bookId});attach(article,descriptors(draft,draft.files[0],type,chapter));}
      }else if(asBook&&type==='epub'){
        for(const file of draft.files)for(const chapter of file.info.chapters||[]){
          const values=descriptors(draft,file,type,{chapter});
          // Image-only cover/navigation spines have no extracted body groups.
          // Keep them in the original EPUB, without creating an empty article.
          if(!values.length)continue;
          const article=createImportedArticle(req.user.id,{title:chapter.title,kind:'book',bookId});attach(article,values);
        }
        if(!created.length)throw fail(422,'EPUB 章节尚未提取成功，请检查解析环境后重新上传。');
      }else{
        const article=createImportedArticle(req.user.id,{title,kind:bookId?'book':'article',bookId});
        attach(article,draft.files.flatMap(file=>descriptors(draft,file,type)));
      }
      const result={id:draft.id,bookId,documents:created,firstDocumentId:created[0]?.id};
      if(!result.firstDocumentId)throw fail(422,'文件未包含可创建的正文。');
      if(bookId&&!asBook)books.touch(req.user.id,bookId);
      draft.status='confirmed';draft.title=title;
      database.prepare('UPDATE import_drafts SET title=?,status=?,draft_json=?,result_json=?,updated_at=?,version=version+1 WHERE id=? AND user_id=?')
        .run(title,'confirmed',JSON.stringify({...draft,result:undefined}),JSON.stringify(result),new Date().toISOString(),draft.id,req.user.id);
      return result;
    });
    res.status(201).json(result);
  });
  function taskId(draft){return (draft.generation||1)===1?draft.id:`${draft.id}:g${draft.generation}`;}
  function taskDraft(userId,id){
    const nativeId=id.replace(/:g\d+$/,''),draft=get(userId,nativeId);
    if(draft.taskDeletedAt||taskId(draft)!==id)throw fail(404,'找不到这次导入任务。');
    return draft;
  }
  function taskFor(userId,id){
    const draft=taskDraft(userId,id),processing=draft.chapterProcessing||{},inspection=draft.inspectionProcessing||{},parseErrors=draft.files.filter(file=>file.info?.error);
    const pageTask=isPdf(draft.detectedType)&&!!(draft.chapterAttempted||draft.chapterProcessing);
    const status=draft.status==='confirmed'?'completed':['queued','running'].includes(inspection.status)?inspection.status:
      parseErrors.length?(parseErrors.some(file=>file.inspection?.status==='timeout')?'timeout':'failed'):
      ['failed','timeout'].includes(inspection.status)?inspection.status:
      ['failed','timeout'].includes(processing.status)?processing.status:['extracting','proposing'].includes(processing.status)?'running':
      processing.status==='queued'?'queued':processing.status==='done'?'requires_review':'draft';
    const total=processing.totalPages||draft.files[0]?.info?.pageCount||draft.files.length,completed=processing.completedPages||0;
    const steps=pageTask?[{id:'extract',step:'extract',title:'本地 PDF 提取',
      status:parseErrors.length||['queued','running'].includes(inspection.status)?'dependency_wait':completed===total?'completed':processing.status==='extracting'?'running':['failed','timeout'].includes(status)?status:'dependency_wait',
      progress:{completed,total,unit:'page'},startedAt:processing.startedAt,error:completed<total?draft.chapterError:null,
      ...(processing.startedAt&&processing.extractionFinishedAt?{execution:{elapsedMs:Date.parse(processing.extractionFinishedAt)-Date.parse(processing.startedAt)}}:{})}]:[];
    if(pageTask){
      const type=processing.type||draft.detectedType,path=`$.byType.${type}`;
      const cached=new Map(database.prepare('SELECT page,created_at,json_type(result_json,?) AS cached,json_extract(result_json,?) AS elapsed_ms FROM import_page_extractions WHERE import_id=? AND file_id=?')
        .all(path,path+'.execution.elapsedMs',draft.id,draft.files[0].id).filter(row=>row.cached).map(row=>[row.page,row]));
      steps[0].children=Array.from({length:total},(_,index)=>{const page=index+1,row=cached.get(page);return{id:`page:${page}`,step:'extract',title:`PDF 第 ${page} 页`,page,
        status:row?'completed':processing.status==='extracting'&&page===completed+1?'running':['failed','timeout'].includes(status)&&page===completed+1?status:'dependency_wait',
        ...(row?{finishedAt:row.created_at,execution:row.elapsed_ms==null?{}:{elapsedMs:row.elapsed_ms}}:{}),...(page===completed+1?{error:draft.chapterError}:{}),};});
    }
    if(pageTask)steps.push({id:'chapters',step:'chapters',title:'分章核对',status:processing.status==='done'?'completed':
      processing.status==='proposing'?(processing.providerState==='queued'?'resource_wait':'running'):completed===total&&['failed','timeout'].includes(status)?status:'dependency_wait',
      execution:draft.execution||processing.execution,error:completed===total?draft.chapterError:null,
      startedAt:processing.proposalStartedAt,finishedAt:processing.finishedAt});
    const parseSteps=draft.files.map(file=>({id:`parse:${file.id}`,step:'parse',title:file.name,status:file.info?.error?(file.inspection?.status==='timeout'?'timeout':'failed'):file.inspection?.status||'completed',
      execution:file.inspection?.execution,error:file.info?.error||null,finishedAt:file.inspection?.finishedAt}));
    steps.unshift({id:'parse',step:'parse',title:'原始文件解析',status:['queued','running'].includes(inspection.status)?inspection.status:parseErrors.some(file=>file.inspection?.status==='timeout')?'timeout':parseErrors.length?'failed':inspection.status==='failed'?'failed':'completed',
      children:parseSteps,error:inspection.error||parseErrors[0]?.info.error||null,progress:{completed:parseSteps.filter(step=>step.status==='completed').length,total:parseSteps.length,unit:'file'}});
    steps.push({id:'confirm',step:'confirm',title:'确认导入',status:draft.status==='confirmed'?'completed':parseErrors.length||['queued','running','failed','timeout'].includes(inspection.status)||['queued','extracting','proposing'].includes(processing.status)?'dependency_wait':'requires_review'});
    const progress=pageTask&&!parseErrors.length&&!['queued','running'].includes(inspection.status)?{completed,total,unit:'page'}:
      {completed:parseSteps.filter(step=>step.status==='completed').length+(draft.status==='confirmed'?1:0),total:parseSteps.length+1,unit:'step'};
    return {id,type:'import',importId:draft.id,generation:draft.generation,version:draft.version,title:draft.title,
      status:processing.status==='proposing'&&processing.providerState==='queued'?'resource_wait':status,state:status,createdAt:database.prepare('SELECT created_at FROM import_drafts WHERE id=?').get(draft.id).created_at,
      updatedAt:database.prepare('SELECT updated_at FROM import_drafts WHERE id=?').get(draft.id).updated_at,
      documentId:draft.result?.firstDocumentId||null,bookId:draft.result?.bookId||draft.context?.bookId||null,
      archived:draft.status==='confirmed',canRetry:['failed','timeout'].includes(status)&&!jobs.has(draft.id),
      canDelete:['failed','timeout'].includes(status)&&!jobs.has(draft.id),canOpenResult:true,
      progress,steps,error:parseErrors[0]?.info.error||inspection.error||draft.chapterError||null,execution:draft.execution,
      files:draft.files.map(publicFile),draft:present(draft)};
  }
  const taskAdapter={type:'import',
    list:userId=>database.prepare('SELECT id FROM import_drafts WHERE user_id=? AND task_deleted_at IS NULL').all(userId).map(row=>{const draft=get(userId,row.id);return taskFor(userId,taskId(draft));}),
    get:taskFor,
    retry(userId,id,{version}){
      const draft=taskDraft(userId,id),task=taskFor(userId,id);
      if(version!==task.version||!task.canRetry)throw fail(409,'导入任务已更新或仍在执行，请刷新后重试。');
      if(draft.files.some(file=>file.info?.error)||['failed','timeout'].includes(draft.inspectionProcessing?.status))startInspection(draft);
      else startChapters(draft,draft.chapterAttemptType||draft.detectedType);
      return taskFor(userId,id);
    },
    delete(userId,id,{version}){
      const draft=taskDraft(userId,id),task=taskFor(userId,id);
      if(version!==task.version||!task.canDelete)throw fail(409,'只有已经停止执行的失败导入可以删除。');
      database.prepare('UPDATE import_drafts SET task_deleted_at=?,version=version+1 WHERE id=? AND user_id=?').run(new Date().toISOString(),draft.id,userId);
    }};
  function invalidateTarget(userId,{documentId,bookId}={}){
    for(const row of database.prepare("SELECT id FROM import_drafts WHERE user_id=? AND status='staged' AND task_deleted_at IS NULL").all(userId)){
      const draft=get(userId,row.id);
      if(!(documentId&&draft.context?.targetId===documentId)&&!(bookId&&draft.context?.bookId===bookId))continue;
      const error='关联的书籍或文章已删除，导入执行已停止；原文件和已完成结果仍保留。';
      if(draft.chapterProcessing)draft.chapterProcessing={...draft.chapterProcessing,status:'failed',error,finishedAt:new Date().toISOString()};
      if(draft.inspectionProcessing)draft.inspectionProcessing={...draft.inspectionProcessing,status:'failed',error};
      draft.chapterError=error;persist(draft);
      database.prepare('UPDATE import_drafts SET task_deleted_at=?,version=version+1 WHERE id=? AND user_id=?').run(new Date().toISOString(),draft.id,userId);
      jobs.get(draft.id)?.controller.abort();
    }
  }
  return {taskAdapter,invalidateTarget,close(){closed=true;for(const job of jobs.values())job.controller.abort();parserPool.close();if(!providedOcr)localOcr.close();},
    async drain(){await Promise.allSettled([...jobs.values()].map(job=>job.promise));await Promise.allSettled([...previewJobs.values()]);}};
}
