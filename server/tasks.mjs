import { taskAttention } from '../shared/task-attention.mjs';
const fail=(status,message,code)=>Object.assign(new Error(message),{status,expose:true,code});
const activeStates=new Set(['queued','running','retrying','retry_wait','resource_wait','waiting_resource']);
const errorStates=new Set(['failed','timeout','timed_out','blocked','needs_attention','error']);
const statusAliases={needs_attention:'failed',blocked:'failed',ready:'completed',succeeded:'completed',done:'completed',draft:'draft'};
const stamp=()=>new Date().toISOString();

/** A durable directory; adapters remain authoritative for results/checkpoints. */
export function attachTaskRoutes({app,database,adapters=[]}) {
  database.exec(`CREATE TABLE IF NOT EXISTS task_catalog (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,type TEXT NOT NULL,native_ref TEXT NOT NULL,
    target_json TEXT NOT NULL DEFAULT '{}',generation INTEGER NOT NULL DEFAULT 1,
    archived INTEGER NOT NULL DEFAULT 0,deleted_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_id,type,native_ref));
    CREATE INDEX IF NOT EXISTS task_catalog_owner ON task_catalog(owner_id,deleted_at,archived,updated_at);`);
  const byType=new Map(adapters.filter(Boolean).map(adapter=>[adapter.type,adapter]));
  const catalog=database.prepare('SELECT * FROM task_catalog WHERE id=? AND owner_id=? AND deleted_at IS NULL');
  const writeCatalog=database.prepare(`INSERT INTO task_catalog(id,owner_id,type,native_ref,target_json,generation,archived,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET target_json=excluded.target_json,
    generation=excluded.generation,archived=excluded.archived,updated_at=excluded.updated_at
    WHERE task_catalog.deleted_at IS NULL AND task_catalog.owner_id=excluded.owner_id
    AND (task_catalog.target_json IS NOT excluded.target_json OR task_catalog.generation IS NOT excluded.generation
      OR task_catalog.archived IS NOT excluded.archived OR task_catalog.updated_at IS NOT excluded.updated_at)`);
  const snapshotKey=(type,id)=>JSON.stringify([type,id]);
  function transaction(work){
    database.exec('BEGIN IMMEDIATE');
    try{const result=work();database.exec('COMMIT');return result;}
    catch(error){database.exec('ROLLBACK');throw error;}
  }
  function register(owner,type,task){
    const archived=task.archived===true;
    const previous=!task.createdAt||!task.updatedAt?catalog.get(task.id,owner):null;
    const createdAt=task.createdAt||previous?.created_at||stamp(),updatedAt=task.updatedAt||previous?.updated_at||createdAt;
    writeCatalog.run(task.id,owner,type,task.id,JSON.stringify({documentId:task.documentId||null,bookId:task.bookId||null,...(task.targets?{targets:task.targets}:{})}),task.generation||1,Number(archived),createdAt,updatedAt);
  }
  function sync(owner){
    const snapshots=new Map();
    for(const adapter of byType.values())for(const task of adapter.list(owner)){
      register(owner,adapter.type,task);snapshots.set(snapshotKey(adapter.type,task.id),task);
    }
    return snapshots;
  }
  function normalize(row,task){
    const state=task.state||task.status,status=task.status||statusAliases[state]||state;
    const steps=Array.isArray(task.steps)?task.steps:[];
    const runningChildren=nodes=>nodes.some(step=>activeStates.has(step.status||step.state)||runningChildren(step.children||step.steps||[]));
    const active=activeStates.has(status)||activeStates.has(state)||runningChildren(steps);
    const archived=task.archived??!!task.appliedDocumentId;
    return {...task,id:row.id,type:row.type,state,status,steps,archived,
      documentId:task.documentId||task.appliedDocumentId||null,bookId:task.bookId||null,
      canRetry:!!task.canRetry&&!active&&!archived,
      canDelete:!!task.canDelete&&!active&&!archived&&(errorStates.has(status)||errorStates.has(state)),
      canOpenResult:task.canOpenResult??!!(task.documentId||task.appliedDocumentId||task.canReview),
      progress:task.progress||{completed:steps.filter(step=>['completed','succeeded','done'].includes(step.status||step.state)).length,total:steps.length}};
  }
  function read(owner,id,{backfill=true}={}){
    let row=catalog.get(id,owner);
    if(!row&&backfill){sync(owner);row=catalog.get(id,owner);}
    if(!row)throw fail(404,'找不到你账号下的任务。','TASK_UNAVAILABLE');
    const adapter=byType.get(row.type);if(!adapter)throw fail(404,'这个任务暂不可用。','TASK_UNAVAILABLE');
    return {row,adapter,task:normalize(row,adapter.get(owner,row.native_ref))};
  }
  function version(task,input){if(!Number.isSafeInteger(input)||input!==task.version)throw fail(409,'任务已更新，请刷新后重试。','TASK_VERSION_CONFLICT');}
  app.get('/api/tasks',(req,res)=>{
    const scope=req.query.scope||'active',type=req.query.type||null;
    if(!['active','archived'].includes(scope)||type&&!byType.has(type))throw fail(400,'任务筛选条件无效。');
    const limit=Number(req.query.limit||20),offset=Number(req.query.offset||0);
    if(!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(offset)||offset<0)throw fail(400,'任务分页参数无效。');
    const snapshots=sync(req.user.id);
    const rows=database.prepare('SELECT * FROM task_catalog WHERE owner_id=? AND deleted_at IS NULL ORDER BY updated_at DESC,id').all(req.user.id);
    const tasks=rows.map(row=>{try{return normalize(row,snapshots.get(snapshotKey(row.type,row.native_ref))||byType.get(row.type).get(req.user.id,row.native_ref));}catch(error){if(error.status===404)return null;throw error;}}).filter(Boolean);
    const counts={active:tasks.filter(task=>!task.archived).length,archived:tasks.filter(task=>task.archived).length,
      attention:tasks.filter(task=>taskAttention(task)==='attention').length};
    const filtered=tasks.filter(task=>task.archived===(scope==='archived')&&(!type||task.type===type));
    const rank={running:0,queued:1,resource_wait:1,dependency_wait:2,failed:3,timeout:3,needs_attention:3,draft:4,completed:5};
    filtered.sort((a,b)=>(rank[a.status]??3)-(rank[b.status]??3)||String(b.updatedAt).localeCompare(String(a.updatedAt))||a.id.localeCompare(b.id));
    res.json({tasks:filtered.slice(offset,offset+limit),total:filtered.length,scope,limit,offset,counts,activeCount:counts.active,hasMore:offset+limit<filtered.length});
  });
  app.get('/api/tasks/:id',(req,res)=>res.json(read(req.user.id,req.params.id).task));
  app.post('/api/tasks/:id/retry',(req,res)=>{
    sync(req.user.id);
    const task=transaction(()=>{
      const {row,adapter,task}=read(req.user.id,req.params.id,{backfill:false});version(task,req.body?.version);
      if(!task.canRetry)throw fail(409,'任务仍在执行或没有可重试的失败步骤。');
      const result=adapter.retry(req.user.id,row.native_ref,{version:task.version});
      register(req.user.id,row.type,result);return normalize(row,result);
    });res.json(task);
  });
  app.delete('/api/tasks/:id',(req,res)=>{
    sync(req.user.id);
    transaction(()=>{
      const {row,adapter,task}=read(req.user.id,req.params.id,{backfill:false});version(task,req.body?.version);
      if(!task.canDelete)throw fail(409,'只有已经停止执行的失败或超时任务可以删除。');
      adapter.delete(req.user.id,row.native_ref,{version:task.version});
      database.prepare('UPDATE task_catalog SET deleted_at=?,updated_at=? WHERE id=? AND owner_id=?').run(stamp(),stamp(),row.id,req.user.id);
    });res.status(204).end();
  });
  return {register,sync};
}
