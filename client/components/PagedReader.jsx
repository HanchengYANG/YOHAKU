import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { htmlToBlocks, bodyText } from "../../shared/article-html.mjs";
import { pageSelection, readingPageLabel, readingPreparation } from "../source-presentation.mjs";
import Reader from "./Reader.jsx";
import "../sources.css";

export default function PagedReader({ document, session, active = true, resumePosition = null, onEditSources, onPageChange, ...readerProps }) {
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
  const paused = preparation.paused;
  const taskId=matchesIndex ? snapshot?.taskId || progress?.taskId : null;
  const diagnosticSourceId = diagnostics?.current?.source?.id;
  const preparationSourceIds = diagnosticSourceId ? [diagnosticSourceId,...(page?.sourceIds || []).filter((id) => id !== diagnosticSourceId)] : page?.sourceIds || [];
  const change = (next) => {setPageIndex({documentId:document.id,value:Math.max(0,next)});setError("");window.scrollTo({top:0,behavior:"instant"});};
  return <div className="paged-reader">
    <nav className="reading-pagination" aria-label="阅读分页">
      <button className="button secondary" disabled={!snapshot || currentIndex === 0} onClick={() => change(currentIndex - 1)}>上一页</button>
      <span aria-live="polite">{emptyComplete ? "暂无正文" : readingPageLabel({index:currentIndex,complete:snapshot?.complete,totalPages:snapshot?.totalPages})}</span>
      <button className="button secondary" disabled={!hasNext || !page} onClick={() => change(currentIndex + 1)}>下一页</button>
      {!!snapshot?.pages?.length && <details className="reading-page-menu"><summary>文章目录</summary><div>{snapshot.pages.map((item) => <button key={item.id} className="text-button" aria-current={item.index === currentIndex ? "page" : undefined} onClick={() => change(item.index)}>第 {item.index + 1} 页{!item.ready ? " · 准备中" : ""}</button>)}{!snapshot.complete && <p>后续阅读页随正文准备后显示</p>}</div></details>}
    </nav>
    {page?.ready && !bodyText(page.bodyHtml).trim() ? <section className="reading-preparation" aria-label="阅读页正文已清空"><h1>{document.title}</h1><h2>本页正文已清空</h2><p>阅读页位置已保留，可继续翻页，或在校对正文中补充内容。</p><button className="button secondary" onClick={() => onEditSources(page.sourceIds || [],currentIndex)}>校对正文</button></section> : page?.ready ? <Reader {...readerProps}
      document={{...document,bodyHtml:page.bodyHtml,bodyHash:snapshot?.bodyHash || document.bodyHash,blocks:htmlToBlocks(page.bodyHtml)}}
      headingSourceIds={page.headingSourceIds}
      onEdit={() => onEditSources(page.sourceIds,currentIndex)} onSegment={null}
      onAsk={(request) => readerProps.onAsk?.({...request,selection:pageSelection(request.selection,page)})} />
      : <><section className="reading-preparation" aria-label="准备当前阅读页" aria-busy={!emptyComplete && preparation.busy}>
        <span className="eyebrow">准备阅读</span><h1>{document.title}</h1>
        <h2>{emptyComplete ? "当前文章没有正文" : preparation.state === "failed" ? "当前阅读页准备失败" : paused ? "当前阅读页尚未完成" : "正在准备当前阅读页"}</h2>
        {!emptyComplete && <div className={`reading-page-progress${paused ? " is-paused" : ""}`}>
          <div className="reading-page-progress-caption"><span role="status">{preparation.stageLabel}</span><strong>{percent === null ? preparation.statusLabel : `${percent}%${preparation.animate ? "" : ` · ${preparation.statusLabel}`}`}</strong></div>
          <div className={`reading-page-progress-track${percent === null && preparation.animate ? " is-indeterminate" : ""}`} role="progressbar" aria-label="当前阅读页准备进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent ?? undefined} aria-valuetext={`${preparation.stageLabel}，${preparation.statusLabel}${percent === null ? "" : `，${percent}%`}`}>
            <span style={percent === null ? preparation.animate ? undefined : {width:0} : {width:`${percent}%`}} />
          </div>
          {progress?.stage === "annotate" && progress.total > 0 && <small>已注音 {progress.completed} / {progress.total} 字符</small>}
          {(preparation.sourceLabel || preparation.elapsedLabel) && <div className="reading-current-step">{preparation.sourceLabel && <span>{preparation.sourceLabel}</span>}{preparation.elapsedLabel && <span>{preparation.elapsedLabel}</span>}</div>}
        </div>}
        <p role={preparation.errorMessage ? "alert" : undefined}>{emptyComplete ? "可在校对正文中补充内容。" : preparation.errorMessage || (preparation.state === "requires_review" ? "请进入校对正文查看差异并确认。" : preparation.state === "editing" ? "当前来源正在人工编辑，保存后继续准备。" : "离开页面也会继续准备，完成后自动显示正文。")}</p>
        <div className="source-actions">{!emptyComplete && !preparation.busy && <button className="button secondary" onClick={() => {retryPending.current = true;setRetry((value) => value + 1);}}>重试准备</button>}
          {taskId && <a className="button subtle" href={`#tasks/${encodeURIComponent(taskId)}`}>查看后台任务</a>}
          <button className="button subtle" onClick={() => onEditSources(preparationSourceIds,currentIndex)}>校对正文</button></div>
      </section>
      {!emptyComplete && preview?.text && <section className="reading-preparation reading-provisional" aria-label="已提取正文预览">
        <h2>已提取正文预览</h2>
        <p>{preview.source?.label && `${preview.source.label} · `}文字可能在校对后更新，准备完成后会自动显示正式阅读页。</p>
        <div className="reading-provisional-text" lang="ja">{preview.text}{preview.truncated && "…"}</div>
      </section>}</>}
    {page?.ready && <nav className="reading-pagination" aria-label="页末阅读分页"><button className="button secondary" disabled={currentIndex === 0} onClick={() => change(currentIndex - 1)}>上一页</button><span>{readingPageLabel({index:currentIndex,complete:snapshot?.complete,totalPages:snapshot?.totalPages})}</span><button className="button primary" disabled={!hasNext || !page} onClick={() => change(currentIndex + 1)}>下一页</button></nav>}
  </div>;
}
