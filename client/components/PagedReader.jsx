import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { htmlToBlocks, bodyText } from "../../shared/article-html.mjs";
import { pageSelection, readingPagePosition, readingPreparation } from "../source-presentation.mjs";
import Reader from "./Reader.jsx";
import ReadingBar from "./ReadingBar.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import "../sources.css";

export default function PagedReader({ document, session, active = true, resumePosition = null, onEditSources, onPageChange, bar = null, nextArticle = null, ...readerProps }) {
  const [resume] = useState(resumePosition);
  const [pageIndex, setPageIndex] = useState({ documentId:document.id, value:resume?.index ?? null });
  const [response, setResponse] = useState(null);
  const [failure, setFailure] = useState(null);
  const index = pageIndex?.documentId === document.id ? pageIndex.value : null;
  // The preloaded snapshot can still describe the page or text before correction.
  const snapshot = response?.documentId === document.id ? response.snapshot : resume ? null : document.reading || null;
  const requestedIndex = index ?? snapshot?.index ?? snapshot?.position ?? snapshot?.currentPage?.index ?? 0;
  const currentIndex = snapshot?.complete && snapshot.totalPages > 0 ? Math.min(requestedIndex, snapshot.totalPages - 1) : requestedIndex;
  const canHeartbeat = !!snapshot || !!resume;
  const error = failure?.documentId === document.id && failure.index === currentIndex ? failure.message : "";
  const [retry, setRetry] = useState(0);
  const retryPending = useRef(false);
  const requestSequence = useRef(0);
  const latestResponse = useRef(0);
  const current = useRef(null);
  current.current = {index:currentIndex,heartbeatIndex:!snapshot && index === null ? undefined : currentIndex};
  const setSnapshot = (next) => setResponse({documentId:document.id,snapshot:next});
  const setError = (message, requestedIndex = current.current.index) => setFailure(message ? {documentId:document.id,index:requestedIndex,message} : null);
  useEffect(() => {
    let stopped = false, timer, controller, sequence = 0;
    const load = async () => {
      clearTimeout(timer);
      if (stopped || window.document.visibilityState === "hidden") return;
      const currentRequest = ++sequence;
      const request = ++requestSequence.current;
      const requestedIndex = current.current.index;
      controller?.abort();
      controller = new AbortController();
      try {
        const next = await api(`/documents/${encodeURIComponent(document.id)}/reading-pages${index === null ? "" : `?index=${index}`}`, {signal:controller.signal});
        if (stopped || currentRequest !== sequence || window.document.visibilityState === "hidden" || request < latestResponse.current) return;
        latestResponse.current = request;
        setSnapshot(next); setError(""); onPageChange?.(next.currentPage,next);
      } catch (cause) { if (!stopped && currentRequest === sequence && window.document.visibilityState !== "hidden" && request >= latestResponse.current && cause.name !== "AbortError") setError(cause.message,requestedIndex); }
      finally { if (!stopped && currentRequest === sequence && active && window.document.visibilityState !== "hidden") timer = setTimeout(load,2000); }
    };
    const visibility = () => {
      if (window.document.visibilityState === "hidden") {sequence++;clearTimeout(timer);controller?.abort();}
      else void load();
    };
    void load();
    window.document.addEventListener("visibilitychange",visibility);window.addEventListener("online",load);
    return () => {stopped = true;sequence++;clearTimeout(timer);controller?.abort();window.document.removeEventListener("visibilitychange",visibility);window.removeEventListener("online",load);};
  },[document.id,index,retry,active]);
  useEffect(() => {
    if (!active || !canHeartbeat) return;
    let stopped = false, retryInFlight = false;
    const beat = () => {
      if (stopped || retryInFlight || window.document.visibilityState === "hidden") return;
      const shouldRetry = retryPending.current;retryPending.current = false;
      // An ordinary heartbeat would supersede a delayed explicit retry.
      retryInFlight = shouldRetry;
      const request = ++requestSequence.current;
      const requestedIndex = current.current.index;
      void api(`/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",body:JSON.stringify({sessionId:session.id,sequence:++session.sequence,index:current.current.heartbeatIndex,active:true,mode:"reading",...(shouldRetry ? {retry:true} : {})})})
        .then((next) => {if (!stopped && request >= latestResponse.current) {latestResponse.current = request;setSnapshot(next);setError("");onPageChange?.(next.currentPage,next);}})
        .catch((cause) => {if (!stopped && request >= latestResponse.current) setError(cause.message,requestedIndex);})
        .finally(() => {if (shouldRetry) retryInFlight = false;});
    };
    const stop = () => {
      void fetch(`/api/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:session.id,sequence:++session.sequence,active:false})}).catch(() => {});
    };
    const visibility = () => window.document.visibilityState === "hidden" ? stop() : beat();
    beat(); const timer = setInterval(beat,8000);
    window.document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",stop);window.addEventListener("online",beat);
    return () => {stopped = true;clearInterval(timer);stop();window.document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",stop);window.removeEventListener("online",beat);};
  },[document.id,session,index,active,canHeartbeat,retry]);
  const receivedPage = snapshot?.currentPage;
  const receivedMatches = receivedPage?.index === currentIndex;
  const page = (receivedMatches && receivedPage.ready ? receivedPage : null)
    || snapshot?.pages?.find((item) => item.index === currentIndex && item.ready)
    || (receivedMatches ? receivedPage : null);
  const matchesIndex = (snapshot?.index ?? snapshot?.position ?? receivedPage?.index) === currentIndex;
  const hasNext = matchesIndex ? snapshot?.hasNext : !!snapshot && (snapshot.pages?.some((item) => item.index > currentIndex) || !snapshot.complete);
  const emptyComplete = snapshot?.complete && !snapshot.pages?.length;
  const progress = matchesIndex ? snapshot?.preparation : null;
  const preview = matchesIndex ? snapshot?.provisionalPreview : null;
  const percent = Number.isFinite(progress?.percent) ? Math.max(0,Math.min(100,Math.floor(progress.percent))) : null;
  const diagnostics = matchesIndex ? snapshot?.diagnostics : null;
  const preparation = readingPreparation({progress,current:diagnostics?.current,error:error || (matchesIndex ? snapshot?.error : null)});
  const failed = preparation.state === "failed" || (preparation.state === "paused" && !!preparation.errorMessage);
  // A review request carries a short reason ("正文出现较大改动…") worth showing.
  const notice = failed || (preparation.state === "requires_review" && !!preparation.errorMessage);
  const statusText = preparation.state === "requires_review" ? "需要核对" : preparation.state === "editing" ? "正在人工编辑"
    : preview?.text ? "注音还在准备" : "正在准备";
  const taskId=matchesIndex ? snapshot?.taskId || progress?.taskId : null;
  const diagnosticSourceId = diagnostics?.current?.source?.id;
  const preparationSourceIds = diagnosticSourceId ? [diagnosticSourceId,...(page?.sourceIds || []).filter((id) => id !== diagnosticSourceId)] : page?.sourceIds || [];
  const change = (next) => {setPageIndex({documentId:document.id,value:Math.max(0,next)});setError("");window.scrollTo({top:0,behavior:"instant"});};
  const canPrevious = !!snapshot && currentIndex > 0;
  const canNext = !!hasNext && !!page;
  const navigation = useRef(null);
  navigation.current = {canPrevious,canNext,change,currentIndex};
  useEffect(() => {
    if (!active) return;
    const key = (event) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const target = event.target instanceof Element ? event.target : null;
      if (target?.closest("input, textarea, select, [contenteditable='true'], .document-chat, .selection-questions, [role='dialog']")) return;
      const nav = navigation.current;
      if (event.key === "ArrowLeft" && nav.canPrevious) { event.preventDefault(); nav.change(nav.currentIndex - 1); }
      if (event.key === "ArrowRight" && nav.canNext) { event.preventDefault(); nav.change(nav.currentIndex + 1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [active]);
  const position = readingPagePosition({index:currentIndex,complete:snapshot?.complete,totalPages:snapshot?.totalPages});
  const lastPage = !!snapshot?.complete && !hasNext && !!page?.ready;
  const editCurrent = () => onEditSources(page?.ready ? page.sourceIds || [] : preparationSourceIds, currentIndex);
  const readerShown = !!page?.ready && !!bodyText(page.bodyHtml).trim();
  const pagination = !emptyComplete && snapshot ? <>
    {!(snapshot.complete && snapshot.totalPages <= 1) && <nav className="reading-pagination" aria-label="阅读分页">
      <button type="button" className="text-button" disabled={!canPrevious} onClick={() => change(currentIndex - 1)}><span aria-hidden="true">← </span>上一页</button>
      <span aria-live="polite">{position}</span>
      <button type="button" className="text-button" disabled={!canNext} onClick={() => change(currentIndex + 1)}>下一页<span aria-hidden="true"> →</span></button>
    </nav>}
    {lastPage && nextArticle && <p className="reading-next-article">
      <button type="button" className="text-button" onClick={() => bar?.onOpenArticle?.(nextArticle.id)}>下一篇：{nextArticle.title}<span aria-hidden="true"> →</span></button>
    </p>}
  </> : null;
  return <div className="paged-reader">
    {bar && <ReadingBar {...bar} onEdit={editCurrent} onGoToPage={change} onDiscuss={readerShown ? bar.onDiscuss : null}
      pages={snapshot ? {index:currentIndex,complete:snapshot.complete,totalPages:snapshot.totalPages,list:snapshot.pages || []} : null} />}
    {page?.ready && !bodyText(page.bodyHtml).trim() ? <section className="reading-preparation" aria-label="阅读页正文已清空">
      <h2>本页正文已清空</h2>
    </section> : page?.ready ? <Reader {...readerProps}
      document={{...document,bodyHtml:page.bodyHtml,bodyHash:snapshot?.bodyHash || document.bodyHash,blocks:htmlToBlocks(page.bodyHtml)}}
      headingSourceIds={page.headingSourceIds} onSegment={null} afterBody={pagination}
      onAsk={(request) => readerProps.onAsk?.({...request,selection:pageSelection(request.selection,page)})} />
      : emptyComplete ? <section className="reading-preparation" aria-label="当前文章没有正文">
        <h2>当前文章没有正文</h2>
      </section> : <>
        <section className={`reading-status${notice ? " is-failed" : ""}`} aria-label="准备当前阅读页" aria-busy={preparation.busy}>
          {notice ? <ErrorNotice error={preparation.errorMessage || "准备失败"} message={failed ? "准备失败" : "需要核对"} /> : <span role="status">{statusText}</span>}
          {!notice && <div className={`reading-status-track${percent === null && preparation.animate ? " is-indeterminate" : ""}`} role="progressbar"
            aria-label="当前阅读页准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined}
            aria-valuetext={percent === null ? statusText : `${statusText}，${percent}%`}>
            <span style={percent === null ? preparation.animate ? undefined : {width:0} : {width:`${percent}%`}} />
          </div>}
          <span className="reading-status-actions">
            {!preparation.busy && <button type="button" className="text-button" onClick={() => {retryPending.current = true;setRetry((value) => value + 1);}}>重试</button>}
            {taskId && <a className="text-button" href={`#tasks/${encodeURIComponent(taskId)}`}>查看任务</a>}
          </span>
        </section>
        {preview?.text && <section className="reader-page reading-provisional" aria-label="已提取正文预览">
          <article className="reading-sheet article" lang="ja">
            <div className="reading-provisional-text" style={{fontSize:readerProps.fontSize}}>{preview.text}{preview.truncated && "…"}</div>
          </article>
        </section>}
      </>}
    {!(page?.ready && readerShown) && pagination}
  </div>;
}
