const fail=(status,message)=>Object.assign(new Error(message),{status,expose:true});
const parse=(value,fallback=null)=>value?JSON.parse(value):fallback;
function currentExecution(attempt,observedAt){
  const execution=parse(attempt?.execution_json,{})||{};
  const counter={running:'elapsedMs',queued:'queueMs',retry_wait:'retryWaitMs'}[attempt?.state];
  if(!counter||attempt.finished_at)return execution;
  const updatedAt=Date.parse(attempt.updated_at);
  if(!Number.isFinite(updatedAt)||!Number.isFinite(observedAt))return execution;
  const previous=Number.isFinite(execution[counter])?Math.max(0,execution[counter]):0;
  return {...execution,[counter]:previous+Math.max(0,observedAt-updatedAt)};
}
function stoppedAt(request,steps,rows){
  const nodes=steps.flatMap(step=>[step,...(step.children||[])]),related=new Set(steps.map(step=>step.sourceId));
  const finished=nodes.map(node=>node.finishedAt).filter(value=>Number.isFinite(Date.parse(value)));
  const changes=rows.filter(row=>related.has(row.source_id)&&(row.manual||!finished.length)).map(row=>row.updated_at);
  const times=[request.created_at,...finished,...changes].map(value=>Date.parse(value)).filter(Number.isFinite);
  return new Date(Math.max(...times)).toISOString();
}
export function createSourceTaskAdapter({database,scopes,readHtml,body,sourceIdentity,working,latestRequest,ensureRequest,retryFailedSteps,requestTargets,targetsReady,hasRunnableDemand=()=>false,schedule,stamp,withReadScope=work=>work()}){
  function ownedSteps(request,rows,observedAt){
    const steps=[];
    for(const row of rows){
      const history=database.prepare('SELECT * FROM source_step_attempts WHERE request_id=? AND scope_id=? ORDER BY rowid').all(request.id,row.scope_id);
      for(const phase of ['extract','correct','segment','annotate']){
        const matches=history.filter(attempt=>attempt.step===phase||attempt.step.startsWith(phase+':')||attempt.step.startsWith(phase+'_'));
        if(!matches.length)continue;
        const nodes=[...new Map(matches.map(attempt=>[`${attempt.input_version}:${attempt.step}`,attempt])).values()];
        const superseded=node=>node.input_version<row.version&&['failed','requires_review'].includes(node.state);
        const active=nodes.filter(node=>['queued','running','retry_wait'].includes(node.state));
        const failed=nodes.filter(node=>node.state==='failed'&&!superseded(node)),review=nodes.filter(node=>node.state==='requires_review'&&!superseded(node));
        const attempt=active.find(node=>node.state==='running')||active.at(-1)||failed.at(-1)||review.at(-1)||nodes.at(-1);
        const state=node=>superseded(node)||['stale','interrupted'].includes(node.state)?'completed':node.state==='failed'&&parse(node.diagnostic_json)?.category==='timeout'?'timeout':node.state;
        const status=active.length?state(attempt):failed.length?state(failed.at(-1)):review.length?'requires_review':'completed';
        const identity=sourceIdentity(row),title=`${identity.label} · ${{extract:'提取／OCR',correct:'正文校对',segment:'分句',annotate:'注音'}[phase]}`;
        steps.push({id:`${row.scope_id}:${phase}`,step:phase,type:phase,label:title,title,status,source:identity,sourceId:row.source_id,page:identity.page,version:row.version,inputVersion:attempt.input_version,execution:currentExecution(attempt,observedAt),queuedAt:attempt.queued_at,startedAt:attempt.started_at,finishedAt:active.length?null:nodes.map(node=>node.finished_at).filter(Boolean).sort().at(-1),error:failed.length||review.length?attempt.message||'来源处理失败，请重试或查看诊断信息。':null,diagnostic:parse(attempt.diagnostic_json),children:nodes.map(node=>({id:node.id,step:node.step,inputVersion:node.input_version,status:state(node),...(superseded(node)?{superseded:true}:{}),execution:currentExecution(node,observedAt),queuedAt:node.queued_at,startedAt:node.started_at,finishedAt:node.finished_at,error:!superseded(node)&&['failed','requires_review'].includes(node.state)?node.message||'来源处理未完成，请查看诊断信息。':null}))});
      }
    }
    return steps;
  }
  function get(userId,id){return withReadScope(()=>read(userId,id));}
  function read(userId,id){
    const request=database.prepare('SELECT * FROM source_preparation_requests WHERE id=? AND user_id=? AND deleted_at IS NULL').get(id,userId);
    if(!request)throw fail(404,'找不到这个正文准备任务。');
    const document=database.prepare('SELECT * FROM documents WHERE id=? AND owner_id=?').get(request.document_id,userId);
    if(!document)throw fail(404,'关联文章已删除。');
    if(request.snapshot_json)return parse(request.snapshot_json);
    const observedAt=Date.parse(stamp());
    const rows=scopes(userId,document.id),targets=requestTargets?.(request),steps=targets?ownedSteps(request,rows,observedAt):[];
    if(!targets)for(const row of rows){
      const native=database.prepare('SELECT * FROM source_steps WHERE scope_id=? AND input_version=? ORDER BY updated_at,rowid').all(row.scope_id,row.version);
      const history=database.prepare('SELECT * FROM source_step_attempts WHERE scope_id=? AND input_version<=? ORDER BY rowid').all(row.scope_id,row.version);
      const attempts=history.filter(attempt=>attempt.input_version===row.version);
      for(const phase of ['extract','correct','segment','annotate']){
        const index=['extract','correct','segment','annotate'].indexOf(phase),children=native.filter(s=>s.step===phase||s.step.startsWith(phase+':')||s.step.startsWith(phase+'_'));
        const failed=children.find(s=>['failed','requires_review'].includes(s.status));
        const active=attempts.filter(s=>(s.step===phase||s.step.startsWith(phase+':')||s.step.startsWith(phase+'_'))&&['queued','running','retry_wait'].includes(s.state));
        const matches=s=>s.step===phase||s.step.startsWith(phase+':')||s.step.startsWith(phase+'_');
        const attempt=active.at(-1)||attempts.filter(matches).at(-1)||(row.next_step>index?history.filter(s=>matches(s)&&s.state==='completed').at(-1):null);
        let status=active.at(-1)?.state||failed?.status||(row.next_step>index?'completed':children.some(s=>s.status==='completed')&&phase!=='annotate'?'completed':index<2&&row.next_step<index||index>=2&&row.next_step<2?'dependency_wait':'pending');
        if(failed&&parse(attempt?.diagnostic_json)?.category==='timeout')status='timeout';
        if(!active.length&&row.status==='failed'&&row.next_step===index&&!failed)status='failed';
        steps.push({id:`${row.scope_id}:${phase}`,step:phase,type:phase,label:`${sourceIdentity(row).label} · ${{extract:'提取／OCR',correct:'正文校对',segment:'分句',annotate:'注音'}[phase]}`,status,source:sourceIdentity(row),sourceId:row.source_id,page:sourceIdentity(row).page,title:`${sourceIdentity(row).label} · ${{extract:'提取／OCR',correct:'正文校对',segment:'分句',annotate:'注音'}[phase]}`,version:row.version,inputVersion:attempt?.input_version??row.version,execution:currentExecution(attempt,observedAt),queuedAt:attempt?.queued_at,startedAt:attempt?.started_at,finishedAt:attempt?.finished_at,error:failed?(attempt?.message||'来源处理失败，请重试或查看诊断信息。'):null,diagnostic:parse(attempt?.diagnostic_json),children:children.map(s=>({id:s.step,step:s.step,status:s.status,error:['failed','requires_review'].includes(s.status)?attempts.filter(a=>a.step===s.step).at(-1)?.message||'来源处理未完成，请查看诊断信息。':null}))});
      }
    }
    const latest=latestRequest?.(userId,document.id),current=!latest||latest.id===id;
    const active=[...working.values()].some(work=>work.execution.userId===userId&&work.execution.documentId===document.id&&(!targets||work.execution.requestId===id))||current&&hasRunnableDemand(userId,document.id);
    const failed=steps.some(s=>['failed','timeout'].includes(s.status)),review=steps.some(s=>s.status==='requires_review')||!targets&&rows.some(r=>r.status==='requires_review');
    const complete=targets?targetsReady(userId,document.id,targets):rows.length&&rows.every(r=>r.next_step>=4);
    const timedOut=steps.some(s=>s.status==='timeout');
    const status=active?(steps.some(s=>s.status==='running')?'running':'queued'):failed?(timedOut?'timeout':'failed'):review?'requires_review':complete?'completed':'dependency_wait';
    const finishedAt=['failed','timeout','requires_review','completed'].includes(status)?stoppedAt(request,steps,rows):null;
    const signature=JSON.stringify({status,targets,steps:steps.map(s=>[s.id,s.status,s.version,s.finishedAt,s.error,s.children?.map(child=>[child.step,child.inputVersion,child.status])])});
    const changed=signature!==request.signature;
    if(changed||request.finished_at!==finishedAt){
      const updatedAt=finishedAt|| (changed?stamp():request.updated_at);
      database.prepare('UPDATE source_preparation_requests SET signature=?,version=version+?,updated_at=?,finished_at=? WHERE id=?').run(signature,changed?1:0,updatedAt,finishedAt,id);
      if(changed)request.version++;request.updated_at=updatedAt;
    }
    const nodes=steps.flatMap(step=>step.children?.length?step.children:[step]);
    const task={id,type:'preparation',title:document.title+' · 正文准备',status,version:request.version,generation:request.generation,documentId:document.id,...(document.book_id?{bookId:document.book_id}:{}),...(targets?{targets}:{}),...(finishedAt?{finishedAt}:{}),steps,createdAt:request.created_at,updatedAt:request.updated_at,archived:status==='completed',canRetry:!active&&failed,canDelete:!active&&failed,canOpenResult:true,progress:{completed:nodes.filter(s=>s.status==='completed').length,total:nodes.length},error:failed?steps.find(s=>s.error)?.error:null};
    if(status==='completed'&&!active){
      task.canRetry=false;task.canDelete=false;
      database.prepare('UPDATE source_preparation_requests SET snapshot_json=?,finished_at=? WHERE id=? AND user_id=? AND snapshot_json IS NULL AND deleted_at IS NULL').run(JSON.stringify(task),task.finishedAt,id,userId);
    }
    return task;
  }
  function check(userId,id,input){const task=get(userId,id);if(input.version!==task.version)throw fail(409,'任务已更新，请刷新后重试。');return task;}
  return {type:'preparation',checkpoint:get,
    list(userId){return withReadScope(()=>{
      for(const row of database.prepare("SELECT DISTINCT a.document_id FROM article_sources a WHERE a.user_id=? AND (EXISTS(SELECT 1 FROM source_preparation_jobs j WHERE j.user_id=a.user_id AND j.document_id=a.document_id) OR EXISTS(SELECT 1 FROM source_step_attempts t WHERE t.scope_id=a.scope_id))").all(userId))if(!latestRequest(userId,row.document_id))ensureRequest(userId,row.document_id);
      return database.prepare('SELECT r.id FROM source_preparation_requests r JOIN documents d ON d.id=r.document_id AND d.owner_id=r.user_id WHERE r.user_id=? AND r.deleted_at IS NULL ORDER BY r.created_at DESC').all(userId).map(r=>get(userId,r.id));});},get,
    retry(userId,id,input){const task=check(userId,id,input);if(!task.canRetry)throw fail(409,'任务仍在执行或没有失败步骤。');
      if(task.targets){
        const failed=database.prepare("SELECT t.scope_id,t.step,t.input_version FROM source_step_attempts t WHERE t.request_id=? AND t.state='failed' AND NOT EXISTS(SELECT 1 FROM source_step_attempts newer WHERE newer.request_id=t.request_id AND newer.scope_id=t.scope_id AND newer.step=t.step AND newer.input_version=t.input_version AND newer.rowid>t.rowid)").all(id);
        for(const node of failed){
          database.prepare("UPDATE source_steps SET status='pending',error=NULL WHERE scope_id=? AND step=? AND input_version=? AND status='failed'").run(node.scope_id,node.step,node.input_version);
          if(node.step.startsWith('annotate_local:'))database.prepare("UPDATE source_steps SET status='pending',error=NULL WHERE scope_id=? AND step=? AND input_version=? AND status='failed'").run(node.scope_id,node.step.replace('annotate_local:','annotate:'),node.input_version);
          database.prepare("UPDATE article_sources SET status='pending',error=NULL WHERE scope_id=? AND version=? AND status='failed'").run(node.scope_id,node.input_version);
          const row=scopes(userId,task.documentId).find(row=>row.scope_id===node.scope_id);
          if(row?.version===node.input_version)database.prepare('INSERT INTO source_preparation_jobs(user_id,document_id,mode,target,source_id,page_index,created_at,request_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,mode,target) DO UPDATE SET request_id=excluded.request_id').run(userId,task.documentId,'retry',JSON.stringify({scopeId:node.scope_id,step:node.step,inputVersion:node.input_version}),row.source_id,0,stamp(),id);
        }
        for(const target of task.targets)database.prepare('INSERT INTO source_preparation_jobs(user_id,document_id,mode,target,source_id,page_index,created_at,request_id) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(user_id,document_id,mode,target) DO UPDATE SET request_id=excluded.request_id').run(userId,task.documentId,target.mode,target.mode==='correction'?target.sourceId:String(target.index),target.sourceId||null,target.index||0,stamp(),id);
      }else{
        for(const row of scopes(userId,task.documentId).filter(row=>row.status==='failed'))database.prepare('INSERT OR IGNORE INTO source_preparation_jobs(user_id,document_id,mode,target,source_id,page_index,created_at) VALUES(?,?,?,?,?,?,?)').run(userId,task.documentId,'correction',row.source_id,row.source_id,0,stamp());
        retryFailedSteps(userId,task.documentId);
      }
      schedule();return get(userId,id);},
    delete(userId,id,input){const task=check(userId,id,input);if(!task.canDelete)throw fail(409,'只有已停止的失败或超时任务可以删除。');database.prepare('UPDATE source_preparation_requests SET deleted_at=?,updated_at=?,version=version+1 WHERE id=?').run(stamp(),stamp(),id);database.prepare('DELETE FROM source_preparation_jobs WHERE user_id=? AND document_id=?').run(userId,task.documentId);database.prepare('UPDATE reading_sessions SET active=0 WHERE user_id=? AND document_id=?').run(userId,task.documentId);return {deleted:true,id};}
  };
}
