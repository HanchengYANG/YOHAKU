const stopped=label=>Object.assign(new Error(`${label}服务已关闭。`),{status:503,expose:true});

/** Execution starts after a slot is reserved; each process handles one request. */
export function createLocalWorkerPool({create,method,workers=1,label='本地处理'}){
  const size=Math.min(16,Math.max(1,Math.trunc(Number(workers))||1)),slots=Array.from({length:size},()=>({worker:null,request:null})),queue=[];
  let closed=false;
  function notify(request,state){
    if(state==='running'){request.startedAt=new Date().toISOString();request.started=performance.now();}
    const timing={queuedAt:request.queuedAt,...(request.startedAt?{startedAt:request.startedAt}:{}),
      queueMs:Math.round((request.started??performance.now())-request.queued),elapsedMs:0};
    try{Promise.resolve(request.onStatus?.({state,resource:label,...timing})).catch(()=>{});}catch{}
  }
  function settle(request,error,value){
    if(request.done)return;request.done=true;
    request.signal?.removeEventListener('abort',request.abort);
    if(error)request.reject(error);else request.resolve(value);
  }
  function pump(){
    if(closed)return;
    for(const slot of slots){
      if(slot.request||!queue.length)continue;
      const request=queue.shift();if(request.done)continue;
      slot.request=request;request.slot=slot;
      notify(request,'running');
      if(request.done||slot.request!==request)continue;
      let result;
      try{slot.worker??=create();result=slot.worker[method](...request.args);}
      catch(error){result=Promise.reject(error);}
      Promise.resolve(result).then(value=>settle(request,null,value),error=>settle(request,error)).finally(()=>{
        if(slot.request===request){slot.request=null;request.slot=null;}
        // A cancelled request discarded its worker. A late result cannot release
        // the replacement request's reservation.
        pump();
      });
    }
  }
  return {
    [method](...args){
      if(closed)return Promise.reject(stopped(label));
      const options=args.at(-1),signal=options&&typeof options==='object'?options.signal:null;
      if(signal?.aborted)return Promise.reject(signal.reason||new DOMException('Aborted','AbortError'));
      return new Promise((resolve,reject)=>{
        const request={args,signal,onStatus:options?.onStatus,resolve,reject,done:false,slot:null,queued:performance.now(),queuedAt:new Date().toISOString()};
        request.abort=()=>{
          const slot=request.slot;
          if(slot&&slot.request===request){slot.worker?.close();slot.worker=null;slot.request=null;request.slot=null;}
          else {const index=queue.indexOf(request);if(index>=0)queue.splice(index,1);}
          settle(request,signal.reason||new DOMException('Aborted','AbortError'));pump();
        };
        signal?.addEventListener('abort',request.abort,{once:true});queue.push(request);notify(request,'queued');pump();
      });
    },
    status:()=>({workers:size,running:slots.some(slot=>slot.worker),busy:slots.some(slot=>slot.request),active:slots.filter(slot=>slot.request).length,waiting:queue.length}),
    close(){
      if(closed)return;closed=true;const error=stopped(label);
      for(const request of queue.splice(0))settle(request,error);
      for(const slot of slots){if(slot.request)settle(slot.request,error);slot.request=null;slot.worker?.close();slot.worker=null;}
    },
  };
}
