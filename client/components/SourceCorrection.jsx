import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { bodyText, bodyRanges, htmlToBlocks } from "../../shared/article-html.mjs";
import { sourceLabel } from "../source-presentation.mjs";
import Editor from "./Editor.jsx";
import ArticleBody from "./ArticleBody.jsx";
import DocumentChat from "./DocumentChat.jsx";
import "../sources.css";

function SourcePreview({ source }) {
  const [zoom,setZoom] = useState(100), [rotation,setRotation] = useState(0);
  const [pageLoaded,setPageLoaded] = useState(false), [pageError,setPageError] = useState(false);
  const preview = source.preview || {}, kind = preview.type || preview.kind;
  const image = ["photo","screenshot","image"].includes(source.type) || kind === "image";
  const pdf = ["text_pdf","scan_pdf","pdf_text","pdf_scan"].includes(source.type) || kind === "pdf";
  const url = preview.url || (source.imageId ? `/api/images/${encodeURIComponent(source.imageId)}/raw` : null);
  const originalUrl = url || (source.original?.importId && source.original?.fileId
    ? `/api/imports/${encodeURIComponent(source.original.importId)}/files/${encodeURIComponent(source.original.fileId)}/raw` : null);
  const pdfPage = preview.page || source.original?.page || 1;
  const pdfUrl = pdf ? originalUrl?.split("#")[0] : null;
  const pdfPageImage = pdfUrl && /\/api\/imports\/[^/?#]+\/files\/[^/?#]+\/raw$/.test(pdfUrl) ? pdfUrl.replace(/\/raw$/,`/pages/${pdfPage}`) : null;
  return <div className="source-preview">
    <h2>{source.original?.label || "原始来源"}</h2>
    {image && url ? <><div className="source-preview-controls"><label>缩放 <input aria-label="原图缩放" type="range" min="50" max="250" step="25" value={zoom} onChange={(e) => setZoom(Number(e.target.value))} /> {zoom}%</label><button className="text-button" onClick={() => setRotation((value) => value - 90)}>向左旋转</button><button className="text-button" onClick={() => setRotation((value) => value + 90)}>向右旋转</button></div>
      <div className="source-image-viewport"><img alt={sourceLabel(source)} src={url} style={{width:`${zoom}%`,maxWidth:"none",transform:`rotate(${rotation}deg)`}} /></div></>
      : pdf && pdfUrl ? <><p>PDF 实际页码：{pdfPage}</p>{pdfPageImage ? <>
        <div className="source-preview-controls"><label>缩放 <input aria-label="PDF 原页缩放" type="range" min="50" max="250" step="25" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /> {zoom}%</label></div>
        <div className="source-image-viewport" aria-busy={!pageLoaded && !pageError}><img alt={`PDF 原始页面，第 ${pdfPage} 页`} src={pdfPageImage} style={{width:`${zoom}%`,maxWidth:"none"}} onLoad={() => {setPageLoaded(true);setPageError(false);}} onError={() => setPageError(true)} /></div>
        {!pageLoaded && !pageError && <p role="status">正在加载 PDF 原页…</p>}{pageError && <p role="alert">原页图像暂时无法加载，请打开完整原 PDF 对照。</p>}
      </> : <iframe title="PDF 原始页面" src={`${pdfUrl}#page=${pdfPage}`} />}<a href={`${pdfUrl}#page=${pdfPage}`} target="_blank" rel="noreferrer" className="text-button">打开完整原 PDF</a></>
        : preview.html ? <div className="source-original-html"><ArticleBody html={preview.html} showRuby fontSize={22} /></div>
          : <pre className="source-original-text">{preview.text ?? source.original?.snapshot ?? source.original?.text ?? source.originalText ?? "原始内容尚未加载"}</pre>}
    {source.original?.chapterHtml && <details><summary>查看完整原始章节</summary><div className="source-original-chapter"><ArticleBody html={source.original.chapterHtml} showRuby fontSize={22} /></div></details>}
    {!image && !pdf && originalUrl && <a href={originalUrl} target="_blank" rel="noreferrer" className="text-button">打开原始文件</a>}
  </div>;
}

export default function SourceCorrection({ document, sourceIds = [], reviewSourceId, onClose, onDirty, onDocumentChanged, chatSession }) {
  const [sources,setSources] = useState([]), [activeId,setActiveId] = useState(null), [source,setSource] = useState(null);
  const [html,setHtml] = useState(""), [editing,setEditing] = useState(false), [dirty,setDirty] = useState(false), [proposalEditing,setProposalEditing] = useState(false);
  const [error,setError] = useState(""), [busy,setBusy] = useState(false), [overview,setOverview] = useState(false);
  const [selection,setSelection] = useState(null), [notice,setNotice] = useState("");
  const [chatOpen,setChatOpen] = useState(false), [chatRequest,setChatRequest] = useState(null), [chatNavigation,setChatNavigation] = useState(null), [answering,setAnswering] = useState(false);
  const session = useRef(crypto.randomUUID()), detailSequence = useRef(0), isEditing = useRef(false);
  const reviewSequence = useRef(0);
  const route = `/documents/${encodeURIComponent(document.id)}/sources`;
  const loadSources = async () => {const result = await api(route);setSources(result.sources);return result.sources;};
  useEffect(() => {
    let stopped = false;
    loadSources().then((list) => {
      if (stopped) return;
      if (reviewSourceId && !list.some((item) => item.id === reviewSourceId)) {
        setError("这条待核对来源已不可用，请返回阅读。");
        return;
      }
      const preferred = reviewSourceId || sourceIds.find((id) => list.some((item) => item.id === id));
      setActiveId(preferred || list[0]?.id || null);
    }).catch((cause) => {if (!stopped) setError(cause.message);});
    return () => {stopped = true;};
  },[document.id,reviewSourceId]);
  useEffect(() => {
    if (!activeId) return;
    let stopped = false, timer;
    const sequence = ++detailSequence.current;
    const load = async () => {
      const review = reviewSequence.current;
      try {
        const result = await api(`${route}/${encodeURIComponent(activeId)}`);
        if (stopped || sequence !== detailSequence.current || review !== reviewSequence.current) return;
        setSource((current) => isEditing.current ? current : result);
        if (!isEditing.current) setHtml(result.bodyHtml || "");
        setSources((current) => current.map((item) => item.id === result.id ? result : item));
      } catch (cause) {if (!stopped && review === reviewSequence.current) setError(cause.message);}
      finally {if (!stopped) timer = setTimeout(load,2000);}
    };
    setSource(null);setError("");setEditing(false);isEditing.current = false;setDirty(false);onDirty?.(false);setSelection(null);setNotice("");
    void load();
    if (activeId !== reviewSourceId) void api(`${route}/${encodeURIComponent(activeId)}/prepare`,{method:"POST",body:JSON.stringify({sessionId:session.current})}).catch((cause) => {if (!stopped) setError(cause.message);});
    return () => {stopped = true;clearTimeout(timer);};
  },[document.id,activeId,reviewSourceId]);
  useEffect(() => {
    if (!activeId) return;
    let stopped = false;
    const prepareWhileOpen = activeId !== reviewSourceId;
    const beat = () => {
      if (stopped || window.document.visibilityState === "hidden") return;
      if (prepareWhileOpen) void api(`/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",body:JSON.stringify({sessionId:session.current,active:true,mode:"correction",sourceId:activeId})}).catch(() => {});
      if (isEditing.current) void api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"POST",body:JSON.stringify({sessionId:session.current})}).catch(() => {});
    };
    const stop = () => {if (prepareWhileOpen) void fetch(`/api/documents/${encodeURIComponent(document.id)}/reading-session`,{method:"POST",keepalive:true,headers:{"Content-Type":"application/json"},body:JSON.stringify({sessionId:session.current,active:false})}).catch(() => {});};
    const visibility = () => window.document.visibilityState === "hidden" ? stop() : beat();
    beat();const timer = setInterval(beat,8000);window.document.addEventListener("visibilitychange",visibility);window.addEventListener("pagehide",stop);
    return () => {stopped = true;clearInterval(timer);stop();window.document.removeEventListener("visibilitychange",visibility);window.removeEventListener("pagehide",stop);void api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"DELETE",body:JSON.stringify({sessionId:session.current})}).catch(() => {});};
  },[document.id,activeId,reviewSourceId]);
  const beginEdit = async (overrideHtml) => {
    const proposed = typeof overrideHtml === "string" ? overrideHtml : null;
    const clickedVersion = source?.version, clickedProposal = source?.proposal?.bodyHtml;
    setProposalEditing(proposed !== null);
    setBusy(true);setError("");
    try {
      const latest = await api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"POST",body:JSON.stringify({sessionId:session.current})});
      if (proposed !== null && (latest.version !== clickedVersion || proposed !== clickedProposal || latest.proposal?.bodyHtml !== proposed)) {
        await api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"DELETE",body:JSON.stringify({sessionId:session.current})}).catch(() => {});
        setSource(latest);setHtml(latest.bodyHtml || "");
        setSources((current) => current.map((item) => item.id === latest.id ? latest : item));
        setProposalEditing(false);
        setError("版本冲突：来源正文或 AI 提议已更新，请重新核对后再编辑。");
        return;
      }
      if (latest.bodyHtml !== undefined) {setSource(latest);setHtml(proposed ?? latest.bodyHtml);}
      isEditing.current = true;setEditing(true);
    } catch (cause) {setError(cause.message);}
    finally {setBusy(false);}
  };
  const save = async (value) => {
    const savedHtml = value?.bodyHtml ?? html;
    setBusy(true);setError("");
    try {
      const latest = await api(`${route}/${encodeURIComponent(activeId)}`,{method:"PUT",body:JSON.stringify({version:source.version,bodyHtml:savedHtml,sessionId:session.current})});
      setSource(latest);setHtml(latest.bodyHtml);setDirty(false);onDirty?.(false);setNotice("已保存，将仅补齐受修改影响的分句和注音");
      setSources((current) => current.map((item) => item.id === latest.id ? latest : item));
      isEditing.current = false;setEditing(false);
      await api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"DELETE",body:JSON.stringify({sessionId:session.current})});
      onDocumentChanged?.();
    } catch (cause) {setError(cause.message);}
    finally {setBusy(false);}
  };
  const keepCurrent = async () => {
    const sourceRoute = `${route}/${encodeURIComponent(activeId)}`;
    setBusy(true);setError("");setNotice("");
    let latest;
    try {
      latest = await api(`${sourceRoute}/keep-current`,{method:"POST",body:JSON.stringify({version:source.version,proposalToken:source.proposalToken,sessionId:session.current})});
      setNotice("已保留当前正文，后台将继续分句和注音。");
      onDocumentChanged?.();
    } catch (cause) {
      setError(cause.message);
      if (cause.status === 409) latest = await api(sourceRoute).catch(() => null);
    } finally {
      if (latest) {
        reviewSequence.current++;
        setSource(latest);setHtml(latest.bodyHtml || "");setSelection(null);
        setSources((current) => current.map((item) => item.id === latest.id ? latest : item));
      }
      setBusy(false);
    }
  };
  const markChecked = async () => {
    setBusy(true);setError("");
    try {const latest = await api(`${route}/${encodeURIComponent(activeId)}/checked`,{method:"POST",body:JSON.stringify({version:source.version,checked:!source.checked})});setSource(latest);setSources((current) => current.map((item) => item.id === latest.id ? latest : item));}
    catch (cause) {setError(cause.message);}finally {setBusy(false);}
  };
  const switchSource = (id) => {
    if (busy || (dirty && !window.confirm("当前来源修改还没有保存，确定切换吗？"))) return;
    setActiveId(id);
  };
  const reorder = async (direction) => {
    const index = sources.findIndex((item) => item.id === activeId), destination = index + direction;
    if (destination < 0 || destination >= sources.length || dirty) return;
    const ids = sources.map((item) => item.id);[ids[index],ids[destination]] = [ids[destination],ids[index]];
    setBusy(true);setError("");
    try {await api(`${route}/reorder`,{method:"POST",body:JSON.stringify({sourceIds:ids})});await loadSources();onDocumentChanged?.();}
    catch(cause){setError(cause.message);}finally{setBusy(false);}
  };
  const ask = async (operation = "translation", reference = selection, question) => {
    const selection = reference;
    if (!selection || !source || answering || dirty) return;
    setError("");
    try {
      const [latestDocument,latestSource] = await Promise.all([
        api(`/documents/${encodeURIComponent(document.id)}`),api(`${route}/${encodeURIComponent(activeId)}`),
      ]);
      if (latestSource.version !== source.version) throw new Error("来源正文已更新，请重新选择文字后提问。");
      const start = (latestSource.articleStart ?? latestSource.start ?? 0) + selection.start, end = start + selection.text.length;
      if (bodyText(latestDocument.bodyHtml).slice(start,end) !== selection.text) throw new Error("选区已变化，请重新选择文字后提问。");
      const sentenceIds = bodyRanges(latestDocument.bodyHtml).sentences.filter((item) => item.start < end && item.end > start).map((item) => item.id);
      if (!sentenceIds.length) throw new Error("此处正文尚未完成分句，请完成准备后提问。");
      const {rect,...reference} = selection;
      setChatRequest({key:crypto.randomUUID(),operation,question,selection:{...reference,start,end,bodyHash:latestDocument.bodyHash,sentenceIds,sourceIds:[activeId],sourceVersion:latestSource.version,sourceLocalStart:selection.start,sourceLocalEnd:selection.end}});setChatOpen(true);
    } catch(cause) {setError(cause.message);}
  };
  const viewGroups = (ids) => {setChatNavigation({key:crypto.randomUUID(),documentId:document.id,groupIds:ids});setChatRequest(null);setChatOpen(true);};
  const first = source?.firstExtraction;
  return <section className={`source-correction ${chatOpen ? "has-chat" : ""}`} aria-label="校对正文">
    <div className="source-correction-main"><div className="source-heading"><div><span className="eyebrow">校对正文</span><h1>{document.title}</h1></div><button className="button subtle" disabled={busy} onClick={onClose}>返回阅读</button></div>
      <div className="source-toolbar"><label>当前来源 <select aria-label="切换校对来源" value={activeId || ""} disabled={busy} onChange={(e) => switchSource(e.target.value)}>{!activeId && <option value="" disabled>选择来源</option>}{sources.map((item) => <option key={item.id} value={item.id}>{sourceLabel(item)} · {item.checked ? "已核对" : "待核对"}</option>)}</select></label>
        {sources.length > 1 && sources.every((item) => ["photo","screenshot","image"].includes(item.type)) && <><button className="text-button" disabled={busy || dirty || sources[0]?.id === activeId} onClick={() => reorder(-1)}>来源上移</button><button className="text-button" disabled={busy || dirty || sources.at(-1)?.id === activeId} onClick={() => reorder(1)}>来源下移</button></>}
        <button className="button secondary" onClick={() => {setOverview(!overview);void loadSources();}}>全文检查</button><button className="button subtle" onClick={() => setChatOpen(!chatOpen)}>对话记录</button></div>
      {error && <p className="source-error" role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
      {overview ? <div className="source-overview"><h2>已准备正文与待准备位置</h2><p>这里只展示已保存内容。选择来源后才准备该来源。</p>{sources.map((item) => <section key={item.id}><button className="text-button" onClick={() => {switchSource(item.id);setOverview(false);}}>{sourceLabel(item)} · {item.checked ? "已核对" : "待核对"}</button>{item.bodyHtml && bodyText(item.bodyHtml).trim() ? <ArticleBody html={item.bodyHtml} showRuby fontSize={22} /> : item.firstExtraction && item.status === "ready" ? <p>{item.original?.importExclusions?.length ? "非正文内容已排除" : "此来源没有正文"}</p> : <p className="source-unprepared">此处正文尚未准备</p>}</section>)}</div>
        : !source ? !error && <p role="status">正在读取来源…</p> : <>
          <p className="source-scope-note">本次编辑只影响当前文章中的对应正文。原始资料和首次提取结果保留，可同时对照完整来源。</p>
          {source.original?.boundaryNeedsReview && <p className="source-boundary-note">此处章节边界待核对，可对照 PDF 原页确认正文范围。</p>}
          {activeId === reviewSourceId && !source.proposal?.bodyHtml && !notice && <p role="status">此来源当前没有待核对的提议。</p>}
          {source.proposal?.bodyHtml && <section className="source-proposal" role="alert"><h2>AI 修改需要核对</h2><p>校正结果包含整句、整段删除或较大改写，处理已暂停。请对照原始来源和以下差异。可保留当前正文，或编辑 AI 提议后保存。</p><div className="source-diff"><div><h3>当前正文</h3><pre>{bodyText(html)}</pre></div><div><h3>AI 提议</h3><pre>{bodyText(source.proposal.bodyHtml)}</pre></div></div><div className="source-actions">{source.proposalToken && <button className="button primary" disabled={busy || editing} onClick={keepCurrent}>保留当前正文并继续</button>}<button className="button secondary" disabled={busy || editing} onClick={() => beginEdit(source.proposal.bodyHtml)}>核对并编辑此提议</button></div></section>}
          <div className="source-correction-grid"><div className="source-edit-pane"><div className="source-status-row"><span className="source-status">{source.checked ? "已核对" : "待核对"}</span><span>{source.processing ? "处理中" : ({ready:"处理完成",pending:"等待准备",failed:"准备失败",requires_review:"AI 修改待核对"})[source.status] || ""}</span></div>
            {!editing ? <><div className="source-current-body">{bodyText(html).trim() ? <ArticleBody html={html} showRuby fontSize={24} onGroup={viewGroups} onSelection={setSelection} /> : <p>{source.error ? "提取失败，可以对照来源人工录入。" : source.manual || source.status === "ready" ? "此来源当前没有正文内容。" : "此来源正文尚未准备，可以等待或人工录入。"}</p>}</div><button className="button primary" disabled={busy} onClick={beginEdit}>编辑正文与注音</button></>
              : <><p className="source-editing-note">正在人工编辑，此来源的自动正文更新已冻结。</p>
                <Editor key={`${activeId}:${source.version}`} initial={{...document,bodyHtml:html,blocks:htmlToBlocks(html),sourceImages:[],sourceImageId:null,recognition:null,bookId:undefined}}
                  sourceScope={{initialDirty:proposalEditing,onBodyChange:setHtml,onGroup:viewGroups,onAsk:({selection:reference,operation,question}) => ask(operation,reference,question)}}
                  onSave={save} saving={busy} onDirty={(next) => {setDirty(next);onDirty?.(next);}} chatSession={chatSession}
                  onCancel={() => {if (dirty && !window.confirm("放弃当前来源尚未保存的修改？")) return;setHtml(source.bodyHtml || "");setDirty(false);onDirty?.(false);isEditing.current = false;setEditing(false);void api(`${route}/${encodeURIComponent(activeId)}/edit`,{method:"DELETE",body:JSON.stringify({sessionId:session.current})});}} />
              </>}
            <div className="source-actions">{!editing && <button className="button subtle" disabled={!selection || answering || dirty} onClick={() => ask()}>翻译选区</button>}<button className="button secondary" disabled={busy || dirty} onClick={markChecked}>{source.checked ? "改为待核对" : "标记已核对"}</button><button className="text-button" disabled={busy} onClick={() => {setError("");void api(`${route}/${encodeURIComponent(activeId)}/prepare`,{method:"POST",body:JSON.stringify({sessionId:session.current})}).catch((cause) => setError(cause.message));}}>重试准备此来源</button></div>
            <details className="source-history"><summary>首次结果、AI 修改与差异</summary>{first ? <><h3>{source.type === "photo" ? "AI 识别与校正结果" : first.label || "首次提取结果"}</h3><pre>{first.text ?? bodyText(first.bodyHtml || "")}</pre><div className="source-diff"><div><h3>首次结果</h3><pre>{first.text ?? bodyText(first.bodyHtml || "")}</pre></div><div><h3>当前正文</h3><pre>{bodyText(html)}</pre></div></div></> : <p>尚无首次提取结果。</p>}{(source.changes || []).map((change,index) => <details key={change.id || index}><summary>{change.label || change.step || "正文修改"} · {change.createdAt || ""}</summary><pre>{change.beforeText ?? change.before ?? ""}</pre><pre>{change.afterText ?? change.after ?? change.text ?? (change.bodyHtml ? bodyText(change.bodyHtml) : "")}</pre></details>)}</details>
          </div><SourcePreview key={activeId} source={source} /></div>
        </>}
    </div>
    <DocumentChat document={document} open={chatOpen} session={chatSession} request={chatRequest} navigation={chatNavigation} onBusyChange={setAnswering} onOpen={() => setChatOpen(true)} onRequestHandled={() => setChatRequest(null)} onClose={() => setChatOpen(false)} onDocumentChanged={onDocumentChanged} />
  </section>;
}
