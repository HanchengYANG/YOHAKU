// Acceptance harness only. Observe bounded response copies without changing
// application handlers, response bytes, or the data they persist.
const pageIndex=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const boolean=value=>typeof value==='boolean'?value:null;
const stages=new Set(['extract','correct','segment','annotate','ready']);

export function attachReadingObserver(server,{control,record,maxBytes=1024*1024}={}) {
  const limit=Number.isSafeInteger(maxBytes)&&maxBytes>0?Math.min(maxBytes,1024*1024):1024*1024;
  const observe=(req,res)=>{
    let documentId;
    try{
      const match=/^\/api\/documents\/([^/?#]+)\/(reading-pages|reading-session)(?:\?|$)/.exec(req.url||'');
      if(!match||!(req.method==='GET'&&match[2]==='reading-pages'||req.method==='POST'&&match[2]==='reading-session'))return;
      documentId=decodeURIComponent(match[1]);
      const ids=control?.()?.readingDocumentIds;
      if(!Array.isArray(ids)||!ids.includes(documentId))return;
    }catch{return;}
    let chunks=[],size=0,discarded=false,ended=false;
    const capture=(chunk,encoding)=>{
      if(discarded||chunk==null||typeof chunk==='function')return;
      const bytes=typeof chunk==='string'?Buffer.byteLength(chunk,typeof encoding==='string'?encoding:undefined):chunk.byteLength;
      if(!Number.isSafeInteger(bytes)||size+bytes>limit){discarded=true;chunks=[];return;}
      const value=typeof chunk==='string'?Buffer.from(chunk,typeof encoding==='string'?encoding:undefined):Buffer.from(chunk);
      size+=value.length;chunks.push(value);
    };
    const write=res.write,end=res.end;
    res.write=function(...args){try{capture(args[0],args[1]);}catch{discarded=true;chunks=[];}return write.apply(this,args);};
    res.end=function(...args){
      try{capture(args[0],args[1]);}catch{discarded=true;chunks=[];}
      const result=end.apply(this,args);
      if(ended)return result;ended=true;
      try{
        if(discarded||res.getHeader('content-encoding'))return result;
        const payload=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));
        if(!payload||typeof payload!=='object'||Array.isArray(payload))return result;
        record?.({at:new Date().toISOString(),event:'reading_response',documentId,method:req.method,status:res.statusCode,
          index:pageIndex(payload.index),currentPage:{index:pageIndex(payload.currentPage?.index),ready:boolean(payload.currentPage?.ready)},
          pagesCount:Array.isArray(payload.pages)?payload.pages.length:null,complete:boolean(payload.complete),
          progress:{stage:stages.has(payload.preparation?.stage)?payload.preparation.stage:null},
          bodyHash:typeof payload.bodyHash==='string'&&/^[a-f0-9]{64}$/.test(payload.bodyHash)?payload.bodyHash:null});
      }catch{/* Optional local diagnostics must never interfere with HTTP. */}
      finally{chunks=[];}
      return result;
    };
  };
  server.prependListener('request',observe);
  return ()=>server.removeListener('request',observe);
}
