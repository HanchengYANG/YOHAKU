import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { htmlToBlocks, bodyText } from "../../shared/article-html.mjs";
import { pageSelection, readingPageLabel, readingPreparation, processingStepLabel, processingDuration, sourceLabel } from "../source-presentation.mjs";
import Reader from "./Reader.jsx";
import "../sources.css";

const errorCategories = {timeout:"请求超时",cancelled:"请求已取消",auth:"授权失败",configuration:"角色配置不可用",rate_limit:"用量或频率限制",upstream_http:"上游服务异常",network:"网络连接异常",invalid_json:"返回的 JSON 无法解析",invalid_response:"返回结构无效",incomplete_output:"输出未完成",unknown:"原因尚未确定"};
const providerLabels = {api_base:"iliad codix",openai:"OpenAI"};
const diagnosticTime = (value) => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString("zh-CN") : null;

function DiagnosticFacts({record}) {
  const execution = record.execution || record;
  const diagnostic = record.diagnostic || record.error?.diagnostic;
  const rows = [
    ["来源",record.source && (record.source.label || sourceLabel(record.source))],
    ["步骤",processingStepLabel(record.step)],
    ["提供方",providerLabels[execution.providerId] || execution.providerId],
    ["模型",execution.model],
    ["排队耗时",processingDuration(execution.queueMs)],
    ["执行耗时",processingDuration(execution.elapsedMs)],
    ["排队时间",diagnosticTime(execution.queuedAt)],
    ["开始时间",diagnosticTime(execution.startedAt)],
    ["发生时间",diagnosticTime(record.at || record.updatedAt)],
    ["错误类别",diagnostic && (errorCategories[diagnostic.category] || "原因尚未确定")],
    ["错误代码",diagnostic?.code],
    ["HTTP 状态",Number.isInteger(diagnostic?.httpStatus) ? `HTTP ${diagnostic.httpStatus}` : null],
    ["网络错误",diagnostic?.networkCode],
    ["错误类型",diagnostic?.errorType],
    ["结束原因",diagnostic?.finishReason],
    ["处理编号",record.operationId || execution.operationId],
  ].filter(([,value]) => value !== undefined && value !== null && value !== "");
  return <dl className="reading-diagnostic-facts">{rows.map(([label,value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}

export default function PagedReader({ document, active = true, onEditSources, onPageChange, ...readerProps }) {
  const [pageIndex, setPageIndex] = useState({ documentId:document.id, value:null });
  const [response, setResponse] = useState(null);
  const [failure, setFailure] = useState(null);
  const index = pageIndex?.documentId === document.id ? pageIndex.value : null;
  const snapshot = response?.documentId === document.id ? response.snapshot : document.reading || null;
  const currentIndex = index ?? snapshot?.index ?? snapshot?.position ?? snapshot?.currentPage?.index ?? 0;
  const error = failure?.documentId === document.id && failure.index === currentIndex ? failure.message : "";
  const [retry, setRetry] = useState(0);
  const session = useRef(crypto.randomUUID());
  const retryPending = useRef(false);
  const requestSequence = useRef(0);
  const latestResponse = useRef(0);
  const current = useRef(null);
  current.current = {index:currentIndex,active};
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
    if (!active || !snapshot) return;
    let stopped = false;
    const beat = () => {
      if (stopped || window.document.visibilityState === "hidden") return;
      const shouldRetry = retryPending.current;retryPending.current = false;
      const request = ++requestSequence.current;
      const requestedIndex = current.current.index;
      void api(`/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",body:JSON.stringify({sessionId:session.current,index:requestedIndex,active:true,mode:"reading",...(shouldRetry ? {retry:true} : {})})})
        .then((next) => {if (!stopped && request >= latestResponse.current) {latestResponse.current = request;setSnapshot(next);setError("");onPageChange?.(next.currentPage,next);}})
        .catch((cause) => {if (!stopped && request >= latestResponse.current) setError(cause.message,requestedIndex);});
    };
    const stop = () => {
      void fetch(`/api/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:session.current,active:false})}).catch(() => {});
    };
    const visibility = () => window.document.visibilityState === "hidden" ? stop() : beat();
    beat(); const timer = setInterval(beat,8000);
    window.document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",stop);window.addEventListener("online",beat);
    return () => {stopped = true;clearInterval(timer);stop();window.document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",stop);window.removeEventListener("online",beat);};
  },[document.id,index,active,!!snapshot,retry]);
  const receivedPage = snapshot?.currentPage;
  const receivedMatches = receivedPage?.index === currentIndex;
  const page = (receivedMatches && receivedPage.ready ? receivedPage : null)
    || snapshot?.pages?.find((item) => item.index === currentIndex && item.ready)
    || (receivedMatches ? receivedPage : null);
  const matchesIndex = (snapshot?.index ?? snapshot?.position ?? receivedPage?.index) === currentIndex;
  const hasNext = matchesIndex ? snapshot?.hasNext : !!snapshot && (snapshot.pages?.some((item) => item.index > currentIndex) || !snapshot.complete);
  const emptyComplete = snapshot?.complete && !snapshot.pages?.length;
  const progress = matchesIndex ? snapshot?.preparation : null;
  const percent = Number.isFinite(progress?.percent) ? Math.max(0,Math.min(100,Math.floor(progress.percent))) : null;
  const diagnostics = matchesIndex ? snapshot?.diagnostics : null;
  const preparation = readingPreparation({progress,current:diagnostics?.current,error:error || (matchesIndex ? snapshot?.error : null)});
  const paused = preparation.paused;
  const recentFailures = snapshot?.diagnostics?.recentFailures?.slice(0,5) || [];
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
    {page?.ready && !bodyText(page.bodyHtml).trim() ? <section className="reading-preparation" aria-label="阅读页正文已清空"><h1>{document.title}</h1><h2>本页正文已清空</h2><p>阅读页位置已保留，可继续翻页，或在校对正文中补充内容。</p><button className="button secondary" onClick={() => onEditSources(page.sourceIds || [])}>校对正文</button></section> : page?.ready ? <Reader {...readerProps}
      document={{...document,bodyHtml:page.bodyHtml,bodyHash:snapshot?.bodyHash || document.bodyHash,blocks:htmlToBlocks(page.bodyHtml)}}
      headingSourceIds={page.headingSourceIds}
      onEdit={() => onEditSources(page.sourceIds)} onSegment={null}
      onAsk={(request) => readerProps.onAsk?.({...request,selection:pageSelection(request.selection,page)})} />
      : <section className="reading-preparation" aria-label="准备当前阅读页" aria-busy={!emptyComplete && preparation.busy}>
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
        {diagnostics?.current && <details className="reading-diagnostics"><summary>处理详情</summary><DiagnosticFacts record={diagnostics.current} /></details>}
        <div className="source-actions">{!emptyComplete && !preparation.busy && <button className="button secondary" onClick={() => {retryPending.current = true;setRetry((value) => value + 1);}}>重试准备</button>}
          {taskId && <a className="button subtle" href={`#tasks/${encodeURIComponent(taskId)}`}>查看后台任务</a>}
          <button className="button subtle" onClick={() => onEditSources(preparationSourceIds)}>校对正文</button></div>
      </section>}
    {recentFailures.length > 0 && <details className="reading-diagnostics reading-diagnostics-history"><summary>最近处理异常（{recentFailures.length}）</summary><div aria-label="最近处理异常记录"><p className="source-scope-note">以下是历史记录，不代表当前阅读页仍有错误。</p>{recentFailures.map((failure) => <section key={failure.id}><p>{failure.message}</p><DiagnosticFacts record={failure} /></section>)}</div></details>}
    {page?.ready && <nav className="reading-pagination" aria-label="页末阅读分页"><button className="button secondary" disabled={currentIndex === 0} onClick={() => change(currentIndex - 1)}>上一页</button><span>{readingPageLabel({index:currentIndex,complete:snapshot?.complete,totalPages:snapshot?.totalPages})}</span><button className="button primary" disabled={!hasNext || !page} onClick={() => change(currentIndex + 1)}>下一页</button></nav>}
  </div>;
}
