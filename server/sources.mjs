import { randomUUID, createHash } from 'node:crypto';
import * as body from '../shared/article-html.mjs';
import { parseText, serializeBlocks } from '../shared/document.mjs';
import { paginateReadingText, sliceReadingHtml, changedTextRange, remapReadingOffset } from '../shared/reading-pages.mjs';
import { ocrRegionBlockType } from '../shared/ocr-correction.mjs';
import { diagnosticForError } from './ai/diagnostics.mjs';
import { executionUsage } from './ai/execution-usage.mjs';
import { mergeReadings } from './source-merge.mjs';
import { createSourceTaskAdapter } from './source-task-adapter.mjs';
import { createErrorLog } from './errors.mjs';
import { createReadingPositions } from './reading-positions.mjs';

const fail=(status,message)=>Object.assign(new Error(message),{status,expose:true});
const json=value=>JSON.stringify(value);
const decode=(value,fallback=null)=>value?JSON.parse(value):fallback;
const hash=html=>createHash('sha256').update(body.bodyText(html)).digest('hex');
const reviewToken=row=>row.status==='requires_review'&&row.proposal_json?createHash('sha256').update(row.proposal_json).digest('hex'):null;
const aliases={pdf_text:'text_pdf',pdf_scan:'scan_pdf'};
const types=new Set(['photo','screenshot','scan_pdf','text_pdf','epub','text','paste']);
const stages=['extract','correct','segment','annotate'];
const activeAttemptStates=['queued','running','retry_wait'];
const empty=()=>body.blocksToHtml(parseText(''));
const appendContinuous=(a,b)=>body.normalizeBodyHtml(a.slice(0,-4)+b.replace(/^<p\b[^>]*>/,''));
const privateKeys=new Set(['filePath','path','storagePath','directory']);
const publicMetadata=value=>Array.isArray(value)?value.map(publicMetadata):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([key])=>!privateKeys.has(key)).map(([key,item])=>[key,publicMetadata(item)])):value;
const sourceHtml=value=>typeof value.bodyHtml==='string'?body.normalizeBodyHtml(value.bodyHtml):body.blocksToHtml(parseText(value.text??''));
const paragraphs=html=>(body.normalizeBodyHtml(html).match(/<p\b[^>]*>[\s\S]*?<\/p>/g)||[]).map((html,index)=>({id:/data-paragraph-id="([^"]+)"/.exec(html)[1],position:index,html,text:body.bodyText(html)}));
const manualBoundaries=row=>!!(row.manual_boundaries??row.manual);
const sentenceLayout=html=>json(body.bodyRanges(html).sentences.map(({id,start,end})=>[id,start,end]));
function consecutivePdfPages(previous,current){
  if(!previous||!['text_pdf','scan_pdf'].includes(current.type)||previous.type!==current.type||manualBoundaries(previous))return false;
  const from=decode(previous.original_json,{}),to=decode(current.original_json,{});
  return ['importId','fileId'].every(key=>typeof to[key]==='string'&&to[key].trim()&&to[key]===from[key])&&
    Number.isSafeInteger(from.page)&&from.page>0&&Number.isSafeInteger(to.page)&&to.page===from.page+1&&
    decode(previous.range_json)?.end===undefined&&(decode(current.range_json)?.start??0)===0;
}

export function createSourceService({database,ai={},requireDocument,fromRow,now=()=>Date.now(),sessionTtlMs=45000,errorLog=createErrorLog(database),readingPositions=createReadingPositions(database)}={}) {
  const failure=(error,row,step)=>errorLog.capture(error,{userId:row.user_id,scope:'source',location:`source:${step}`,context:{documentId:row.document_id,sourceId:row.source_id}});
  // Read operations are synchronous: reuse their immutable database snapshot,
  // then discard it before any provider callback or later mutation can run.
  let readScope=null;
  const withReadScope=work=>{
    if(readScope)return work();
    readScope=new Map();
    try{return work();}finally{readScope=null;}
  };
  const readOnce=(kind,key,load)=>{
    if(!readScope)return load();
    let entries=readScope.get(kind);
    if(!entries)readScope.set(kind,entries=new Map());
    if(!entries.has(key))entries.set(key,load());
    return entries.get(key);
  };
  database.exec(`
    CREATE TABLE IF NOT EXISTS sources(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,type TEXT NOT NULL,original_json TEXT NOT NULL,preview_json TEXT NOT NULL,first_extraction_json TEXT,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS article_sources(scope_id TEXT PRIMARY KEY,document_id TEXT NOT NULL,user_id TEXT NOT NULL,source_id TEXT NOT NULL,position INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,checked_version INTEGER,manual INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL,next_step INTEGER NOT NULL,error TEXT,proposal_json TEXT,edit_session TEXT,edit_expires INTEGER,updated_at TEXT NOT NULL,UNIQUE(document_id,source_id));
    CREATE INDEX IF NOT EXISTS article_sources_document ON article_sources(user_id,document_id,position);
    CREATE TABLE IF NOT EXISTS source_fragments(scope_id TEXT NOT NULL,id TEXT NOT NULL,position INTEGER NOT NULL,html TEXT NOT NULL,text TEXT NOT NULL,version INTEGER NOT NULL,PRIMARY KEY(scope_id,id));
    CREATE TABLE IF NOT EXISTS source_revisions(scope_id TEXT NOT NULL,version INTEGER NOT NULL,step TEXT NOT NULL,body_html TEXT NOT NULL,execution_json TEXT,created_at TEXT NOT NULL,PRIMARY KEY(scope_id,version,step));
    CREATE TABLE IF NOT EXISTS source_steps(scope_id TEXT NOT NULL,step TEXT NOT NULL,input_version INTEGER NOT NULL,status TEXT NOT NULL,result_json TEXT,error TEXT,updated_at TEXT NOT NULL,PRIMARY KEY(scope_id,step,input_version));
    CREATE TABLE IF NOT EXISTS source_step_attempts(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,step TEXT NOT NULL,input_version INTEGER NOT NULL,state TEXT NOT NULL,queued_at TEXT,started_at TEXT,finished_at TEXT,updated_at TEXT NOT NULL,execution_json TEXT,diagnostic_json TEXT,message TEXT);
    CREATE INDEX IF NOT EXISTS source_attempts_scope ON source_step_attempts(scope_id,input_version,updated_at);
    CREATE TABLE IF NOT EXISTS source_annotations(scope_id TEXT NOT NULL,version INTEGER NOT NULL,start INTEGER NOT NULL,end INTEGER NOT NULL,execution_json TEXT,created_at TEXT NOT NULL,PRIMARY KEY(scope_id,version,start,end));
    CREATE TABLE IF NOT EXISTS reading_pages(id TEXT PRIMARY KEY,document_id TEXT NOT NULL,user_id TEXT NOT NULL,position INTEGER NOT NULL,ranges_json TEXT NOT NULL,created_at TEXT NOT NULL,UNIQUE(document_id,position));
    CREATE INDEX IF NOT EXISTS reading_pages_user ON reading_pages(user_id,document_id);
    CREATE TABLE IF NOT EXISTS reading_sessions(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document_id TEXT NOT NULL,mode TEXT NOT NULL,source_id TEXT,page_index INTEGER NOT NULL,active INTEGER NOT NULL,expires_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_preparation_requests(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,document_id TEXT NOT NULL,generation INTEGER NOT NULL,version INTEGER NOT NULL DEFAULT 1,signature TEXT,deleted_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS source_request_document ON source_preparation_requests(user_id,document_id,generation);
    CREATE TABLE IF NOT EXISTS source_preparation_jobs(user_id TEXT NOT NULL,document_id TEXT NOT NULL,mode TEXT NOT NULL,target TEXT NOT NULL,source_id TEXT,page_index INTEGER NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(user_id,document_id,mode,target));
  `);
  // Running steps resume from their persisted inputs after restart. Durable
  // preparation requests outlive browser sessions; completed steps are reused.
  if(!database.prepare('PRAGMA table_info(article_sources)').all().some(column=>column.name==='range_json'))database.exec('ALTER TABLE article_sources ADD COLUMN range_json TEXT');
  // NULL retains legacy manual boundary protection. New saves distinguish
  // touched readings/marks from human changes to text or sentence boundaries.
  if(!database.prepare('PRAGMA table_info(article_sources)').all().some(column=>column.name==='manual_boundaries'))database.exec('ALTER TABLE article_sources ADD COLUMN manual_boundaries INTEGER');
  if(!database.prepare('PRAGMA table_info(article_sources)').all().some(column=>column.name==='edit_revision'))database.exec('ALTER TABLE article_sources ADD COLUMN edit_revision INTEGER NOT NULL DEFAULT 0');
  for(const [column,type] of [['snapshot_json','TEXT'],['finished_at','TEXT'],['target_json','TEXT']])if(!database.prepare('PRAGMA table_info(source_preparation_requests)').all().some(value=>value.name===column))database.exec(`ALTER TABLE source_preparation_requests ADD COLUMN ${column} ${type}`);
  for(const table of ['source_step_attempts','source_preparation_jobs'])if(!database.prepare(`PRAGMA table_info(${table})`).all().some(value=>value.name==='request_id'))database.exec(`ALTER TABLE ${table} ADD COLUMN request_id TEXT`);
  if(!database.prepare('PRAGMA table_info(reading_sessions)').all().some(column=>column.name==='last_sequence'))database.exec('ALTER TABLE reading_sessions ADD COLUMN last_sequence INTEGER');
  database.exec('CREATE INDEX IF NOT EXISTS source_attempts_request ON source_step_attempts(request_id,scope_id,input_version,step)');
  database.prepare("UPDATE source_steps SET status='pending' WHERE status='running'").run();
  database.prepare("UPDATE source_step_attempts SET state='interrupted',finished_at=?,updated_at=? WHERE state IN ('queued','running','retry_wait')").run(new Date(now()).toISOString(),new Date(now()).toISOString());
  database.prepare("UPDATE article_sources SET status='pending' WHERE status='processing'").run();
  database.prepare('UPDATE reading_sessions SET active=0').run();
  const scopes=(userId,id)=>readOnce('scopes',json([userId,id]),()=>database.prepare('SELECT a.*,s.type,s.original_json,s.preview_json,s.first_extraction_json FROM article_sources a JOIN sources s ON s.id=a.source_id WHERE a.user_id=? AND a.document_id=? ORDER BY a.position').all(userId,id));
  const scope=(userId,id,sourceId)=>{
    requireDocument(userId,id);
    const row=database.prepare('SELECT a.*,s.type,s.original_json,s.preview_json,s.first_extraction_json FROM article_sources a JOIN sources s ON s.id=a.source_id WHERE a.user_id=? AND a.document_id=? AND a.source_id=?').get(userId,id,sourceId);
    if(!row)throw fail(404,'找不到当前文章的来源。');return row;
  };
  const fragments=row=>readOnce('fragments',row.scope_id,()=>database.prepare('SELECT * FROM source_fragments WHERE scope_id=? ORDER BY position').all(row.scope_id));
  const readHtml=row=>readOnce('html',row.scope_id,()=>fragments(row).map(f=>f.html).join('')||empty());
  const sourceLength=row=>readOnce('length',row.scope_id,()=>fragments(row).reduce((sum,fragment,index)=>sum+fragment.text.length+(index?1:0),0));
  const stamp=()=>new Date(now()).toISOString();
  let closed=false,stopping=false,scheduled=false;
  const working=new Map(),articleKey=(userId,id)=>json([userId,id]);
  const latestRequest=(userId,id)=>database.prepare('SELECT * FROM source_preparation_requests WHERE user_id=? AND document_id=? ORDER BY generation DESC LIMIT 1').get(userId,id);
  const currentRequestId=(userId,id)=>{
    const request=latestRequest(userId,id);
    return request?.deleted_at?null:request?.id||null;
  };
  function liveSourceNodes(userId,id){
    const nodes=new Set();let requestId;
    for(const {execution} of working.values()){
      if(execution.userId!==userId||execution.documentId!==id||execution.signal.aborted)continue;
      if(requestId===undefined)requestId=currentRequestId(userId,id);
      if(execution.requestId===requestId)for(const key of execution.nodes.keys())nodes.add(key);
    }
    return nodes;
  }
  const requestEnabled=(userId,id)=>!latestRequest(userId,id)?.deleted_at;
  const targetKey=target=>target.mode==='correction'?`correction:${target.sourceId}`:`reading:${target.index}`;
  function requestTargets(request,resolve=false){
    let targets=decode(request.target_json);
    if(!targets){
      const jobs=database.prepare('SELECT * FROM source_preparation_jobs WHERE user_id=? AND document_id=? AND (request_id=? OR request_id IS NULL)').all(request.user_id,request.document_id,request.id);
      targets=jobs.map(job=>job.mode==='correction'?{mode:'correction',sourceId:job.source_id}:{mode:'reading',index:job.page_index});
      if(!targets.length)targets=[{mode:'reading',index:database.prepare('SELECT page_index FROM reading_positions WHERE user_id=? AND document_id=?').get(request.user_id,request.document_id)?.page_index||0}];
      targets=[...new Map(targets.map(target=>[targetKey(target),target])).values()];
      database.prepare('UPDATE source_preparation_requests SET target_json=? WHERE id=? AND target_json IS NULL').run(json(targets),request.id);
      // Legacy requests did not record execution ownership. Adopt their native
      // history once; newer generations always bind at attempt creation.
      database.prepare('UPDATE source_step_attempts SET request_id=? WHERE request_id IS NULL AND scope_id IN (SELECT scope_id FROM article_sources WHERE user_id=? AND document_id=?)').run(request.id,request.user_id,request.document_id);
      database.prepare('UPDATE source_preparation_jobs SET request_id=? WHERE request_id IS NULL AND user_id=? AND document_id=?').run(request.id,request.user_id,request.document_id);
    }
    if(resolve&&!request.snapshot_json){
      const reading=targets.some(target=>target.mode==='reading')?readingPages(request.user_id,request.document_id):null;
      const rows=targets.some(target=>target.mode==='correction')?scopes(request.user_id,request.document_id):[];
      const resolved=targets.map(target=>{
        if(target.mode==='correction')return {...target,inputVersion:rows.find(row=>row.source_id===target.sourceId)?.version};
        const page=reading.pages[reading.complete?Math.min(target.index,reading.pages.length-1):target.index];
        return page?.ready?{...target,pageId:page.id,ranges:page.ranges,sourceVersions:page.sourceVersions}:target;
      });
      if(json(resolved)!==json(targets))database.prepare('UPDATE source_preparation_requests SET target_json=? WHERE id=? AND snapshot_json IS NULL').run(json(resolved),request.id);
      targets=resolved;
    }
    return targets;
  }
  function targetReady(userId,id,target){
    if(target.mode==='correction')return scopes(userId,id).find(row=>row.source_id===target.sourceId)?.next_step>=4;
    return !!readingPages(userId,id,target.index).currentPage?.ready;
  }
  function targetsReady(userId,id,targets){
    const requested=targets.filter(target=>!target.prefetch),required=requested.length?requested:targets;
    const reading=required.some(target=>target.mode==='reading')?readingPages(userId,id):null,rows=scopes(userId,id);
    return required.length>0&&required.every(target=>target.mode==='correction'?rows.find(row=>row.source_id===target.sourceId)?.next_step>=4:!!reading.pages[reading.complete?Math.min(target.index,reading.pages.length-1):target.index]?.ready);
  }
  function ensureRequest(userId,id,explicit=false,target){
    const previous=latestRequest(userId,id);
    if(previous&&!previous.deleted_at){
      const targets=requestTargets(previous);
      if(!previous.snapshot_json){
        if(target){
          const existing=targets.find(value=>targetKey(value)===targetKey(target));
          if(!existing)targets.push(target);
          else if(!target.prefetch)delete existing.prefetch;
          database.prepare('UPDATE source_preparation_requests SET target_json=? WHERE id=?').run(json(targets),previous.id);
        }
        return previous;
      }
      if(!target||targetReady(userId,id,target))return previous;
    }
    if(previous?.deleted_at&&!explicit)return null;
    const request={id:randomUUID(),user_id:userId,document_id:id,generation:(previous?.generation||0)+1,target_json:target?json([target]):null};
    database.prepare('INSERT INTO source_preparation_requests(id,user_id,document_id,generation,created_at,updated_at,target_json) VALUES(?,?,?,?,?,?,?)').run(request.id,userId,id,request.generation,stamp(),stamp(),request.target_json);return request;
  }
  const workValid=execution=>{
    if(!execution)return true;
    const request=latestRequest(execution.userId,execution.documentId);
    return !execution.signal.aborted&&request?.id===execution.requestId&&!request.deleted_at;
  };
  const optionsFor=execution=>execution?{signal:execution.signal,groupKey:articleKey(execution.userId,execution.documentId),getPriority:()=>database.prepare('SELECT 1 FROM reading_sessions WHERE user_id=? AND document_id=? AND active=1 AND expires_at>?').get(execution.userId,execution.documentId,now())?'foreground':'background'}:{};
  const overlapsWork=(row,step,range)=>[...working.values()].some(work=>work.reservations.some(ref=>{
    if(ref.scopeId!==row.scope_id||ref.version!==row.version)return false;
    if(['extract','correct'].includes(ref.step)||['extract','correct'].includes(step))return true;
    if(ref.step!==step)return false;
    return step!=='annotate'||!range||!ref.range||range.start<ref.range.end&&range.end>ref.range.start;
  }));
  const nativeFailedNodes=row=>readOnce('failedNodes',json([row.scope_id,row.version]),()=>database.prepare("SELECT step,error FROM source_steps WHERE scope_id=? AND input_version=? AND status='failed'").all(row.scope_id,row.version));
  const failedNodes=row=>nativeFailedNodes(row).filter(node=>{
    const range=/^annotate(?:_local)?:(\d+):(\d+)$/.exec(node.step);if(!range)return true;
    const start=Number(range[1]),end=Number(range[2]);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<=start)return true;
    // Successful same-version checkpoints supersede this gate, while the
    // original failed native result and attempt remain an unchanged journal.
    return !annotationCovered({...row,next_step:3},start,end);
  });
  const phaseOf=step=>step.startsWith('annotate')?'annotate':step;
  const phaseFailed=(row,phase)=>failedNodes(row).some(node=>phaseOf(node.step)===phase);
  function preserveFailure(row){
    const failed=failedNodes(row)[0];
    if(failed)database.prepare("UPDATE article_sources SET status='failed',error=? WHERE scope_id=? AND version=?").run(failed.error||'来源处理失败，请重试。',row.scope_id,row.version);
  }
  function retryFailedSteps(userId,documentId,sourceId){
    const rows=scopes(userId,documentId).filter(row=>!sourceId||row.source_id===sourceId);
    for(const row of rows){
      database.prepare("UPDATE source_steps SET status='pending',error=NULL WHERE scope_id=? AND input_version=? AND status='failed'").run(row.scope_id,row.version);
      database.prepare("UPDATE article_sources SET status='pending',error=NULL WHERE scope_id=? AND status='failed'").run(row.scope_id);
    }
  }
  const hasAnnotationBatch=()=>typeof ai.annotateBodies==='function'||typeof ai.prepareAnnotationBodies==='function'&&typeof ai.proofreadAnnotationBodies==='function';
  const transaction=work=>{const name=`source_${randomUUID().replaceAll('-','')}`;database.exec(`SAVEPOINT ${name}`);try{const result=work();database.exec(`RELEASE ${name}`);return result;}catch(error){database.exec(`ROLLBACK TO ${name}; RELEASE ${name}`);throw error;}};
  // Keep only execution identifiers, timings and safe usage counters. SDK errors and results can
  // contain requests, credentials and the entire source document.
  function executionMetadata(value={}) {
    const result={};
    for(const key of ['operationId','role','providerId','model'])if(typeof value?.[key]==='string'&&value[key].length<=240&&!/[\r\n]/.test(value[key]))result[key]=value[key];
    for(const key of ['configurationVersion','queueMs','elapsedMs','retryCount','retryWaitMs','retryDelayMs'])if(Number.isFinite(value?.[key])&&value[key]>=0)result[key]=value[key];
    for(const key of ['queuedAt','startedAt','nextRetryAt'])if(typeof value?.[key]==='string'&&Number.isFinite(Date.parse(value[key])))result[key]=new Date(value[key]).toISOString();
    return {...result,...executionUsage(value)};
  }
  function trackWorkNode(execution,row,step){
    if(!execution)return null;
    const key=json([row.scope_id,row.version,step]);
    if(!execution.nodes.has(key))execution.nodes.set(key,{scopeId:row.scope_id,version:row.version,step,attempts:[]});
    return execution.nodes.get(key);
  }
  function startAttempt(row,step,execution) {
    const id=randomUUID(),started=stamp();
    database.prepare("INSERT INTO source_step_attempts(id,scope_id,step,input_version,state,started_at,updated_at,request_id) VALUES(?,?,?,?,'running',?,?,?)").run(id,row.scope_id,step,row.version,started,started,execution?.requestId||null);
    const active=()=>!closed&&database.prepare('SELECT 1 FROM article_sources WHERE scope_id=? AND version=?').get(row.scope_id,row.version);
    const onStatus=event=>{
      if(!active()||!['queued','running','retry_wait'].includes(event?.state))return;
      const attempt=database.prepare('SELECT * FROM source_step_attempts WHERE id=?').get(id);
      if(!attempt||!['queued','running','retry_wait'].includes(attempt.state))return;
      const execution={...decode(attempt.execution_json,{}),...executionMetadata(event)},queuedAt=execution.queuedAt||attempt.queued_at;
      if(event.state!=='running')delete execution.startedAt;
      const startedAt=event.state==='running'?(execution.startedAt||stamp()):null;
      if(startedAt)execution.startedAt=startedAt;
      database.prepare('UPDATE source_step_attempts SET state=?,queued_at=?,started_at=?,updated_at=?,execution_json=? WHERE id=?').run(event.state,queuedAt,startedAt,stamp(),json(execution),id);
    };
    const finish=(state,value)=>{
      if(closed)return;
      const attempt=database.prepare('SELECT * FROM source_step_attempts WHERE id=?').get(id);
      if(!attempt||!['queued','running','retry_wait'].includes(attempt.state))return;
      const finalExecution=executionMetadata(value?.execution),execution={...decode(attempt.execution_json,{}),...finalExecution},finished=stamp();
      const startedAt=execution.startedAt||attempt.started_at,queuedAt=execution.queuedAt||attempt.queued_at;
      const counter={running:'elapsedMs',queued:'queueMs',retry_wait:'retryWaitMs'}[attempt.state];
      if(counter&&!Number.isFinite(finalExecution[counter])){
        const updatedAt=Date.parse(attempt.updated_at);
        if(Number.isFinite(updatedAt))execution[counter]=(Number.isFinite(execution[counter])?execution[counter]:0)+Math.max(0,now()-updatedAt);
      }
      if(!Number.isFinite(execution.elapsedMs)&&startedAt)execution.elapsedMs=Math.max(0,now()-Date.parse(startedAt));
      const diagnostic=['failed','requires_review'].includes(state)?diagnosticForError(value):null;
      const message=state==='failed'?failure(value,row,step):state==='requires_review'?'正文出现较大改动，请核对差异。':null;
      database.prepare('UPDATE source_step_attempts SET state=?,queued_at=?,started_at=?,finished_at=?,updated_at=?,execution_json=?,diagnostic_json=?,message=? WHERE id=?').run(state,queuedAt,startedAt,finished,finished,json(execution),diagnostic?json(diagnostic):null,message,id);
    };
    trackWorkNode(execution,row,step)?.attempts.push(finish);
    return {onStatus,finish};
  }
  function reservationsObsolete(work){
    const current=database.prepare('SELECT 1 FROM article_sources WHERE scope_id=? AND version=?');
    return work.reservations.length>0&&work.reservations.every(ref=>!current.get(ref.scopeId,ref.version));
  }
  function retireEditedWork(userId,documentId,scopeId){
    const retired=[];
    for(const work of working.values()){
      const {execution,reservations}=work;
      if(execution.userId!==userId||execution.documentId!==documentId||execution.signal.aborted||!reservations.some(ref=>ref.scopeId===scopeId))continue;
      // A late extraction may still preserve the immutable original preview.
      // A shared batch keeps its resource while any input is still current.
      if(reservations.some(ref=>ref.step==='extract')||!reservationsObsolete(work))continue;
      for(const node of execution.nodes.values()){
        for(const finish of node.attempts)finish('stale');
        database.prepare("UPDATE source_steps SET status='stale',updated_at=? WHERE scope_id=? AND step=? AND input_version=? AND status='running'").run(stamp(),node.scopeId,node.step,node.version);
      }
      retired.push(work);
    }
    return retired;
  }
  function abortRetiredWork(retired,reason=()=>new DOMException('来源正文版本已更新。','AbortError')){
    if(!retired.length)return;
    const abort=()=>{
      if(closed||database.isTransaction)return;
      for(const work of retired)if(!work.execution.signal.aborted&&reservationsObsolete(work))work.controller.abort(reason());
    };
    // Source edits and deletions commit their outermost transaction synchronously.
    // If a caller owns a surrounding transaction, check after that stack
    // commits or rolls back; never cancel against uncommitted versions.
    if(database.isTransaction)queueMicrotask(abort);else abort();
  }
  const sourceIdentity=row=>{
    const original=decode(row.original_json,{}),page=Number.isSafeInteger(original.page)&&original.page>0?original.page:null;
    const label=['text_pdf','scan_pdf'].includes(row.type)?page?`PDF 第${page}页`:`PDF 来源 ${row.position+1}`:['photo','screenshot'].includes(row.type)?`图片 ${row.position+1}`:row.type==='epub'?`EPUB 段落组 ${row.position+1}`:`原文段落组 ${row.position+1}`;
    return {id:row.source_id,type:row.type,position:row.position,...(page?{page}:{}),label};
  };
  function readingDiagnostics(userId,id,rows,page,requestId) {
    const failures=database.prepare("SELECT t.*,a.source_id,a.position,s.type,s.original_json FROM source_step_attempts t JOIN article_sources a ON a.scope_id=t.scope_id JOIN sources s ON s.id=a.source_id WHERE a.user_id=? AND a.document_id=? AND t.state IN ('failed','requires_review') ORDER BY t.updated_at DESC,t.rowid DESC LIMIT 5").all(userId,id);
    const recentFailures=failures.map(item=>({id:item.id,source:sourceIdentity(item),step:item.step,at:item.finished_at||item.updated_at,execution:decode(item.execution_json,{}),diagnostic:decode(item.diagnostic_json),message:item.message}));
    if(page?.ready)return {current:null,recentFailures};
    const relevant=page?rows.filter(row=>page.sourceIds.includes(row.source_id)&&globalRefs(row,page.ranges).filter(ref=>ref.sourceId===row.source_id).some(ref=>!annotationCovered(row,ref.start,ref.end))):rows;
    const pending=relevant.find(row=>row.next_step<3)||relevant.find(row=>row.next_step<4);
    // Before a page can be published, PDF segmentation can wait for the next
    // source's correction. Report that actual running dependency.
    let row=pending;
    if(!page&&pending?.next_step===2&&!manualBoundaries(pending)&&!['failed','requires_review'].includes(pending.status)&&['text_pdf','scan_pdf'].includes(pending.type)){
      const following=rows[rows.findIndex(row=>row.scope_id===pending.scope_id)+1];
      if(following&&following.next_step<2&&!manualBoundaries(following))row=following;
    }
    if(row===pending&&pending&&!['failed','requires_review'].includes(pending.status))row=relevant.find(row=>row.status==='processing'&&row.next_step<3)||pending;
    if(!row)return {current:null,recentFailures};
    const stage=stages[row.next_step],ranges=page?globalRefs(row,page.ranges).filter(ref=>ref.sourceId===row.source_id):null;
    const attempt=database.prepare('SELECT * FROM source_step_attempts WHERE scope_id=? AND input_version=? ORDER BY rowid DESC').all(row.scope_id,row.version).find(item=>{
      if(!item.step.startsWith(stage))return false;
      if(activeAttemptStates.includes(item.state)&&(!requestId||item.request_id!==requestId||item.finished_at))return false;
      const match=/^annotate(?:_local)?:(\d+):(\d+)$/.exec(item.step);
      return !ranges||!match||ranges.some(range=>Number(match[1])<range.end&&Number(match[2])>range.start);
    });
    // A completed annotation can leave the source pending while segmentation is still running.
    const frozen=row.edit_session&&row.edit_expires>now(),live=activeAttemptStates.includes(attempt?.state);
    const failed=['failed','requires_review'].includes(row.status)&&(!attempt||['failed','requires_review'].includes(attempt.state));
    const state=frozen?'editing':failed?row.status:live?attempt.state:'pending';
    const current={state,step:attempt&&(live||failed)?attempt.step:stage,source:sourceIdentity(row)};
    if(attempt&&(live||failed)){
      const execution=executionMetadata(decode(attempt.execution_json,{}));
      Object.assign(current,execution,{updatedAt:attempt.updated_at});
      if(attempt.queued_at)current.queuedAt=attempt.queued_at;
      if(attempt.started_at)current.startedAt=attempt.started_at;
      if(live&&state==='running'&&attempt.started_at)current.elapsedMs=(execution.elapsedMs||0)+Math.max(0,now()-Date.parse(attempt.updated_at));
      if(live&&state==='queued'&&attempt.queued_at)current.queueMs=(execution.queueMs||0)+Math.max(0,now()-Date.parse(attempt.updated_at));
    }
    if(failed)current.error={message:attempt?.message||row.error||'正文改动需要核对差异。',diagnostic:decode(attempt?.diagnostic_json)||diagnosticForError({})};
    return {current,recentFailures};
  }
  function replaceFragments(row,html) {
    database.prepare('DELETE FROM source_fragments WHERE scope_id=?').run(row.scope_id);
    const insert=database.prepare('INSERT INTO source_fragments VALUES(?,?,?,?,?,?)');
    for(const item of paragraphs(html))insert.run(row.scope_id,item.id,item.position,item.html,item.text,row.version);
  }
  function record(row,step,html,execution) {
    database.prepare('INSERT OR REPLACE INTO source_revisions VALUES(?,?,?,?,?,?)').run(row.scope_id,row.version,step,html,execution?json(execution):null,stamp());
  }
  function preparedHtml(row) {
    const html=readHtml(row);
    return body.setBodySource?body.setBodySource(html,row.source_id):html;
  }
  function compose(rows) {
    return readOnce('composed',json(rows.map(row=>[row.scope_id,row.version])),()=>{
      const available=rows.filter(row=>body.bodyText(readHtml(row)).length);
      return available.length?available.map(preparedHtml).reduce(appendContinuous):rows.length?preparedHtml(rows[0]):empty();
    });
  }
  function retainQa(html,previous) {
    if(!previous)return html;
    const currentText=body.bodyText(html),oldText=body.bodyText(previous);
    for(const mark of body.bodyRanges(previous).qa) {
      let start=mark.start,end=mark.end;
      if(currentText!==oldText)continue;
      try{html=body.markBodyRange(html,start,end,mark.id);}catch{}
    }
    return html;
  }
  function updateDocumentCache(userId,id,{touch=false,touchBook=false}={}) {
    const row=requireDocument(userId,id),rows=scopes(userId,id);
    const html=retainQa(compose(rows),row.body_html),blocks=body.htmlToBlocks(html),text=body.bodyText(html);
    database.prepare('UPDATE documents SET body_html=?,blocks_json=?,plain_text=?,body_hash=?,revision=revision+?,updated_at=CASE WHEN ? THEN ? ELSE updated_at END WHERE id=? AND owner_id=?')
      .run(html,json(blocks),text,hash(html),touch?1:0,touch?1:0,stamp(),id,userId);
    if(touchBook&&row.book_id)database.prepare('UPDATE books SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=?').run(stamp(),row.book_id,userId);
  }
  const hasDocument=(userId,id)=>!!database.prepare('SELECT 1 FROM article_sources WHERE user_id=? AND document_id=? LIMIT 1').get(userId,id);
  function createArticleSources(userId,id,inputs) {
    requireDocument(userId,id);
    if(!Array.isArray(inputs)||!inputs.length||inputs.length>10000)throw fail(400,'请提供来源列表，最多 10000 个来源。');
    transaction(()=>{
      let position=scopes(userId,id).length;
      for(const input of inputs) {
        const type=aliases[input.type]||input.type;
        if(!types.has(type))throw fail(400,'来源文件类型无效。');
        const sourceId=input.id||randomUUID();
        if(typeof sourceId!=='string'||!/^[\w.:-]{1,160}$/.test(sourceId))throw fail(400,'来源标识无效。');
        if(database.prepare('SELECT 1 FROM article_sources WHERE document_id=? AND source_id=?').get(id,sourceId))throw fail(409,'该来源已经属于当前文章。');
        const existing=database.prepare('SELECT * FROM sources WHERE id=?').get(sourceId);
        if(existing&&existing.owner_id!==userId)throw fail(404,'找不到这个来源。');
        const physicalHtml=sourceHtml(input),physicalText=body.bodyText(physicalHtml),localRange=input.localRange||input.range||null;
        if(localRange&&(!Number.isSafeInteger(localRange.start)||localRange.start<0||(localRange.end!==undefined&&(!Number.isSafeInteger(localRange.end)||localRange.end<localRange.start))))throw fail(400,'来源正文范围无效。');
        const initial=localRange?sliceReadingHtml(physicalHtml,Math.min(localRange.start,physicalText.length),Math.min(localRange.end??physicalText.length,physicalText.length)):physicalHtml,text=body.bodyText(initial),hasInput=typeof input.text==='string'||typeof input.bodyHtml==='string';
        const original=input.original||{text:input.text??text,...(input.bodyHtml?{bodyHtml:input.bodyHtml}:{})};
        const preview=input.preview||((type==='photo'||type==='screenshot')?{type:'image',url:`/api/images/${original.imageId||sourceId}/raw`}:{type:'text',text:original.text??original.snapshot??text,html:original.bodyHtml||original.html});
        const label=input.firstExtractionLabel||input.firstExtraction?.label||((type==='photo')?'AI 识别与校正结果':'首次提取结果');
        const extraction=input.firstExtraction|| (hasInput?{bodyHtml:physicalHtml,text:physicalText,label}:null);
        if(!existing)database.prepare('INSERT INTO sources VALUES(?,?,?,?,?,?,?)').run(sourceId,userId,type,json(original),json(preview),extraction?json(extraction):null,stamp());
        const scopeId=randomUUID(),ready=input.status==='ready',skip=input.needsCorrection===false||input.skipCorrection===true;
        const nextStep=ready?4:hasInput?(skip?2:1):0;
        database.prepare('INSERT INTO article_sources(scope_id,document_id,user_id,source_id,position,version,status,next_step,manual,manual_boundaries,updated_at,range_json) VALUES(?,?,?,?,?,1,?,?,?,?,?,?)').run(scopeId,id,userId,sourceId,position++,ready?'ready':'pending',nextStep,input.manual?1:0,input.manual?1:0,stamp(),localRange?json(localRange):null);
        const row=scope(userId,id,sourceId);replaceFragments(row,initial);
        if(hasInput){
          const rawHtml=sourceHtml(extraction),rawLength=body.bodyText(rawHtml).length;
          const scopedRaw=localRange?sliceReadingHtml(rawHtml,Math.min(localRange.start,rawLength),Math.min(localRange.end??rawLength,rawLength)):rawHtml;
          const filtered=Array.isArray(input.importExclusions)&&input.importExclusions.length>0;
          record(row,'extract',scopedRaw,extraction.execution||(filtered?undefined:input.execution));
          if(filtered)record(row,'chapter_filter',initial,input.execution);
        }
      }
      updateDocumentCache(userId,id);
    });
    refreshPages(userId,id);return hydrateDocument(userId,id);
  }
  function adoptDocument(userId,id) {
    const row=requireDocument(userId,id);
    if(hasDocument(userId,id))return hydrateDocument(userId,id);
    const document=fromRow(row),html=document.bodyHtml||row.body_html||body.blocksToHtml(document.blocks||decode(row.blocks_json,[]));
    let images=document.sourceImages||decode(row.source_images_json,[]);
    if(!images.length&&row.source_image_id)images=[{id:row.source_image_id,recognition:decode(row.recognition_json)}];
    const descriptors=[],text=body.bodyText(html),ranges=body.bodyRanges(html).sources;
    const legacyPrepared=(part)=>{
      const value=body.bodyText(part);if(!value.trim()||body.hasCompleteSentenceBoundaries(part))return part;
      const split=value.match(/[^。！？!?]*[。！？!?]+[」』）]?|[^。！？!?]+$/gu)||[value];
      return body.initializeSentenceBoundaries(part,split);
    };
    const history=(part)=>({type:'text',bodyHtml:legacyPrepared(part),status:'ready',needsCorrection:false,original:{text:body.bodyText(part),bodyHtml:part,label:'历史正文快照'},firstExtraction:{text:body.bodyText(part),bodyHtml:part,label:'历史正文快照'}});
    const located=images.map(image=>{const owned=ranges.filter(range=>range.id===image.id);return {image,start:owned.length?Math.min(...owned.map(range=>range.start)):null,end:owned.length?Math.max(...owned.map(range=>range.end)):null};}).sort((a,b)=>(a.start??Infinity)-(b.start??Infinity));
    const overlapping=located.some((item,index)=>item.start!==null&&located.slice(0,index).some(previous=>previous.end>item.start));
    let cursor=0;
    for(const item of located) {
      const {image}=item;
      if(!overlapping&&item.start!==null&&item.start>cursor)descriptors.push(history(sliceReadingHtml(html,cursor,item.start)));
      const part=overlapping||item.start===null?empty():sliceReadingHtml(html,item.start,item.end);
      const recognized=Array.isArray(image.recognition?.blocks)?body.blocksToHtml(image.recognition.blocks):part;
      descriptors.push({id:image.id,type:'photo',bodyHtml:legacyPrepared(part),status:'ready',needsCorrection:false,original:{imageId:image.id,...(overlapping?{boundaryNeedsReview:true}:{})},preview:{type:'image',url:`/api/images/${image.id}/raw`},firstExtraction:image.recognition?{text:image.recognition.text||body.bodyText(recognized),bodyHtml:recognized,label:'AI 识别与校正结果',recognition:image.recognition}:{text:body.bodyText(part),bodyHtml:part,label:'历史正文快照'}});
      if(!overlapping&&item.end!==null)cursor=item.end;
    }
    if(!images.length||overlapping)descriptors.push(history(html));
    else if(cursor<text.length)descriptors.push(history(sliceReadingHtml(html,cursor,text.length)));
    return createArticleSources(userId,id,descriptors);
  }
  function failedCorrection(row,text) {
    if(row.status!=='failed'||row.next_step!==1||!row.first_extraction_json||!text.trim()||overlapsWork(row,'correct'))return null;
    const request=latestRequest(row.user_id,row.document_id);
    if(!request||request.deleted_at||request.snapshot_json)return null;
    if(!phaseFailed(row,'correct'))return null;
    const attempt=database.prepare("SELECT id,state,finished_at,diagnostic_json,request_id FROM source_step_attempts WHERE scope_id=? AND input_version=? AND step='correct' ORDER BY rowid DESC LIMIT 1").get(row.scope_id,row.version);
    if(attempt?.state!=='failed'||!attempt.finished_at||attempt.request_id!==request.id)return null;
    return {attemptId:attempt.id,status:decode(attempt.diagnostic_json)?.category==='timeout'?'timeout':'failed'};
  }
  function sourceDetail(row,{internal=false,articleOffsets,articleBodyHash,liveNodes}={}) {
    const html=readHtml(row),before=articleOffsets?.get(row.source_id)??scopes(row.user_id,row.document_id).filter(other=>other.position<row.position).reduce((sum,other)=>sum+body.bodyText(readHtml(other)).length,0);
    const document=internal||articleBodyHash==null?requireDocument(row.user_id,row.document_id):null;
    articleBodyHash??=document.body_hash||hash(compose(scopes(row.user_id,row.document_id)));
    const preview=decode(row.preview_json,{});preview.type??=preview.kind;
    const steps=database.prepare('SELECT step,input_version AS inputVersion,status,error,updated_at AS updatedAt FROM source_steps WHERE scope_id=? ORDER BY updated_at,step').all(row.scope_id);
    const processing=row.status==='processing'||!internal&&row.status==='pending'&&steps.some(({step,inputVersion,status})=>
      status==='running'&&inputVersion===row.version&&(liveNodes??=liveSourceNodes(row.user_id,row.document_id)).has(json([row.scope_id,inputVersion,step])));
    const text=body.bodyText(html);
    return {id:row.source_id,scopeId:row.scope_id,type:row.type,localRange:decode(row.range_json),position:row.position,...(internal?{documentTitle:document.title}:{failedCorrection:failedCorrection(row,text),editRevision:row.edit_revision}),version:row.version,checked:row.checked_version===row.version,checkedVersion:row.checked_version,status:row.status,processing,manual:!!row.manual,editing:!!row.edit_session&&row.edit_expires>now(),preview,original:internal?decode(row.original_json,{}):publicMetadata(decode(row.original_json,{})),firstExtraction:decode(row.first_extraction_json),bodyHtml:html,text,articleStart:before,articleEnd:before+text.length,articleBodyHash,error:row.error||null,proposal:decode(row.proposal_json),proposalToken:reviewToken(row),steps,changes:database.prepare("SELECT version,step,body_html AS bodyHtml,execution_json AS executionJson,created_at AS createdAt FROM source_revisions WHERE scope_id=? ORDER BY version,created_at,CASE step WHEN 'extract' THEN 0 WHEN 'chapter_filter' THEN 1 ELSE 2 END").all(row.scope_id).map(({executionJson,...revision})=>({...revision,...(revision.step==='keep_uncorrected'?{label:'使用未校对的当前正文'}:{}),execution:decode(executionJson)}))};
  }
  function listSources(userId,id) {const document=requireDocument(userId,id),rows=scopes(userId,id),articleOffsets=new Map();let offset=0;for(const row of rows){articleOffsets.set(row.source_id,offset);offset+=body.bodyText(readHtml(row)).length;}const articleBodyHash=document.body_hash||hash(compose(rows)),liveNodes=liveSourceNodes(userId,id);return rows.map(row=>sourceDetail(row,{articleOffsets,articleBodyHash,liveNodes}));}
  const getSource=(userId,id,sourceId)=>sourceDetail(scope(userId,id,sourceId));
  function assertVersion(row,version) {
    if(!Number.isSafeInteger(version)||version<1)throw fail(400,'缺少有效的来源版本。');
    if(row.version!==version)throw fail(409,'这个来源已修改，请保留当前文字并重新打开最新版本。');
  }
  function globalRefs(row,refs,list=fragments(row)) {
    const offsets=new Map();let offset=0;
    list.forEach((fragment,i)=>{offsets.set(fragment.id,offset);offset+=fragment.text.length+(i<list.length-1?1:0);});
    return refs.map(ref=>ref.sourceId!==row.source_id?{...ref}:{...ref,start:(offsets.get(ref.paragraphId)||0)+ref.start,end:(offsets.get(ref.paragraphId)||0)+ref.end,paragraphId:null});
  }
  function localRefs(row,start,end) {
    const result=[];let offset=0;const list=fragments(row);
    for(let i=0;i<list.length;i++) {
      const fragment=list[i],length=fragment.text.length+(i<list.length-1?1:0),from=Math.max(start,offset),to=Math.min(end,offset+length);
      if(to>from)result.push({sourceId:row.source_id,paragraphId:fragment.id,start:from-offset,end:to-offset});
      offset+=length;
    }
    return result;
  }
  function remapPages(row,before,after,replace) {
    const pages=database.prepare('SELECT * FROM reading_pages WHERE document_id=? AND user_id=?').all(row.document_id,row.user_id);
    const change=changedTextRange(before,after);
    const global=pages.map(page=>({page,refs:globalRefs(row,decode(page.ranges_json,[]))}));
    replace();
    for(const {page,refs} of global) {
      const mapped=[];
      // Consecutive ranges for the edited source form one stable published span.
      for(let i=0;i<refs.length;i++) {
        const ref=refs[i];if(ref.sourceId!==row.source_id){mapped.push(ref);continue;}
        let end=ref.end;while(i+1<refs.length&&refs[i+1].sourceId===row.source_id&&refs[i+1].start===end)end=refs[++i].end;
        const start=Math.max(0,Math.min(after.length,remapReadingOffset(ref.start,change,false)));
        const to=Math.max(start,Math.min(after.length,remapReadingOffset(end,change,true)));
        mapped.push(...localRefs(row,start,to));
      }
      database.prepare('UPDATE reading_pages SET ranges_json=? WHERE id=?').run(json(mapped),page.id);
    }
  }
  function annotationRanges(row) {
    const length=sourceLength(row);
    if(row.next_step>=4)return length?[{start:0,end:length}]:[];
    return database.prepare('SELECT start,end FROM source_annotations WHERE scope_id=? AND version=? ORDER BY start,end').all(row.scope_id,row.version);
  }
  function annotationCovered(row,start,end) {
    if(end<=start)return true;
    let offset=start;
    for(const range of annotationRanges(row)){if(range.start>offset)return false;if(range.end>offset)offset=range.end;if(offset>=end)return true;}
    return false;
  }
  function annotationForPage(row,page) {
    const refs=globalRefs(row,decode(page.ranges_json,[])).filter(ref=>ref.sourceId===row.source_id);
    if(!refs.length)return null;
    const start=Math.min(...refs.map(ref=>ref.start)),end=Math.max(...refs.map(ref=>ref.end));
    return annotationCovered(row,start,end)?null:{start,end,pageId:page.id};
  }
  function preservedAnnotations(row,nextRow,before,after,intervals,oldHtml) {
    const change=changedTextRange(before,after);
    if(before!==after&&oldHtml){
      const affected=body.bodyRanges(oldHtml).sentences.filter(sentence=>change.start===change.oldEnd?sentence.start<=change.start&&sentence.end>=change.start:sentence.start<change.oldEnd&&sentence.end>change.start);
      for(const sentence of affected){change.start=Math.min(change.start,sentence.start);change.oldEnd=Math.max(change.oldEnd,sentence.end);}
      change.newEnd=change.oldEnd+change.delta;
    }
    const insert=database.prepare('INSERT OR IGNORE INTO source_annotations VALUES(?,?,?,?,NULL,?)');
    for(const range of intervals){
      if(before===after)insert.run(row.scope_id,nextRow.version,range.start,range.end,stamp());
      else {const leftEnd=Math.min(range.end,change.start);if(leftEnd>range.start)insert.run(row.scope_id,nextRow.version,range.start,leftEnd,stamp());const rightStart=Math.max(range.start,change.oldEnd);if(range.end>rightStart)insert.run(row.scope_id,nextRow.version,rightStart+change.delta,range.end+change.delta,stamp());}
    }
  }
  function saveSource(userId,id,sourceId,input,revisionStep='manual') {
    let row=scope(userId,id,sourceId);assertVersion(row,input?.version);
    const previousRequest=latestRequest(userId,id);
    if(previousRequest&&!previousRequest.deleted_at&&!previousRequest.snapshot_json)taskAdapter.checkpoint(userId,previousRequest.id);
    if(typeof input.bodyHtml!=='string'&&typeof input.text!=='string')throw fail(400,'请提供当前来源的正文。');
    const previous=readHtml(row),priorAnnotations=annotationRanges(row);let next=typeof input.bodyHtml==='string'?body.normalizeBodyHtml(input.bodyHtml):body.editBodyText(previous,input.text);const text=body.bodyText(next);
    if(text.length>200000)throw fail(400,'每个来源最多 200000 字。');
    const textChanged=text!==body.bodyText(previous),newVersion=row.version+1;
    const firmBoundaries=manualBoundaries(row)||textChanged||sentenceLayout(previous)!==sentenceLayout(next);
    if(textChanged&&body.invalidateBodySentences){const change=changedTextRange(body.bodyText(previous),text);next=body.invalidateBodySentences(next,change.start,change.newEnd);}
    const nextStep=!text.trim()?4:!textChanged&&body.hasCompleteSentenceBoundaries(next)?3:2;
    const retired=transaction(()=>{
      const changed=database.prepare("UPDATE article_sources SET version=?,checked_version=?,manual=1,manual_boundaries=?,status=?,next_step=?,error=NULL,proposal_json=NULL,updated_at=? WHERE scope_id=? AND version=?").run(newVersion,input.checked===true?newVersion:!textChanged&&row.checked_version===row.version?newVersion:null,firmBoundaries?1:0,nextStep>=4?'ready':'pending',nextStep,stamp(),row.scope_id,row.version);
      if(changed.changes!==1)throw fail(409,'这个来源已修改，请保留当前文字并重新打开最新版本。');
      const oldRow=row;row={...row,version:newVersion,next_step:nextStep,manual_boundaries:firmBoundaries?1:0};
      remapPages(row,body.bodyText(previous),text,()=>replaceFragments(row,next));
      preservedAnnotations(oldRow,row,body.bodyText(previous),text,priorAnnotations,previous);
      if(nextStep>=3&&annotationCovered(row,0,text.length))database.prepare("UPDATE article_sources SET status='ready',next_step=4 WHERE scope_id=?").run(row.scope_id);
      record(row,revisionStep,next);updateDocumentCache(userId,id,{touch:true,touchBook:true});
      return retireEditedWork(userId,id,row.scope_id);
    });
    abortRetiredWork(retired);
    requestPreparation(userId,id,'correction',0,sourceId);
    schedule();return getSource(userId,id,sourceId);
  }
  function keepCurrentSource(userId,id,sourceId,input) {
    const row=scope(userId,id,sourceId);assertVersion(row,input?.version);
    const html=readHtml(row),afterFailure=typeof input.failedCorrectionAttemptId==='string';
    if(afterFailure){
      if(failedCorrection(row,body.bodyText(html))?.attemptId!==input.failedCorrectionAttemptId)
        throw fail(409,'校对状态已更新，请查看最新状态。');
    }else{
      const token=reviewToken(row);
      if(!token||token!==input.proposalToken)throw fail(409,'AI 提议已更新或已处理，请重新核对。');
    }
    if(row.edit_session&&row.edit_expires>now()&&row.edit_session!==input.sessionId)throw fail(409,'另一个页面正在编辑此来源，请保存或退出编辑后再试。');
    const saved=saveSource(userId,id,sourceId,{version:row.version,bodyHtml:html},afterFailure?'keep_uncorrected':'manual');
    return row.edit_session&&row.edit_session===input.sessionId?endEdit(userId,id,sourceId,{sessionId:input.sessionId}):saved;
  }
  function markChecked(userId,id,sourceId,input) {
    const row=scope(userId,id,sourceId);assertVersion(row,input?.version);
    if(input.checked!==undefined&&typeof input.checked!=='boolean')throw fail(400,'核对状态无效。');
    database.prepare('UPDATE article_sources SET checked_version=? WHERE scope_id=?').run(input.checked===false?null:row.version,row.scope_id);
    return getSource(userId,id,sourceId);
  }
  function expectedEditRevision({editRevision,sessionId}) {
    if(editRevision===undefined)return null;
    if(!Number.isSafeInteger(editRevision)||editRevision<0||typeof sessionId!=='string'||!sessionId)throw fail(400,'编辑会话或序号无效。');
    return editRevision;
  }
  function beginEdit(userId,id,sourceId,input={}) {
    const row=scope(userId,id,sourceId),sessionId=input.sessionId||randomUUID();
    if(input.renew===true){
      const time=now();
      const renewed=database.prepare('UPDATE article_sources SET edit_expires=? WHERE scope_id=? AND edit_session=? AND edit_expires>?').run(time+sessionTtlMs,row.scope_id,sessionId,time);
      if(!renewed.changes)throw fail(409,'这次编辑保护已结束。草稿仍可保存，保存时会检查正文版本。');
      return {sessionId};
    }
    const revision=expectedEditRevision(input);
    const acquired=database.prepare('UPDATE article_sources SET edit_session=?,edit_expires=?,edit_revision=edit_revision+1 WHERE scope_id=? AND (? IS NULL OR edit_revision=?)').run(sessionId,now()+sessionTtlMs,row.scope_id,revision,revision);
    if(!acquired.changes)throw Object.assign(fail(409,'来源的编辑状态已更新，请重新打开编辑。'),{code:'SOURCE_EDIT_REVISION_CONFLICT'});
    return {...getSource(userId,id,sourceId),sessionId};
  }
  function endEdit(userId,id,sourceId,input={}) {
    const row=scope(userId,id,sourceId),revision=expectedEditRevision(input),sessionId=input.sessionId||null;
    const released=database.prepare('UPDATE article_sources SET edit_session=NULL,edit_expires=NULL WHERE scope_id=? AND (? IS NULL OR edit_session=?)').run(row.scope_id,sessionId,sessionId);
    // A cleanup can arrive before its acquisition. Invalidate that observed
    // revision without releasing an editor whose token belongs to another attempt.
    if(!released.changes&&revision!==null)database.prepare('UPDATE article_sources SET edit_revision=edit_revision+1 WHERE scope_id=? AND edit_revision=?').run(row.scope_id,revision);
    schedule();return getSource(userId,id,sourceId);
  }
  function rangesForInterval(rows,start,end) {
    const result=[];let offset=0;
    for(const row of rows) {
      const size=body.bodyText(readHtml(row)).length,from=Math.max(start,offset),to=Math.min(end,offset+size);
      if(to>from)result.push(...localRefs(row,from-offset,to-offset));offset+=size;
    }
    return result;
  }
  function matchesScreenshotOcrHeading(row,fragment) {
    if(row.type!=='screenshot'||!fragment?.text.trim())return false;
    const region=readOnce('firstOcrRegion',row.scope_id,()=>decode(database.prepare(`
      SELECT json_extract(result_json,'$.regions[0]') AS region FROM source_steps
      WHERE scope_id=? AND step='extract' AND status IN ('completed','stale')
        AND json_type(result_json,'$.regions[0]')='object'
      ORDER BY input_version LIMIT 1`).get(row.scope_id)?.region));
    const ignoreSpacing=text=>text.replace(/[^\S\r\n]+/gu,'');
    return typeof region?.text==='string'&&ocrRegionBlockType(region)==='heading'&&ignoreSpacing(region.text)===ignoreSpacing(fragment.text);
  }
  function startsWithImageHeading(row,fragment) {
    return ['photo','screenshot'].includes(row.type)&&!!fragment.text.trim()&&
      (/^<p\b[^>]*\bdata-block-type="heading"/.test(fragment.html)||matchesScreenshotOcrHeading(row,fragment));
  }
  function pageHtml(userId,id,refs,{sourceMap,fragmentMap,pageId}={}) {
    const parts=[],headingSourceIds=[];
    for(let i=0;i<refs.length;i++) {
      const ref=refs[i],row=sourceMap?.get(ref.sourceId)||scope(userId,id,ref.sourceId),list=fragmentMap?.get(ref.sourceId)||fragments(row),at=list.findIndex(f=>f.id===ref.paragraphId),fragment=list[at];
      if(!fragment)continue;
      // Layout-only breaks keep persisted page ranges and question offsets in
      // the same source-local and canonical text coordinates.
      if(parts.length&&ref.sourceId!==refs[i-1].sourceId&&at===0&&ref.start===0&&startsWithImageHeading(row,fragment))headingSourceIds.push(ref.sourceId);
      let html=fragment.html;
      if(ref.end>fragment.text.length)html+=`<p data-paragraph-id="${list[at+1]?.id||fragment.id+':after'}"></p>`;
      const piece=sliceReadingHtml(html,ref.start,ref.end);
      parts.push(body.setBodySource?body.setBodySource(piece,ref.sourceId):piece);
    }
    return {html:parts.length?parts.reduce(appendContinuous):pageId?`<p data-paragraph-id="${pageId}:empty"></p>`:empty(),
      ...(headingSourceIds.length?{headingSourceIds}:{})};
  }
  const publishedLength=(userId,id)=>database.prepare('SELECT ranges_json FROM reading_pages WHERE document_id=? AND user_id=?').all(id,userId).reduce((sum,page)=>sum+decode(page.ranges_json,[]).reduce((n,ref)=>n+ref.end-ref.start,0),0);
  function sentenceCarry(prefix,covered) {
    if(!prefix.length||prefix.some(row=>row.next_step<3))return null;
    const html=compose(prefix),text=body.bodyText(html),last=body.bodyRanges(html).sentences.at(-1);
    if(!last||last.start<covered)return null;
    const parts=[];let offset=0;
    for(const row of prefix){
      const length=body.bodyText(readHtml(row)).length,start=Math.max(0,last.start-offset);
      if(start<length)parts.push({row,start,end:length});
      offset+=length;
    }
    // Existing published or human sentence boundaries are firm. Only a new
    // automatic PDF tail is reconsidered with the next physical source.
    if(!parts.length||parts.some(({row})=>manualBoundaries(row)||!['text_pdf','scan_pdf'].includes(row.type)))return null;
    return {start:last.start,end:text.length,parts};
  }
  function refreshPages(userId,id) {
    const rows=scopes(userId,id);if(!rows.length)return;
    const available=[];
    for(const row of rows){if(row.next_step<3)break;available.push(row);}
    if(!available.length)return;
    const existing=database.prepare('SELECT * FROM reading_pages WHERE document_id=? AND user_id=? ORDER BY position').all(id,userId);
    const covered=existing.reduce((sum,page)=>sum+decode(page.ranges_json,[]).reduce((n,ref)=>n+Math.max(0,ref.end-ref.start),0),0);
    const availableLength=available.reduce((sum,row)=>sum+sourceLength(row),0);
    const complete=available.length===rows.length,shortFirstPageMin=300;
    const shortFirstPage=!existing.length&&!complete&&availableLength>=shortFirstPageMin&&
      rows.every(row=>row.type==='text_pdf'||row.type==='scan_pdf')&&!!requireDocument(userId,id).book_id;
    // A partial tail shorter than the reading-page minimum cannot be published.
    // Check stored text lengths before rebuilding the segmented HTML prefix.
    if(covered>=availableLength||!complete&&availableLength-covered<(shortFirstPage?shortFirstPageMin:800))return;
    const html=compose(available),text=body.bodyText(html);
    const carry=!complete?sentenceCarry(available,covered):null;
    const tail=sliceReadingHtml(html,covered,carry?.start??text.length),tailText=body.bodyText(tail);
    let sentences=body.bodyRanges(tail).sentences;
    // Old material can already have ruby but no sentence IDs. Local punctuation
    // is used only to retain existing readable material, never for new imports.
    if(!body.hasCompleteSentenceBoundaries(tail)) {
      if(rows.some(row=>row.manual||row.next_step<4))return;
      let cursor=0;sentences=(tailText.match(/[^。！？!?]*[。！？!?]+[」』）]?|[^。！？!?]+$/gu)||[tailText]).map(value=>{const result={start:cursor,end:cursor+value.length};cursor=result.end;return result;});
    } else {
      let cursor=0;sentences=sentences.map(sentence=>{const end=sentence.end;const result={start:cursor,end};cursor=end;return result;});
      if(sentences.length&&sentences.at(-1).end<tailText.length)sentences.at(-1).end=tailText.length;
    }
    if(!tailText.length)return;
    const pages=paginateReadingText(tailText,sentences,{complete});
    if(!pages.length&&shortFirstPage&&tailText.length>=shortFirstPageMin){
      // Open a new PDF chapter early only at a complete, already annotated
      // sentence. The unsettled cross-page tail has already been removed.
      let annotatedEnd=0;
      for(const row of available){
        const length=sourceLength(row);let end=0;
        for(const range of annotationRanges(row)){
          if(range.start>end)break;
          end=Math.max(end,range.end);
          if(end>=length)break;
        }
        annotatedEnd+=Math.min(end,length);
        if(end<length||annotatedEnd>=tailText.length)break;
      }
      const end=sentences.findLast(sentence=>sentence.end<=annotatedEnd)?.end??0;
      if(end>=shortFirstPageMin)pages.push({start:0,end});
    }
    let position=existing.length;
    for(const page of pages)database.prepare('INSERT INTO reading_pages VALUES(?,?,?,?,?,?)').run(randomUUID(),id,userId,position++,json(rangesForInterval(available,covered+page.start,covered+page.end)),stamp());
  }
  function preparationProgress(rows,page) {
    const relevant=page?rows.filter(row=>page.sourceIds.includes(row.source_id)):rows;
    const pending=relevant.find(row=>row.next_step<3);
    if(!page||pending)return {stage:pending?stages[pending.next_step]:'segment',percent:null,completed:relevant.filter(row=>row.next_step>=3).length,total:null};
    let total=0,completed=0;
    for(const row of relevant) {
      const ranges=annotationRanges(row);
      for(const ref of globalRefs(row,page.ranges).filter(ref=>ref.sourceId===row.source_id)) {
        total+=ref.end-ref.start;let cursor=ref.start;
        for(const range of ranges){const start=Math.max(cursor,range.start),end=Math.min(ref.end,range.end);if(end>start){completed+=end-start;cursor=end;}if(cursor>=ref.end)break;}
      }
    }
    return {stage:page.ready?'ready':'annotate',percent:page.ready?100:total?Math.min(99,Math.floor(completed/total*100)):0,completed,total};
  }
  function previewText(text,source) {
    if(!text.trim())return null;
    const limit=1000;
    let excerpt=text.slice(0,limit);
    if(text.length>limit&&/[\uD800-\uDBFF]$/u.test(excerpt))excerpt=excerpt.slice(0,-1);
    return {text:excerpt,truncated:excerpt.length<text.length,...(source?{source}:{})};
  }
  function provisionalReadingPreview(rows,pages,page,position) {
    if(page?.ready)return null;
    if(page)return previewText(body.bodyText(page.bodyHtml));
    if(position!==pages.length)return null;
    // The first unpublished page starts after the stored prefix, even when
    // the current diagnostic describes a later PDF source being prepared.
    let covered=pages.reduce((total,item)=>total+item.ranges.reduce((length,ref)=>length+ref.end-ref.start,0),0);
    for(const row of rows){
      if(row.next_step===0)return null;
      const length=sourceLength(row);
      if(covered<length)return previewText(body.bodyText(readHtml(row)).slice(covered),sourceIdentity(row));
      covered-=length;
    }
    return null;
  }
  function readingPages(userId,id,index) {
    return withReadScope(()=>{
      const position=index===undefined?database.prepare('SELECT page_index FROM reading_positions WHERE user_id=? AND document_id=?').get(userId,id)?.page_index||0:Number(index);
      return readOnce('reading',json([userId,id,position]),()=>computeReadingPages(userId,id,index));
    });
  }
  function computeReadingPages(userId,id,index) {
    requireDocument(userId,id);refreshPages(userId,id);
    const rows=scopes(userId,id),sourceMap=new Map(rows.map(row=>[row.source_id,row])),fragmentMap=new Map(rows.map(row=>[row.source_id,fragments(row)]));
    const saved=database.prepare('SELECT page_index FROM reading_positions WHERE user_id=? AND document_id=?').get(userId,id)?.page_index||0;
    const currentIndex=index===undefined?saved:Number(index);
    if(!Number.isSafeInteger(currentIndex)||currentIndex<0)throw fail(400,'阅读页位置无效。');
    let offset=0;
    const pages=database.prepare('SELECT * FROM reading_pages WHERE user_id=? AND document_id=? ORDER BY position').all(userId,id).map(page=>{
      const refs=decode(page.ranges_json,[]),sourceIds=[...new Set(refs.map(ref=>ref.sourceId))],{html,...layout}=pageHtml(userId,id,refs,{sourceMap,fragmentMap,pageId:page.id}),start=offset;offset+=body.bodyText(html).length;
      return {id:page.id,index:page.position,sourceVersions:Object.fromEntries(sourceIds.map(sourceId=>[sourceId,sourceMap.get(sourceId)?.version])),ready:sourceIds.every(sourceId=>{const row=sourceMap.get(sourceId);if(!row)return false;const global=globalRefs(row,refs,fragmentMap.get(sourceId)).filter(ref=>ref.sourceId===sourceId);return global.every(ref=>annotationCovered(row,ref.start,ref.end));})&&(!body.bodyText(html).trim()||body.hasCompleteSentenceBoundaries(html)),bodyHtml:html,...layout,sourceIds,ranges:refs,start,end:offset};
    });
    const complete=!!rows.length&&rows.every(row=>row.next_step>=4)&&pages.every(page=>page.ready)&&offset>=body.bodyText(compose(rows)).length;
    const position=complete&&pages.length?Math.min(currentIndex,pages.length-1):currentIndex,currentPage=pages[position]||null;
    const taskId=currentRequestId(userId,id);
    const diagnostics=readingDiagnostics(userId,id,rows,currentPage,taskId);
    const provisionalPreview=provisionalReadingPreview(rows,pages,currentPage,position);
    return {taskId,pages,currentPage,preparation:preparationProgress(rows,currentPage),diagnostics,...(provisionalPreview?{provisionalPreview}:{}),bodyHash:hash(compose(rows)),index:position,position,complete,...(complete?{totalPages:pages.length}:{}),hasNext:!complete||position+1<pages.length,processing:activeAttemptStates.includes(diagnostics.current?.state)||rows.some(row=>row.status==='processing'),...(diagnostics.current?.error?{error:diagnostics.current.error.message}:{})};
  }
  function readArticle(userId,id) {return hydrateDocument(userId,id);}
  function hydrateDocument(userId,rowOrId) {
    return withReadScope(()=>computeHydratedDocument(userId,rowOrId));
  }
  function computeHydratedDocument(userId,rowOrId) {
    const row=typeof rowOrId==='string'?requireDocument(userId,rowOrId):rowOrId;
    const document=fromRow(row);
    if(!hasDocument(userId,row.id))return document;
    const html=compose(scopes(userId,row.id));
    return {...document,bodyHtml:retainQa(html,row.body_html),bodyHash:hash(html),blocks:body.htmlToBlocks(html),content:serializeBlocks(body.htmlToBlocks(html)),sourceWorkflow:true,sources:listSources(userId,row.id),reading:readingPages(userId,row.id)};
  }
  function demandPageReady(page,rows) {
    return readOnce('demandPageReady',page.id,()=>{
      const refs=decode(page.ranges_json,[]),bySource=new Map(rows.map(row=>[row.source_id,row]));
      for(const sourceId of new Set(refs.map(ref=>ref.sourceId))){
        const row=bySource.get(sourceId);
        if(!row||!globalRefs(row,refs).filter(ref=>ref.sourceId===sourceId).every(ref=>annotationCovered(row,ref.start,ref.end)))return false;
      }
      // Inspect only the target fragments' sentence coverage. No rendered page,
      // full article hash, other pages, or reader diagnostics are needed here.
      let hasText=false,missing=false;
      for(const ref of refs){
        const row=bySource.get(ref.sourceId),fragment=fragments(row).find(item=>item.id===ref.paragraphId);
        if(!fragment)continue;
        const text=fragment.text.slice(ref.start,ref.end);hasText ||= !!text.trim();
        const sentences=readOnce('fragmentSentences',json([row.scope_id,fragment.id]),()=>body.bodyRanges(fragment.html).sentences);
        const covered=sentences.map(sentence=>fragment.text.slice(Math.max(ref.start,sentence.start),Math.min(ref.end,sentence.end))).join('');
        if(covered.replace(/\n/g,'')!==text.replace(/\n/g,''))missing=true;
      }
      return !hasText||!missing;
    });
  }
  function demandReadingState(userId,id,index,rows,pages) {
    let current=pages[index];
    if(!current){
      refreshPages(userId,id);
      pages=database.prepare('SELECT * FROM reading_pages WHERE user_id=? AND document_id=? ORDER BY position').all(userId,id);
      current=pages[index];
    }
    if(current&&demandPageReady(current,rows))return {ready:true,pages};
    if(!rows.length||rows.some(row=>row.next_step<4))return {ready:false,pages};
    const covered=pages.reduce((sum,page)=>sum+decode(page.ranges_json,[]).reduce((n,ref)=>n+ref.end-ref.start,0),0);
    return {ready:covered>=rows.reduce((sum,row)=>sum+sourceLength(row),0)&&pages.every(page=>demandPageReady(page,rows)),pages};
  }
  function requestPreparation(userId,id,mode,index,sourceId) {
    if(mode==='correction'&&!sourceId)return;
    const ready=mode==='correction'?scope(userId,id,sourceId).next_step>=4:readingPages(userId,id,index).currentPage?.ready;
    if(ready)return;
    const target=mode==='correction'?{mode,sourceId}:{mode:'reading',index},request=ensureRequest(userId,id,false,target);
    if(!request)return;
    database.prepare('INSERT INTO source_preparation_jobs(user_id,document_id,mode,target,source_id,page_index,created_at,request_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,mode,target) DO UPDATE SET request_id=excluded.request_id').run(userId,id,mode,mode==='correction'?sourceId:String(index),sourceId||null,index,stamp(),request.id);
  }
  function heartbeat(userId,id,input={}) {
    requireDocument(userId,id);
    const sessionId=input.sessionId||randomUUID(),existing=database.prepare('SELECT * FROM reading_sessions WHERE id=?').get(sessionId);
    if(existing&&(existing.user_id!==userId||existing.document_id!==id))throw fail(404,'找不到这个阅读会话。');
    const {sequence}=input;
    if(sequence!==undefined&&(!Number.isSafeInteger(sequence)||sequence<1))throw fail(400,'阅读会话序号无效。');
    // A delayed navigation or keepalive must not change a newer reading intent.
    if(existing?.last_sequence!=null&&(sequence===undefined||sequence<=existing.last_sequence))return {sessionId,...readingPages(userId,id)};
    if(!hasDocument(userId,id))adoptDocument(userId,id);
    const index=input.index===undefined?database.prepare('SELECT page_index FROM reading_positions WHERE user_id=? AND document_id=?').get(userId,id)?.page_index||0:Number(input.index);
    if(!Number.isSafeInteger(index)||index<0)throw fail(400,'阅读页位置无效。');
    if(input.sourceId)scope(userId,id,input.sourceId);
    if(input.retry===true)ensureRequest(userId,id,true,input.mode==='correction'?{mode:'correction',sourceId:input.sourceId}:{mode:'reading',index});
    if(input.retry===true)retryFailedSteps(userId,id);
    const mode=input.mode==='correction'?'correction':'reading',active=input.active!==false;
    database.prepare('INSERT INTO reading_sessions(id,user_id,document_id,mode,source_id,page_index,active,expires_at,last_sequence) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET mode=excluded.mode,source_id=excluded.source_id,page_index=excluded.page_index,active=excluded.active,expires_at=excluded.expires_at,last_sequence=excluded.last_sequence').run(sessionId,userId,id,mode,input.sourceId||null,index,active?1:0,now()+sessionTtlMs,sequence??null);
    if(active) {
      requestPreparation(userId,id,mode,index,input.sourceId);
      database.prepare('UPDATE article_sources SET edit_expires=? WHERE edit_session=? AND user_id=? AND document_id=?').run(now()+sessionTtlMs,sessionId,userId,id);
    }
    const snapshot=readingPages(userId,id,index);
    // Keepalives repeat the session's page every few seconds; only a new
    // session, a reactivated one or a real page turn records progress, so an
    // idle tab cannot pull back a position another device moved on.
    const turned=!existing||!existing.active||existing.mode!=='reading'||existing.page_index!==index;
    if(active&&mode==='reading'&&turned)readingPositions.save(userId,id,{pageIndex:snapshot.index,pageId:snapshot.currentPage?.id||null});
    schedule();return {sessionId,...snapshot};
  }
  function prepareSource(userId,id,sourceId,input={}) {
    const row=scope(userId,id,sourceId);
    if(row.status==='failed'&&input.retry!==false)retryFailedSteps(userId,id,sourceId);
    if(input.retry!==false)ensureRequest(userId,id,true,{mode:'correction',sourceId});
    const session=heartbeat(userId,id,{...input,mode:'correction',sourceId,active:true});
    return {...getSource(userId,id,sourceId),sessionId:session.sessionId};
  }
  function demand(input) {return withReadScope(()=>computeDemand(input));}
  function computeDemand({userId,documentId}={}) {
    const sessions=database.prepare('SELECT * FROM reading_sessions WHERE active=1 AND expires_at>? ORDER BY CASE mode WHEN \'correction\' THEN 0 ELSE 1 END,expires_at DESC').all(now());
    const jobs=database.prepare('SELECT * FROM source_preparation_jobs ORDER BY created_at').all();
    const candidates=[];
    for(const session of [...sessions,...jobs.map(job=>({...job,background:true}))]) {
      if(userId!==undefined&&(session.user_id!==userId||session.document_id!==documentId))continue;
      if(!requestEnabled(session.user_id,session.document_id))continue;
      const rows=scopes(session.user_id,session.document_id);
      let pages=database.prepare('SELECT * FROM reading_pages WHERE user_id=? AND document_id=? ORDER BY position').all(session.user_id,session.document_id);
      const retire=()=>database.prepare('DELETE FROM source_preparation_jobs WHERE user_id=? AND document_id=? AND mode=? AND target=?').run(session.user_id,session.document_id,session.mode,session.target);
      if(session.mode==='retry'){
        const node=decode(session.target),row=rows.find(row=>row.scope_id===node.scopeId);
        const native=row&&database.prepare('SELECT status FROM source_steps WHERE scope_id=? AND step=? AND input_version=?').get(row.scope_id,node.step,node.inputVersion);
        if(!row||row.version!==node.inputVersion||!native||['completed','stale'].includes(native.status)){retire();continue;}
        const range=/^annotate(?:_local)?:(\d+):(\d+)$/.exec(node.step);
        candidates.push({row,priority:'background',mode:'correction',retryOnly:true,step:phaseOf(node.step),...(range?{annotationRange:{start:Number(range[1]),end:Number(range[2])}}:{})});
        continue;
      }
      if(session.mode==='correction') {
        const row=rows.find(row=>row.source_id===session.source_id);
        if(session.background&&(!row||row.next_step>=4)){retire();continue;}
        if(row)candidates.push({row,priority:session.background?'background':'foreground',mode:'correction',requestTarget:{mode:'correction',sourceId:session.source_id}});continue;
      }
      if(session.background) {
        const snapshot=demandReadingState(session.user_id,session.document_id,session.page_index,rows,pages);pages=snapshot.pages;
        if(snapshot.ready){retire();continue;}
      }
      const window=session.background?1:3,target=pages.slice(session.page_index,session.page_index+window);
      for(let pageIndex=0;pageIndex<target.length;pageIndex++){
        const page=target[pageIndex],ids=new Set(decode(page.ranges_json,[]).map(ref=>ref.sourceId));
        for(const row of rows)if(ids.has(row.source_id)){
          const priority=!session.background&&pageIndex===0?'foreground':'background';
          const requestTarget={mode:'reading',index:page.position};
          if(row.next_step===3){const annotationRange=annotationForPage(row,page);if(annotationRange)candidates.push({row,priority,annotationRange,requestTarget});}
          else if(row.next_step<3)candidates.push({row,priority,requestTarget});
        }
      }
      // A detached request prepares only its requested page. Visible reading
      // sessions additionally prefetch the next two pages.
      if(target.length<window){
        const next=rows.find(row=>row.next_step<3);
        if(next){
          const requestTarget={mode:'reading',index:session.page_index+target.length};
          candidates.push({row:next,priority:!session.background&&!target.length?'foreground':'background',requestTarget});
          // While a sentence batch is running, prepare its one adjacent input.
          // The lookahead never starts another sentence batch or walks the book.
          const segment=[...working.values()].find(work=>work.execution.userId===next.user_id&&work.execution.documentId===next.document_id&&work.reservations.some(ref=>ref.scopeId===next.scope_id&&ref.version===next.version&&ref.step==='segment'));
          if(segment){
            const last=Math.max(...segment.reservations.map(ref=>rows.findIndex(row=>row.scope_id===ref.scopeId)));
            const following=rows[last+1];
            if(following&&following.next_step<2)candidates.push({row:following,priority:'background',requestTarget});
          }
        }
      }
    }
    // Before sentence boundaries exist, annotate the same bounded prefix in
    // parallel. Batch all corrected source pieces of that prefix together.
    for(const candidate of [...candidates]){
      if(candidate.retryOnly)continue;
      const ordered=scopes(candidate.row.user_id,candidate.row.document_id);
      const first=candidate.mode==='correction'?candidate.row:ordered.find(row=>!annotationCovered(row,0,sourceLength(row)));
      if(!first||first.next_step<2||database.prepare('SELECT 1 FROM source_annotations WHERE scope_id=? AND version=? LIMIT 1').get(first.scope_id,first.version))continue;
      const start=ordered.findIndex(row=>row.scope_id===first.scope_id),group=[];let length=0;
      const frontier=ordered.findIndex(row=>row.scope_id===candidate.row.scope_id);
      const offset=index=>ordered.slice(0,index).reduce((sum,row)=>sum+body.bodyText(readHtml(row)).length,0);
      if(candidate.mode!=='correction'&&offset(start)>=offset(frontier)+1200)continue;
      for(const row of candidate.mode==='correction'?[first]:ordered.slice(start)){
        if(row.next_step<2||row.status==='requires_review'||phaseFailed(row,'annotate'))break;
        group.push(row);length+=body.bodyText(readHtml(row)).length;if(length>=1000)break;
      }
      if(!group.length)continue;
      const text=group.map(row=>body.bodyText(readHtml(row))).join('');
      let cursor=0;const units=(text.match(/[^。！？!?]*[。！？!?]+[」』）]?|[^。！？!?]+$/gu)||[text]).map(value=>{const unit={start:cursor,end:cursor+value.length};cursor=unit.end;return unit;});
      const page=paginateReadingText(text,units)[0];if(!page)continue;
      let remaining=page.end;const annotationGroup=[];
      for(const row of group){const end=Math.min(remaining,body.bodyText(readHtml(row)).length);if(end>0&&!annotationCovered(row,0,end))annotationGroup.push({row,range:{start:0,end}});remaining-=end;if(remaining<=0)break;}
      if(!annotationGroup.length)continue;
      candidates.push({...candidate,row:first,step:'annotate',annotationRange:annotationGroup[0]?.range,annotationGroup});
    }
    const sorted=candidates.sort((a,b)=>(a.priority==='foreground'?0:1)-(b.priority==='foreground'?0:1));
    for(const candidate of sorted){
      const {row,mode}=candidate,step=candidate.step||stages[row.next_step];
      if(overlapsWork(row,step,candidate.annotationRange)||row.next_step>=4||row.status==='requires_review'||phaseFailed(row,step))continue;
      if(row.status==='failed'&&!nativeFailedNodes(row).length)continue;
      if(row.edit_session&&row.edit_expires>now()&&(row.next_step<2||step==='annotate'&&hasAnnotationBatch()))continue;
      const ordered=scopes(row.user_id,row.document_id),index=ordered.findIndex(item=>item.scope_id===row.scope_id);
      let reserved=[row],segmentGroup,carry,annotationGroup=candidate.annotationGroup;
      if(step==='segment'&&mode!=='correction'&&!manualBoundaries(row)&&['text_pdf','scan_pdf'].includes(row.type)){
        const following=ordered[index+1];
        if(following&&following.next_step<2&&!manualBoundaries(following)&&!['failed','requires_review'].includes(following.status)&&!(following.edit_session&&following.edit_expires>now())){
          if(overlapsWork(following,stages[following.next_step]))continue;
          return {row:following,priority:candidate.priority,reserved:[following],requestTarget:candidate.requestTarget};
        }
        segmentGroup=[row];let length=body.bodyText(readHtml(row)).length;
        for(const following of ordered.slice(index+1)){
          if(following.next_step!==2||manualBoundaries(following)||following.type!==row.type||length>=6000||overlapsWork(following,'segment')||phaseFailed(following,'segment'))break;
          segmentGroup.push(following);length+=body.bodyText(readHtml(following)).length;if(segmentGroup.length>=3)break;
        }
        carry=sentenceCarry(ordered.slice(0,index),publishedLength(row.user_id,row.document_id));
        reserved=[...(carry?.parts.map(part=>part.row)||[]),...segmentGroup];
        if(carry?.parts.some(({row})=>row.edit_session&&row.edit_expires>now()))continue;
      }
      if(step==='annotate'&&candidate.annotationRange?.pageId){
        const page=database.prepare('SELECT * FROM reading_pages WHERE id=?').get(candidate.annotationRange.pageId);if(!page)continue;
        const ids=new Set(decode(page.ranges_json,[]).map(ref=>ref.sourceId));
        annotationGroup=ordered.filter(item=>ids.has(item.source_id)&&item.next_step>=2&&item.status!=='requires_review'&&!phaseFailed(item,'annotate')&&!(item.edit_session&&item.edit_expires>now())).map(row=>({row,range:annotationForPage(row,page)})).filter(item=>item.range);
      }
      if(annotationGroup)reserved=annotationGroup.map(item=>item.row);
      if(!reserved.length||reserved.some(item=>overlapsWork(item,step,annotationGroup?.find(ref=>ref.row.scope_id===item.scope_id)?.range||candidate.annotationRange)))continue;
      return {...candidate,reserved,segmentGroup,carry,annotationGroup};
    }
    return null;
  }
  function adjacentContext(row,text,start=0,end=text.length,last=row) {
    const ordered=scopes(row.user_id,row.document_id),index=ordered.findIndex(item=>item.scope_id===row.scope_id),lastIndex=ordered.findIndex(item=>item.scope_id===last.scope_id);
    const before=index>0?body.bodyText(readHtml(ordered[index-1])):'',after=lastIndex+1<ordered.length?body.bodyText(readHtml(ordered[lastIndex+1])):'';
    return {before:(before+text.slice(0,start)).slice(-600),after:(text.slice(end)+after).slice(0,600)};
  }
  async function perform({row,priority,annotationRange,mode,step:requestedStep,segmentGroup,carry,annotationGroup},execution) {
    const options=optionsFor(execution);
    if(requestedStep==='annotate')return hasAnnotationBatch()?performAnnotationBatch(row,annotationRange,priority,execution,annotationGroup):performAnnotationRange(row,annotationRange,priority,execution);
    if(row.next_step===3)return hasAnnotationBatch()?performAnnotationBatch(row,annotationRange,priority,execution,annotationGroup):performAnnotationRange(row,annotationRange,priority,execution);
    if(segmentGroup&&(segmentGroup.length>1||carry))return performSegmentBatch(segmentGroup,priority,carry,execution);
    const step=stages[row.next_step],version=row.version,html=readHtml(row),other=scopes(row.user_id,row.document_id),at=other.findIndex(s=>s.scope_id===row.scope_id);
    const context={before:other.slice(Math.max(0,at-1),at).map(readHtml).map(body.bodyText).join('').slice(-600),after:other.slice(at+1,at+2).map(readHtml).map(body.bodyText).join('').slice(0,600)};
    if(step==='correct'){
      if(consecutivePdfPages(other[at-1],row))context.previousPdfPage=true;
      if(row.type==='screenshot'&&matchesScreenshotOcrHeading(row,fragments(row)[0]))context.firstOcrLineIsHeading=true;
    }
    database.prepare("UPDATE article_sources SET status='processing',error=NULL WHERE scope_id=? AND version=?").run(row.scope_id,version);
    database.prepare("INSERT INTO source_steps VALUES(?,?,?,'running',NULL,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at").run(row.scope_id,step,version,stamp());
    const attempt=startAttempt(row,step,execution);
    try {
      if(typeof ai.processSource!=='function')throw fail(503,'来源处理服务尚未就绪，请重试。');
      const prior=step==='extract'?decode(database.prepare('SELECT first_extraction_json FROM sources WHERE id=?').get(row.source_id)?.first_extraction_json):null;
      const result=prior?{...prior,skipCorrection:row.type==='photo'}:await ai.processSource(row.user_id,{source:sourceDetail(row,{internal:true}),step,bodyHtml:html,context,priority,...options,onStatus:attempt.onStatus});
      if(closed||!workValid(execution))return;
      if(!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))return;
      const current=scope(row.user_id,row.document_id,row.source_id);
      if(current.version!==version||(current.edit_session&&current.edit_expires>now()&&row.next_step<2)) {
        attempt.finish('stale',result);
        if(step==='extract'&&(typeof result.bodyHtml==='string'||typeof result.text==='string')){const extracted=sourceHtml(result);database.prepare('UPDATE sources SET first_extraction_json=? WHERE id=? AND first_extraction_json IS NULL').run(json({bodyHtml:extracted,text:body.bodyText(extracted),label:result.firstExtractionLabel||(row.type==='photo'?'AI 识别与校正结果':'首次提取结果'),execution:result.execution||null}),row.source_id);}
        database.prepare("UPDATE source_steps SET status='stale',result_json=?,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(result),stamp(),row.scope_id,step,version);
        if(current.version===version)database.prepare("UPDATE article_sources SET status='pending' WHERE scope_id=? AND version=?").run(row.scope_id,version);return;
      }
      if(result.requiresReview) {
        attempt.finish('requires_review',result);
        database.prepare("UPDATE article_sources SET status='requires_review',proposal_json=?,error=? WHERE scope_id=? AND version=?").run(json({bodyHtml:result.proposalHtml,diff:result.diff}),result.diff?.reason||'正文出现较大改动，请核对差异。',row.scope_id,version);
        database.prepare("UPDATE source_steps SET status='requires_review',result_json=?,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(result),stamp(),row.scope_id,step,version);return;
      }
      let next=typeof result.bodyHtml==='string'?body.normalizeBodyHtml(result.bodyHtml):typeof result.text==='string'?body.editBodyText(html,result.text):html;
      const physicalResult=next,range=decode(row.range_json);
      if(step==='extract'&&range)next=sliceReadingHtml(next,Math.min(range.start,body.bodyText(next).length),Math.min(range.end??body.bodyText(next).length,body.bodyText(next).length));
      if(body.bodyText(next)===body.bodyText(readHtml(current))){
        if(step==='annotate')next=mergeReadings(readHtml(current),next);
        else if(step==='segment')next=body.syncBodyReadings(retainQa(next,readHtml(current)),body.htmlToBlocks(readHtml(current)));
        else next=retainQa(next,readHtml(current));
      }
      const text=body.bodyText(next),before=body.bodyText(html);
      if((step==='segment'||step==='annotate')&&text!==before)throw fail(502,step==='segment'?'分句结果改动了正文，未应用。':'注音结果改动了正文，未应用。');
      if(step==='segment'&&text.trim()&&!body.hasCompleteSentenceBoundaries(next))throw fail(502,'分句尚未覆盖全部正文，请重试。');
      transaction(()=>{
        if(step==='extract')database.prepare('UPDATE sources SET first_extraction_json=? WHERE id=? AND first_extraction_json IS NULL').run(json({bodyHtml:physicalResult,text:body.bodyText(physicalResult),label:result.firstExtractionLabel||(row.type==='photo'?'AI 识别与校正结果':'首次提取结果'),execution:result.execution||null}),row.source_id);
        const changed=text!==before,newVersion=version+(changed?1:0);let nextStep=row.next_step+1+(step==='extract'&&result.skipCorrection?1:0);
        if(row.type==='text_pdf'&&!text.trim()&&(step==='extract'||step==='correct'))nextStep=4;
        if(step==='segment'&&annotationCovered({...current,version:newVersion,next_step:3},0,text.length))nextStep=4;
        database.prepare('UPDATE article_sources SET version=?,checked_version=CASE WHEN ? THEN NULL ELSE checked_version END,status=?,next_step=?,error=NULL,updated_at=? WHERE scope_id=? AND version=?').run(newVersion,changed?1:0,nextStep>=4?'ready':'pending',nextStep,stamp(),row.scope_id,version);
        const updated={...row,version:newVersion};
        if(changed)remapPages(updated,before,text,()=>replaceFragments(updated,next));else replaceFragments(updated,next);
        record(updated,step,next,result.execution);
        database.prepare("UPDATE source_steps SET status='completed',result_json=?,error=NULL,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(result),stamp(),row.scope_id,step,version);
        preserveFailure(updated);
        updateDocumentCache(row.user_id,row.document_id,{touch:changed});
      });
      attempt.finish('completed',result);
      refreshPages(row.user_id,row.document_id);
    }catch(error) {
      if(closed||!workValid(execution))return;
      if(!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))return;
      const current=scope(row.user_id,row.document_id,row.source_id);
      if(current.version!==version){attempt.finish('stale',error);return;}
      attempt.finish('failed',error);
      database.prepare("UPDATE article_sources SET status='failed',error=? WHERE scope_id=? AND version=?").run(failure(error,row,step),row.scope_id,version);
      database.prepare("UPDATE source_steps SET status='failed',error=?,result_json=COALESCE(?,result_json),updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(failure(error,row,step),error.result===undefined?null:json(error.result),stamp(),row.scope_id,step,version);
    }
  }
  async function performAnnotationRange(row,range,priority,execution) {
    const options=optionsFor(execution);
    const original=readHtml(row),text=body.bodyText(original);
    if(!range){
      const boundaries=body.bodyRanges(original).sentences;let cursor=0;
      const units=boundaries.length?boundaries.map(sentence=>{const result={start:cursor,end:sentence.end};cursor=sentence.end;return result;}):text.length?[{start:0,end:text.length}]:[];
      if(units.length&&units.at(-1).end<text.length)units.at(-1).end=text.length;
      range=paginateReadingText(text,units).find(page=>!annotationCovered(row,page.start,page.end));
      if(!range){database.prepare("UPDATE article_sources SET status=CASE WHEN next_step>=3 THEN 'ready' ELSE 'pending' END,next_step=CASE WHEN next_step>=3 THEN 4 ELSE next_step END WHERE scope_id=? AND version=?").run(row.scope_id,row.version);return;}
    }
    const {start,end}=range,step=`annotate:${start}:${end}`,chunk=sliceReadingHtml(original,start,end),chunkText=body.bodyText(chunk);
    database.prepare("UPDATE article_sources SET status='processing',error=NULL WHERE scope_id=? AND version=?").run(row.scope_id,row.version);
    database.prepare("INSERT INTO source_steps VALUES(?,?,?,'running',NULL,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at").run(row.scope_id,step,row.version,stamp());
    const attempt=startAttempt(row,step,execution);
    try{
      const result=await ai.processSource(row.user_id,{source:sourceDetail(row,{internal:true}),step:'annotate',bodyHtml:chunk,context:adjacentContext(row,text,start,end),priority,...options,onStatus:attempt.onStatus});
      if(closed||!workValid(execution)||!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))return;
      const current=scope(row.user_id,row.document_id,row.source_id);
      if(current.version!==row.version){attempt.finish('stale',result);database.prepare("UPDATE source_steps SET status='stale',result_json=?,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(result),stamp(),row.scope_id,step,row.version);return;}
      let annotated=body.normalizeBodyHtml(result.bodyHtml||chunk);
      if(body.bodyText(annotated)!==chunkText)throw fail(502,'注音结果改动了正文，未应用。');
      const latest=readHtml(current);annotated=mergeReadings(sliceReadingHtml(latest,start,end),annotated);
      const pieces=[];if(start>0)pieces.push(sliceReadingHtml(latest,0,start));pieces.push(annotated);if(end<text.length)pieces.push(sliceReadingHtml(latest,end,text.length));
      let next=pieces.reduce(appendContinuous),oldParagraphs=paragraphs(latest);
      next=paragraphs(next).map((item,index)=>item.html.replace(/data-paragraph-id="[^"]+"/,`data-paragraph-id="${oldParagraphs[index]?.id||item.id}"`)).join('');
      if(body.bodyText(next)!==text)throw fail(502,'注音片段映射发生变化，未应用。');
      transaction(()=>{
        replaceFragments(current,next);record(current,step,next,result.execution);
        database.prepare('INSERT OR REPLACE INTO source_annotations VALUES(?,?,?,?,?,?)').run(row.scope_id,row.version,start,end,result.execution?json(result.execution):null,stamp());
        const segmented=current.next_step>=3||body.hasCompleteSentenceBoundaries(readHtml(current));
        const ready=segmented&&annotationCovered({...current,next_step:3},0,text.length);
        database.prepare('UPDATE article_sources SET status=?,next_step=?,error=NULL,updated_at=? WHERE scope_id=? AND version=?').run(ready?'ready':'pending',ready?4:segmented?3:2,stamp(),row.scope_id,row.version);
        database.prepare("UPDATE source_steps SET status='completed',result_json=?,error=NULL,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(result),stamp(),row.scope_id,step,row.version);
        preserveFailure(current);
        updateDocumentCache(row.user_id,row.document_id);
      });
      attempt.finish('completed',result);
    }catch(error){
      if(closed||!workValid(execution))return;
      if(!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=? AND version=?').get(row.scope_id,row.version)){attempt.finish('stale',error);return;}
      attempt.finish('failed',error);
      database.prepare("UPDATE article_sources SET status='failed',error=? WHERE scope_id=? AND version=?").run(failure(error,row,step),row.scope_id,row.version);
      database.prepare("UPDATE source_steps SET status='failed',error=?,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(failure(error,row,step),stamp(),row.scope_id,step,row.version);
    }
  }
  async function performAnnotationBatch(first,range,priority,execution,reservedGroup) {
    const options=optionsFor(execution);
    let group=reservedGroup||[{row:first,range}];
    if(!reservedGroup&&range?.pageId){
      const page=database.prepare('SELECT * FROM reading_pages WHERE id=? AND user_id=? AND document_id=?').get(range.pageId,first.user_id,first.document_id);
      if(!page)return;
      const rows=new Map(scopes(first.user_id,first.document_id).map(row=>[row.source_id,row]));
      group=[...new Set(decode(page.ranges_json,[]).map(ref=>ref.sourceId))].flatMap(id=>{
        const row=rows.get(id);
        if(!row||row.next_step!==3||['failed','requires_review'].includes(row.status)||row.edit_session&&row.edit_expires>now())return [];
        const range=annotationForPage(row,page);return range?[{row,range}]:[];
      });
    }
    const tasks=[];
    for(let {row,range} of group){
      const original=readHtml(row),text=body.bodyText(original);
      if(!range){
        const boundaries=body.bodyRanges(original).sentences;let cursor=0;
        const units=boundaries.length?boundaries.map(sentence=>{const result={start:cursor,end:sentence.end};cursor=sentence.end;return result;}):text.length?[{start:0,end:text.length}]:[];
        if(units.length&&units.at(-1).end<text.length)units.at(-1).end=text.length;
        range=paginateReadingText(text,units).find(page=>!annotationCovered(row,page.start,page.end));
        if(!range){database.prepare("UPDATE article_sources SET status=CASE WHEN next_step>=3 THEN 'ready' ELSE 'pending' END,next_step=CASE WHEN next_step>=3 THEN 4 ELSE next_step END WHERE scope_id=? AND version=?").run(row.scope_id,row.version);continue;}
      }
      const {start,end}=range,step=`annotate:${start}:${end}`,localStep=`annotate_local:${start}:${end}`,chunk=sliceReadingHtml(original,start,end),id=`${row.scope_id}:${row.version}:${start}:${end}`;
      const cached=database.prepare("SELECT result_json FROM source_steps WHERE scope_id=? AND step=? AND input_version=? AND status='completed'").get(row.scope_id,localStep,row.version);
      tasks.push({row,text,start,end,step,localStep,chunk,chunkText:body.bodyText(chunk),id,local:decode(cached?.result_json)});
      database.prepare("UPDATE article_sources SET status='processing',error=NULL WHERE scope_id=? AND version=?").run(row.scope_id,row.version);
      database.prepare("INSERT INTO source_steps VALUES(?,?,?,'running',NULL,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at").run(row.scope_id,step,row.version,stamp());
      trackWorkNode(execution,row,step);
    }
    if(!tasks.length)return;
    const last=tasks.at(-1),context={before:adjacentContext(tasks[0].row,tasks[0].text,tasks[0].start,tasks[0].end).before,after:adjacentContext(last.row,last.text,last.start,last.end).after};
    const persistFailure=(task,error)=>{
      const {row,step}=task;
      if(closed||!workValid(execution)||!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))return;
      const current=scope(row.user_id,row.document_id,row.source_id),frozen=current.version!==row.version||current.edit_session&&current.edit_expires>now();
      (task.attempt||task.localAttempt)?.finish(frozen?'stale':'failed',error);
      database.prepare("UPDATE source_steps SET status=?,error=?,result_json=COALESCE(?,result_json),updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(frozen?'stale':'failed',failure(error,row,step),error.result===undefined?null:json(error.result),stamp(),row.scope_id,step,row.version);
      if(current.version===row.version)database.prepare('UPDATE article_sources SET status=?,error=? WHERE scope_id=? AND version=?').run(frozen?'pending':'failed',frozen?null:failure(error,row,step),row.scope_id,row.version);
    };
    try{
      let result;
      if(typeof ai.prepareAnnotationBodies==='function'&&typeof ai.proofreadAnnotationBodies==='function'){
        const missing=tasks.filter(task=>!task.local);
        if(missing.length){
          for(const task of missing){const {row,localStep}=task;database.prepare("INSERT INTO source_steps VALUES(?,?,?,'running',NULL,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at").run(row.scope_id,localStep,row.version,stamp());task.localAttempt=startAttempt(row,localStep,execution);}
          try{
            const prepared=await ai.prepareAnnotationBodies(missing.map(({id,chunk})=>({id,bodyHtml:chunk})),{...options,onStatus:event=>missing.filter(task=>!event.itemId||task.id===event.itemId).forEach(task=>task.localAttempt.onStatus(event))});
            if(closed||!workValid(execution))return;
            for(const task of missing){
              const local=prepared.items?.find(item=>item.id===task.id);
              if(!local||typeof local.bodyHtml!=='string'||body.bodyText(local.bodyHtml)!==task.chunkText)throw fail(502,'本地注音结果改动了正文，未应用。');
              task.local=local;
              database.prepare("UPDATE source_steps SET status='completed',result_json=?,error=NULL,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(local),stamp(),task.row.scope_id,task.localStep,task.row.version);
              task.localAttempt.finish('completed',local);
            }
          }catch(error){
            if(!closed&&workValid(execution))for(const task of missing){
              const {row,localStep}=task;
              // A batch validation failure blocks each requested source even
              // when an earlier local result has already been cached.
              if(task.local)task.localAttempt=startAttempt(row,localStep,execution);
              database.prepare("UPDATE source_steps SET status='failed',error=?,result_json=COALESCE(?,result_json),updated_at=? WHERE scope_id=? AND step=? AND input_version=? AND status='running'").run(failure(error,row,localStep),error.result===undefined?null:json(error.result),stamp(),row.scope_id,localStep,row.version);
            }
            throw error;
          }
        }
        if(stopping){
          for(const {row,step} of tasks){
            database.prepare("UPDATE source_steps SET status='pending',updated_at=? WHERE scope_id=? AND step=? AND input_version=? AND status='running'").run(stamp(),row.scope_id,step,row.version);
            database.prepare("UPDATE article_sources SET status='pending' WHERE scope_id=? AND version=? AND status='processing'").run(row.scope_id,row.version);
          }
          return;
        }
        for(const task of tasks)task.attempt=startAttempt(task.row,task.step,execution);
        result=await ai.proofreadAnnotationBodies(first.user_id,{prepared:{items:tasks.map(task=>task.local),metrics:{reusedLocalItems:tasks.length-missing.length}},context,priority,...options,onStatus:event=>tasks.forEach(task=>task.attempt.onStatus(event))});
      }else{
        for(const task of tasks)task.attempt=startAttempt(task.row,task.step,execution);
        result=await ai.annotateBodies(first.user_id,{items:tasks.map(({id,chunk})=>({id,bodyHtml:chunk})),context,priority,...options,onStatus:event=>tasks.forEach(task=>task.attempt.onStatus(event))});
      }
      if(closed||!workValid(execution))return;
      for(const task of tasks){
        const {row,text,start,end,step,chunk,chunkText}=task;
        try{
          if(!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))continue;
          const item=result.items?.find(item=>item.id===task.id);
          if(!item||typeof item.bodyHtml!=='string')throw fail(502,'注音批次未返回对应的来源片段，请重试。');
          const value={...item,execution:item.execution||result.execution||null,metrics:item.metrics||result.metrics||null},current=scope(row.user_id,row.document_id,row.source_id);
          if(current.version!==row.version||current.edit_session&&current.edit_expires>now()){
            task.attempt.finish('stale',value);
            database.prepare("UPDATE source_steps SET status='stale',result_json=?,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(value),stamp(),row.scope_id,step,row.version);
            if(current.version===row.version)database.prepare("UPDATE article_sources SET status='pending' WHERE scope_id=? AND version=?").run(row.scope_id,row.version);
            continue;
          }
          let annotated=body.removeQaMarks(body.normalizeBodyHtml(item.bodyHtml||chunk));
          if(body.bodyText(annotated)!==chunkText)throw fail(502,'注音结果改动了正文，未应用。');
          const latest=readHtml(current);annotated=mergeReadings(sliceReadingHtml(latest,start,end),annotated);
          const pieces=[];if(start>0)pieces.push(sliceReadingHtml(latest,0,start));pieces.push(annotated);if(end<text.length)pieces.push(sliceReadingHtml(latest,end,text.length));
          let next=pieces.reduce(appendContinuous);const oldParagraphs=paragraphs(latest);
          next=paragraphs(next).map((item,index)=>item.html.replace(/data-paragraph-id="[^"]+"/,`data-paragraph-id="${oldParagraphs[index]?.id||item.id}"`)).join('');
          if(body.bodyText(next)!==text)throw fail(502,'注音片段映射发生变化，未应用。');
          transaction(()=>{
            replaceFragments(current,next);record(current,step,next,value.execution);
            database.prepare('INSERT OR REPLACE INTO source_annotations VALUES(?,?,?,?,?,?)').run(row.scope_id,row.version,start,end,value.execution?json(value.execution):null,stamp());
            const segmented=current.next_step>=3||body.hasCompleteSentenceBoundaries(readHtml(current));
        const ready=segmented&&annotationCovered({...current,next_step:3},0,text.length);
            database.prepare('UPDATE article_sources SET status=?,next_step=?,error=NULL,updated_at=? WHERE scope_id=? AND version=?').run(ready?'ready':'pending',ready?4:segmented?3:2,stamp(),row.scope_id,row.version);
            database.prepare("UPDATE source_steps SET status='completed',result_json=?,error=NULL,updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(json(value),stamp(),row.scope_id,step,row.version);
            preserveFailure(current);
            updateDocumentCache(row.user_id,row.document_id);
          });
          task.attempt.finish('completed',value);
        }catch(error){persistFailure(task,error);}
      }
    }catch(error){for(const task of tasks)persistFailure(task,error);}
  }
  async function performSegmentBatch(group,priority,carry,execution) {
    const options=optionsFor(execution);
    const first=group[0],step='segment',parts=[...(carry?.parts||[]),...group.map(row=>({row,start:0,end:body.bodyText(readHtml(row)).length}))];
    const html=parts.map(({row,start,end},index)=>{
      let piece=sliceReadingHtml(preparedHtml(row),start,end);
      if(index<(carry?.parts.length||0))piece=body.invalidateBodySentences(piece,0,body.bodyText(piece).length);
      return piece;
    }).reduce(appendContinuous),text=body.bodyText(html);
    const firstPart=parts[0],lastRow=group.at(-1),context={before:adjacentContext(firstPart.row,body.bodyText(readHtml(firstPart.row)),firstPart.start,firstPart.end).before,after:adjacentContext(lastRow,body.bodyText(readHtml(lastRow))).after};
    for(const row of group){database.prepare("UPDATE article_sources SET status='processing',error=NULL WHERE scope_id=? AND version=?").run(row.scope_id,row.version);database.prepare("INSERT INTO source_steps VALUES(?,?,?,'running',NULL,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='running',error=NULL,updated_at=excluded.updated_at").run(row.scope_id,step,row.version,stamp());}
    const attempts=group.map(row=>startAttempt(row,step,execution));
    try {
      const result=await ai.processSource(first.user_id,{source:sourceDetail(first,{internal:true}),sources:parts.map(({row})=>sourceDetail(row,{internal:true})),step,bodyHtml:html,context,priority,...options,onStatus:event=>attempts.forEach(attempt=>attempt.onStatus(event))});
      if(closed||!workValid(execution))return;
      const next=body.normalizeBodyHtml(result.bodyHtml);
      if(body.bodyText(next)!==text||!body.hasCompleteSentenceBoundaries(next))throw fail(502,'跨页分句未逐字保留全部正文，请重试。');
      const stale=parts.some(({row},index)=>{if(!database.prepare('SELECT 1 FROM article_sources WHERE scope_id=?').get(row.scope_id))return true;const current=scope(row.user_id,row.document_id,row.source_id);return current.version!==row.version||index<(carry?.parts.length||0)&&current.edit_session&&current.edit_expires>now();});
      if(stale){attempts.forEach(attempt=>attempt.finish('stale',result));for(const row of group){database.prepare("UPDATE source_steps SET status='stale' WHERE scope_id=? AND step=? AND input_version=?").run(row.scope_id,step,row.version);database.prepare("UPDATE article_sources SET status='pending' WHERE scope_id=? AND version=? AND status='processing'").run(row.scope_id,row.version);}return;}
      transaction(()=>{
        let offset=0;
        for(const {row,start,end} of parts){
          const old=readHtml(row),length=end-start,original=paragraphs(old);let piece=sliceReadingHtml(next,offset,offset+length);offset+=length;
          piece=retainQa(body.removeQaMarks(piece),sliceReadingHtml(old,start,end));
          if(start>0)piece=appendContinuous(sliceReadingHtml(old,0,start),piece);
          piece=paragraphs(piece).map((item,index)=>item.html.replace(/data-paragraph-id="[^"]+"/,`data-paragraph-id="${original[index]?.id||item.id}"`)).join('');
          if(body.bodyText(piece)!==body.bodyText(old))throw fail(502,'跨页分句片段映射发生变化，未应用。');
          piece=body.syncBodyReadings(piece,body.htmlToBlocks(old));
          replaceFragments(row,piece);record(row,step,piece,result.execution);
          if(group.some(item=>item.scope_id===row.scope_id)){
            const ready=annotationCovered({...row,next_step:3},0,body.bodyText(piece).length);
            database.prepare("UPDATE article_sources SET status=?,next_step=?,error=NULL,updated_at=? WHERE scope_id=? AND version=?").run(ready?'ready':'pending',ready?4:3,stamp(),row.scope_id,row.version);
          }
          database.prepare("INSERT INTO source_steps VALUES(?,?,?,'completed',?,NULL,?) ON CONFLICT(scope_id,step,input_version) DO UPDATE SET status='completed',result_json=excluded.result_json,error=NULL,updated_at=excluded.updated_at").run(row.scope_id,step,row.version,json({bodyHtml:piece,execution:result.execution||null}),stamp());
        }
        for(const {row} of parts)preserveFailure(row);
        updateDocumentCache(first.user_id,first.document_id);refreshPages(first.user_id,first.document_id);
      });
      attempts.forEach(attempt=>attempt.finish('completed',result));
    }catch(error){
      if(closed||!workValid(execution))return;
      attempts.forEach((attempt,index)=>attempt.finish(database.prepare('SELECT 1 FROM article_sources WHERE scope_id=? AND version=?').get(group[index].scope_id,group[index].version)?'failed':'stale',error));
      for(const row of group){database.prepare("UPDATE article_sources SET status='failed',error=? WHERE scope_id=? AND version=?").run(failure(error,row,step),row.scope_id,row.version);database.prepare("UPDATE source_steps SET status='failed',error=?,result_json=COALESCE(?,result_json),updated_at=? WHERE scope_id=? AND step=? AND input_version=?").run(failure(error,row,step),error.result===undefined?null:json(error.result),stamp(),row.scope_id,step,row.version);}
    }
  }
  function schedule() {
    if(closed||stopping||scheduled)return;
    scheduled=true;queueMicrotask(()=>{
      scheduled=false;if(closed||stopping)return;
      for(let next=demand();next;next=demand()) {
        const row=next.row,step=next.step||stages[row.next_step],request=ensureRequest(row.user_id,row.document_id,false,next.requestTarget?{...next.requestTarget,prefetch:true}:undefined);
        if(!request)break;
        const reserved=next.reserved||[row];
        const key=randomUUID(),controller=new AbortController();
        const execution={userId:row.user_id,documentId:row.document_id,requestId:request.id,signal:controller.signal,nodes:new Map()};
        const work={controller,execution,reservations:reserved.map(item=>({scopeId:item.scope_id,version:item.version,step,...(step==='annotate'?{range:next.annotationGroup?.find(ref=>ref.row.scope_id===item.scope_id)?.range||next.annotationRange}:{} )}))};
        working.set(key,work);
        work.promise=perform(next,execution).finally(()=>{
          working.delete(key);
          if(!closed){try{taskAdapter.checkpoint(execution.userId,execution.requestId);}catch(error){if(error.status!==404)throw error;}}
          schedule();
        });
      }
    });
  }
  async function drain() {for(let i=0;i<10000;i++){await new Promise(resolve=>setImmediate(resolve));const tasks=[...working.values()].map(work=>work.promise);if(tasks.length)await Promise.all(tasks);if(!working.size&&!scheduled)break;}}
  const timer=setInterval(()=>schedule(),1000);timer.unref?.();
  function reorderSources(userId,id,input) {
    const rows=scopes(userId,id),ids=input?.sourceIds;
    if(!Array.isArray(ids)||ids.length!==rows.length||new Set(ids).size!==ids.length||ids.some(sourceId=>!rows.some(row=>row.source_id===sourceId)))throw fail(400,'来源顺序必须包含当前文章的全部来源。');
    if(rows.some(row=>!['photo','screenshot'].includes(row.type)))throw fail(400,'PDF 与 EPUB 保留原文件顺序，请在书籍结构中调整章节。');
    transaction(()=>{ids.forEach((sourceId,position)=>database.prepare('UPDATE article_sources SET position=? WHERE user_id=? AND document_id=? AND source_id=?').run(position,userId,id,sourceId));database.prepare('DELETE FROM reading_pages WHERE user_id=? AND document_id=?').run(userId,id);updateDocumentCache(userId,id,{touch:true,touchBook:true});});
    refreshPages(userId,id);return {sources:listSources(userId,id)};
  }
  function validateSelection(userId,id,selection={}) {
    if(!hasDocument(userId,id))return {};
    const rows=scopes(userId,id),text=body.bodyText(compose(rows));
    if(selection.readingPageId&&Number.isSafeInteger(selection.pageLocalStart)&&Number.isSafeInteger(selection.pageLocalEnd)){const page=readingPages(userId,id).pages.find(page=>page.id===selection.readingPageId);if(!page)throw fail(404,'找不到这个阅读页。');if(selection.pageLocalStart<0||selection.pageLocalEnd>page.end-page.start)throw fail(400,'引用不属于当前阅读页。');selection={...selection,start:page.start+selection.pageLocalStart,end:page.start+selection.pageLocalEnd};}
    if(selection.sourceIds?.length===1&&Number.isSafeInteger(selection.sourceLocalStart)&&Number.isSafeInteger(selection.sourceLocalEnd)){let offset=0;const target=rows.find(row=>row.source_id===selection.sourceIds[0]);if(!target)throw fail(404,'找不到当前文章的来源。');for(const row of rows){if(row.scope_id===target.scope_id)break;offset+=body.bodyText(readHtml(row)).length;}if(selection.sourceLocalStart<0||selection.sourceLocalEnd>body.bodyText(readHtml(target)).length)throw fail(400,'引用不属于当前来源。');selection={...selection,start:offset+selection.sourceLocalStart,end:offset+selection.sourceLocalEnd};}
    if(!Number.isSafeInteger(selection.start)||!Number.isSafeInteger(selection.end)||selection.start<0||selection.end<=selection.start||selection.end>text.length)throw fail(400,'引用范围无效。');
    const actual=[];let offset=0;
    for(const row of rows){const length=body.bodyText(readHtml(row)).length;if(selection.start<offset+length&&selection.end>offset)actual.push({sourceId:row.source_id,start:Math.max(0,selection.start-offset),end:Math.min(length,selection.end-offset),version:row.version});offset+=length;}
    if(selection.sourceIds&&(!Array.isArray(selection.sourceIds)||selection.sourceIds.some(id=>!rows.some(row=>row.source_id===id))||actual.some(range=>!selection.sourceIds.includes(range.sourceId))))throw fail(400,'引用不属于当前来源范围。');
    if(selection.readingPageId) {
      const snapshot=readingPages(userId,id),page=snapshot.pages.find(page=>page.id===selection.readingPageId);
      if(!page||selection.start<page.start||selection.end>page.end||selection.sourceIds?.some(id=>!page.sourceIds.includes(id)))throw fail(400,'引用不属于当前阅读页。');
    }
    let scopeValidated=actual.length>0;for(const range of actual){const expected=selection.sourceVersions?.[range.sourceId]??(selection.sourceIds?.length===1?selection.sourceVersion:undefined);if(expected===undefined)scopeValidated=false;if(expected!==undefined&&expected!==range.version)throw fail(409,'引用来源已修改，请重新选择正文。');}
    return {start:selection.start,end:selection.end,scopeValidated,...(selection.readingPageId?{readingPageId:selection.readingPageId}:{}),sourceIds:actual.map(range=>range.sourceId),sourceRanges:actual};
  }
  function persistDocumentMarks(userId,id,html) {
    if(!hasDocument(userId,id))return;
    const rows=scopes(userId,id),text=body.bodyText(html);
    if(text!==body.bodyText(compose(rows)))throw fail(409,'正文版本已变化，请重新选择引用。');
    let offset=0;
    for(const row of rows) {
      const old=readHtml(row),length=body.bodyText(old).length;if(!length)continue;
      let piece=sliceReadingHtml(html,offset,offset+length),oldParagraphs=paragraphs(old),nextParagraphs=paragraphs(piece);
      piece=nextParagraphs.map((paragraph,index)=>paragraph.html.replace(/data-paragraph-id="[^"]+"/,`data-paragraph-id="${oldParagraphs[index]?.id||paragraph.id}"`)).join('');
      replaceFragments(row,piece);offset+=length;
    }
  }
  function deleteDocument(userId,id) {
    const retired=[...working.values()].filter(work=>work.execution.userId===userId&&work.execution.documentId===id);
    database.prepare('UPDATE source_preparation_requests SET deleted_at=?,updated_at=? WHERE user_id=? AND document_id=?').run(stamp(),stamp(),userId,id);
    const rows=scopes(userId,id);
    for(const row of rows)for(const table of ['source_fragments','source_revisions','source_steps','source_step_attempts','source_annotations'])database.prepare(`DELETE FROM ${table} WHERE scope_id=?`).run(row.scope_id);
    database.prepare('DELETE FROM article_sources WHERE user_id=? AND document_id=?').run(userId,id);
    for(const table of ['reading_pages','reading_sessions','source_preparation_jobs'])database.prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`).run(userId,id);
    readingPositions.remove(userId,id);
    abortRetiredWork(retired,()=>fail(410,'文章已删除。'));
  }
  // Reading pages published so far per article; summaries show 第 N / M 页.
  function pageCounts(userId){return new Map(database.prepare('SELECT document_id,COUNT(*) AS count FROM reading_pages WHERE user_id=? GROUP BY document_id').all(userId).map(row=>[row.document_id,row.count]));}
  // Articles whose every source finished preparation (step 4), so their page count is final.
  function preparedDocuments(userId){return new Set(database.prepare('SELECT document_id FROM article_sources WHERE user_id=? GROUP BY document_id HAVING MIN(next_step)>=4').all(userId).map(row=>row.document_id));}
  function attachRoutes(app) {
    const base='/api/documents/:id';
    app.get(`${base}/sources`,(req,res)=>{adoptDocument(req.user.id,req.params.id);res.json({sources:listSources(req.user.id,req.params.id)});});
    app.post(`${base}/sources/reorder`,(req,res)=>res.json(reorderSources(req.user.id,req.params.id,req.body)));
    app.get(`${base}/sources/:sourceId`,(req,res)=>res.json(getSource(req.user.id,req.params.id,req.params.sourceId)));
    app.put(`${base}/sources/:sourceId`,(req,res)=>res.json(saveSource(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.post(`${base}/sources/:sourceId/keep-current`,(req,res)=>res.json(keepCurrentSource(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.post(`${base}/sources/:sourceId/checked`,(req,res)=>res.json(markChecked(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.post(`${base}/sources/:sourceId/edit`,(req,res)=>res.json(beginEdit(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.delete(`${base}/sources/:sourceId/edit`,(req,res)=>res.json(endEdit(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.post(`${base}/sources/:sourceId/prepare`,(req,res)=>res.json(prepareSource(req.user.id,req.params.id,req.params.sourceId,req.body)));
    app.get(`${base}/reading-pages`,(req,res)=>{adoptDocument(req.user.id,req.params.id);res.json(readingPages(req.user.id,req.params.id,req.query.index));});
    app.post(`${base}/reading-session`,(req,res)=>res.json(heartbeat(req.user.id,req.params.id,req.body)));
  }
  function stop(){stopping=true;clearInterval(timer);}
  function close(){if(closed)return;stop();closed=true;}
  const taskAdapter=createSourceTaskAdapter({database,scopes,readHtml,body,sourceIdentity,working,latestRequest,ensureRequest,schedule,stamp,retryFailedSteps,requestTargets:request=>requestTargets(request,true),targetsReady,hasRunnableDemand:(userId,documentId)=>!!demand({userId,documentId}),withReadScope});
  schedule();
  return {preparedDocuments,requestPreparation,taskAdapter,retryFailedSteps,attachRoutes,adoptDocument,createArticleSources,hydrateDocument,readArticle,hasDocument,listSources,getSource,saveSource,markChecked,beginEdit,endEdit,prepareSource,readingPages,heartbeat,reorderSources,validateSelection,persistDocumentMarks,deleteDocument,pageCounts,stop,close,drain};
}
