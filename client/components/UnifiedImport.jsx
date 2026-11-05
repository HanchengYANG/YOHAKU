import { useEffect, useRef, useState } from "react";
import api, { readApiResult } from "../api.mjs";
import { moveChapter, mergeChapter, splitChapter } from "../source-presentation.mjs";
import "../sources.css";

const typeNames = { photo:"照片", screenshot:"截图", scan_pdf:"扫描 PDF", text_pdf:"文字 PDF", epub:"EPUB", text:"纯文本／粘贴文字" };
function ChapterPagePreview({ importId, file, chapter, nextChapter, index, totalPages }) {
  const [expanded, setExpanded] = useState(false), [page, setPage] = useState(chapter.startPage);
  const [imageState, setImageState] = useState("loading"), [attempt, setAttempt] = useState(0);
  const maxPage = Math.max(1, totalPages || chapter.endPage || 1);
  const currentPage = Math.min(maxPage, Math.max(1, page || 1));
  useEffect(() => { setPage(chapter.startPage); }, [chapter.startPage, chapter.endPage]);
  useEffect(() => { setImageState("loading"); }, [currentPage, expanded, attempt]);
  const url = `/api/imports/${encodeURIComponent(importId)}/files/${encodeURIComponent(file.id)}/pages/${currentPage}`;
  return <details className="chapter-page-review" onToggle={(event) => setExpanded(event.currentTarget.open)}>
    <summary><span>核对原页</span><small>PDF 第 {chapter.startPage}–{chapter.endPage} 页</small></summary>
    {expanded && <section aria-label={`章节 ${index + 1} 原页核对`}>
      <p>对照原页后，再勾选「已核对章节边界」。</p>
      <div className="chapter-preview-controls">
        <button type="button" className="button subtle" onClick={() => setPage(chapter.startPage)}>本章首页</button>
        <button type="button" className="button subtle" onClick={() => setPage(chapter.endPage)}>本章尾页</button>
        {nextChapter && <button type="button" className="button subtle" onClick={() => setPage(nextChapter.startPage)}>下一章首页</button>}
      </div>
      <div className="chapter-preview-pagination">
        <button type="button" className="button secondary" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <strong aria-live="polite">PDF 实际第 {currentPage} 页{totalPages ? ` / 共 ${totalPages} 页` : ""}</strong>
        <button type="button" className="button secondary" disabled={currentPage >= maxPage} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div>
      {imageState === "loading" && <p role="status">正在加载原页…</p>}
      {imageState === "error" && <p className="source-error" role="alert">原页未能加载。<button type="button" className="text-button" onClick={() => setAttempt((value) => value + 1)}>重试加载原页</button></p>}
      <div className="chapter-preview-image"><img key={`${currentPage}:${attempt}`} src={url} decoding="async"
        alt={`章节 ${index + 1} · PDF 第 ${currentPage} 页原图`} onLoad={() => setImageState("ready")} onError={() => setImageState("error")} /></div>
    </section>}
  </details>;
}
export default function UnifiedImport({ onCancel, onImported, onDirty, initialBookId, initialTargetId, initialImportId, initialText = false }) {
  const [text, setText] = useState("");
  const [title, setTitle] = useState("");
  const [files, setFiles] = useState([]);
  const [draft, setDraft] = useState(null);
  const [availableDrafts, setAvailableDrafts] = useState([]);
  const [type, setType] = useState("");
  const [asBook, setAsBook] = useState(false);
  const [chapters, setChapters] = useState([]);
  const [exclusions, setExclusions] = useState([]);
  const [restoring, setRestoring] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState(initialText ? "text" : "files");
  const fileInput = useRef(null);
  const pasted = useRef([]);
  const loadedContext = useRef(null);
  const dirty = () => onDirty?.(true);
  const processing = draft?.chapterProcessing;
  const chapterRunning = ["queued","extracting","proposing"].includes(processing?.status);
  const chapterFailed = ["failed","timeout"].includes(processing?.status) || !!draft?.chapterError;
  const structureLocked = busy || chapterRunning;
  const context = {initialBookId:initialBookId || null,initialTargetId:initialTargetId || null};
  const storageKey = `yohaku:import-draft:${JSON.stringify(context)}`;
  const forgetDraft = () => {try {sessionStorage.removeItem(storageKey);} catch {}};
  const matchesContext = (item) => (item.context?.bookId || null) === context.initialBookId && (item.context?.targetId || null) === context.initialTargetId;
  useEffect(() => {
    loadedContext.current = null;setRestoring(true);setDraft(null);setAvailableDrafts([]);setChapters([]);setExclusions([]);
    let stopped = false, controller;
    const listDrafts = async () => {
      controller = new AbortController();
      const result = await api("/imports",{signal:controller.signal});
      if (!stopped) setAvailableDrafts((result.drafts || []).filter((item) => item.status === "staged" && matchesContext(item)));
    };
    const restore = async () => {
      try {
        let saved;
        try {saved = JSON.parse(sessionStorage.getItem(storageKey) || "null");} catch {forgetDraft();}
        if(initialImportId && saved?.id !== initialImportId)saved={id:initialImportId,context};
        if (!saved?.id || saved.context?.initialBookId !== context.initialBookId || saved.context?.initialTargetId !== context.initialTargetId) {await listDrafts();return;}
        controller = new AbortController();
        const result = await api(`/imports/${encodeURIComponent(saved.id)}`,{signal:controller.signal});
        if (stopped) return;
        if (result.status !== "staged") {forgetDraft();await listDrafts();return;}
        const restoredType = saved.type || result.chapterProcessing?.type || result.detectedType;
        const status = result.chapterProcessing?.status || null;
        const reuseEdits = !["queued","extracting","proposing"].includes(status) && status === saved.chapterProcessingStatus;
        setDraft(result);setType(restoredType);setTitle(saved.title || result.title || "");
        setAsBook((saved.asBook ?? !!result.chapterAttempted) && !["photo","screenshot"].includes(restoredType));
        setChapters(reuseEdits && Array.isArray(saved.chapters) ? saved.chapters : result.chapters || []);
        setExclusions(reuseEdits && Array.isArray(saved.exclusions) ? saved.exclusions : result.exclusions || []);
        dirty();
      } catch (cause) {
        if (!stopped && cause.name !== "AbortError") {
          if (cause instanceof SyntaxError || [401,403,404].includes(cause.status)) forgetDraft();
          else if (cause.status || cause instanceof TypeError) setError(`暂时无法恢复导入草稿：${cause.message}`);
          try {await listDrafts();} catch {}
        }
      }
      finally {if (!stopped) {loadedContext.current = storageKey;setRestoring(false);}}
    };
    void restore();
    return () => {stopped = true;controller?.abort();};
  },[storageKey,initialImportId]);
  useEffect(() => {
    if (restoring || loadedContext.current !== storageKey || !draft?.id || draft.status !== "staged") return;
    try {sessionStorage.setItem(storageKey,JSON.stringify({id:draft.id,context,asBook,type,title,chapters,exclusions,chapterProcessingStatus:processing?.status || null}));onDirty?.(false);} catch {}
  },[storageKey,restoring,draft?.id,draft?.status,processing?.status,asBook,type,title,chapters,exclusions]);
  useEffect(() => {
    if (!draft?.id || !chapterRunning) return;
    let stopped = false, timer, controller;
    const poll = async () => {
      controller = new AbortController();
      try {
        const result = await api(`/imports/${encodeURIComponent(draft.id)}`,{signal:controller.signal});
        if (stopped) return;
        setDraft(result);setError("");
        if (!["queued","extracting","proposing"].includes(result.chapterProcessing?.status)) {
          setChapters(result.chapters || []);setExclusions(result.exclusions || []);
          return;
        }
      } catch (cause) {
        if (stopped || cause.name === "AbortError") return;
        setError(cause.message);
      }
      if (!stopped) timer = setTimeout(poll,1000);
    };
    timer = setTimeout(poll,1000);
    return () => {stopped = true;clearTimeout(timer);controller?.abort();};
  },[draft?.id,chapterRunning]);
  const resumeDraft = async (id) => {
    if (busy) return;
    setBusy(true);setError("");
    try {
      const result = await api(`/imports/${encodeURIComponent(id)}`);
      if (result.status !== "staged" || !matchesContext(result)) throw new Error("此导入已完成或不属于当前导入位置，请重新选择。");
      const restoredType = result.chapterProcessing?.type || result.detectedType;
      setDraft(result);setType(restoredType);setTitle(result.title || "");
      setAsBook(!!result.chapterAttempted && restoredType?.includes("pdf"));
      setChapters(result.chapters || []);setExclusions(result.exclusions || []);dirty();
    } catch (cause) {setError(cause.message);}
    finally {setBusy(false);}
  };
  const stage = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      let result;
      if (mode === "text") result = await api("/imports", {method:"POST",body:JSON.stringify({text,title,bookId:initialBookId || undefined,targetId:initialTargetId || undefined})});
      else {
        const body = new FormData(); files.forEach((file) => body.append("files",file));
        body.append("title",title);
        if (initialBookId) body.append("bookId",initialBookId);
        if (initialTargetId) body.append("targetId",initialTargetId);
        result = await readApiResult(await fetch("/api/imports", {method:"POST",body}));
      }
      setDraft(result); setType(result.detectedType); setTitle(title || result.title || "");
      setChapters(result.chapters || []);setExclusions(result.exclusions || []); dirty();
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const propose = async () => {
    if (structureLocked) return;
    setBusy(true); setError("");
    try {
      const result = await api(`/imports/${encodeURIComponent(draft.id)}/chapters`, {method:"POST",body:JSON.stringify({type,title})});
      setDraft(result); setChapters(result.chapters || []);setExclusions(result.exclusions || []); dirty();
    } catch (cause) {
      setError(cause.message);
      try {const result = await api(`/imports/${encodeURIComponent(draft.id)}`);setDraft(result);setChapters(result.chapters || []);setExclusions(result.exclusions || []);}catch{}
    }
    finally { setBusy(false); }
  };
  const confirm = async () => {
    if (structureLocked) return;
    setBusy(true); setError("");
    try {
      const result = await api(`/imports/${encodeURIComponent(draft.id)}/confirm`, {method:"POST",body:JSON.stringify({
        type,title:title.trim(),asBook:!["photo","screenshot"].includes(type) && asBook,bookId:initialBookId || undefined,targetId:initialTargetId || undefined,
        chapters:asBook && type.includes("pdf") ? chapters : undefined,
        exclusions:asBook && type.includes("pdf") ? exclusions : undefined,
      })});
      forgetDraft();onDirty?.(false); onImported(result);
    } catch (cause) { setError(cause.message); }
    finally { setBusy(false); }
  };
  const updateChapter = (index, patch) => { setChapters((current) => current.map((item,i) => i === index ? {...item,...patch} : item)); dirty(); };
  return <section className="unified-import editor-page" aria-label="统一导入">
    <div className="source-heading"><div><span className="eyebrow">统一导入</span><h1>添加阅读资料</h1></div>
      <button className="button subtle" disabled={busy} onClick={onCancel}>返回</button></div>
    <p>照片、截图、PDF、EPUB 和文字会保留原始来源，按阅读进度准备正文。</p>
    {(error || processing?.error || draft?.chapterError) && <p className="source-error" role="alert">{error || processing?.error || draft.chapterError}</p>}
    {restoring ? <p role="status">正在恢复导入草稿…</p> : !draft ? <>
      {!!availableDrafts.length && <section aria-label="继续未完成的导入"><h2>继续未完成的导入</h2>
        {availableDrafts.map((item) => <div key={item.id} className="source-chapter"><div style={{minWidth:0,overflowWrap:"anywhere"}}><strong>{item.title || "未命名资料"}</strong>
          <p>{item.chapterProcessing?.status === "queued" ? "资源排队中，等待开始提取和分章。" : item.chapterProcessing?.status === "extracting" ? `${(item.chapterProcessing.type || item.detectedType) === "scan_pdf" ? "全书本地 OCR" : "全书文字提取"}：${item.chapterProcessing.completedPages ?? 0} / ${item.chapterProcessing.totalPages || "待确定"} 页`
            : item.chapterProcessing?.status === "proposing" ? `正在由 AI 分章 · 已提取 ${item.chapterProcessing.completedPages ?? 0} / ${item.chapterProcessing.totalPages || "待确定"} 页`
              : item.chapterProcessing?.status === "done" ? "分章已完成，等待确认章节与排除内容。" : ["failed","timeout"].includes(item.chapterProcessing?.status) ? "分章未完成，可继续重试或手工编辑。" : "原始资料已保存，等待确认导入。"}</p></div>
          <button className="button secondary" type="button" disabled={busy} style={{whiteSpace:"normal",overflowWrap:"anywhere",textAlign:"left"}} onClick={() => resumeDraft(item.id)}>继续导入：{item.title || "未命名资料"}</button>
        </div>)}
      </section>}
      <div className="source-tabs" role="tablist" aria-label="导入方式">
        <button role="tab" aria-selected={mode === "files"} className="button secondary" disabled={busy} onClick={() => setMode("files")}>上传或粘贴文件</button>
        <button role="tab" aria-selected={mode === "text"} className="button secondary" disabled={busy} onClick={() => setMode("text")}>粘贴文字</button>
      </div>
      <label className="source-field">资料标题<input value={title} disabled={busy} maxLength={160} onChange={(e) => {setTitle(e.target.value);dirty();}} /></label>
      {mode === "text" ? <label className="source-field">原文<textarea aria-label="导入原文" rows={14} disabled={busy} value={text} onChange={(e) => {setText(e.target.value);dirty();}} /></label>
        : <div className="source-file-drop" tabIndex={0} aria-label="上传或粘贴来源文件" onPaste={(event) => {
          if (busy) return;
          const images = [...event.clipboardData.files];
          if (images.length) { event.preventDefault(); pasted.current = [...pasted.current,...images];setFiles((current) => [...current,...images]);setError("");dirty(); }
        }}>
          <div className="source-field"><span>选择文件（一次仅支持同一类型）</span><div><button type="button" className="button secondary" disabled={busy} onClick={() => fileInput.current?.click()}>从设备选择文件</button></div></div>
          <input ref={fileInput} className="sr-only" tabIndex={-1} aria-label="选择来源文件" type="file" disabled={busy} multiple accept="image/png,image/jpeg,image/webp,application/pdf,application/epub+zip,text/plain,.txt,.epub,.pdf" onChange={(e) => {const selected = [...e.currentTarget.files];e.currentTarget.value = "";setFiles(selected);if(selected.length)setError("");dirty();}} />
          <p>也可点击此处后粘贴截图。图片可按顺序一次导入多张。</p>
          {files.length > 0 && <ol className="source-file-list">{files.map((file,index) => <li key={`${index}-${file.name}`}>{file.name}<button type="button" className="text-button" disabled={busy} aria-label={`移除 ${file.name}`} onClick={() => setFiles(files.filter((_,i) => i !== index))}>移除</button></li>)}</ol>}
        </div>}
      <button className="button primary" disabled={busy || (mode === "text" ? !text.trim() : !files.length)} onClick={stage}>{busy ? "正在保存原始资料…" : "继续确认类型"}</button>
    </> : <>
      <div className="source-import-confirm"><label className="source-field">资料标题<input required value={title} disabled={structureLocked} maxLength={160} onChange={(e) => {setTitle(e.target.value);dirty();}} /></label>
        <label className="source-field">确认来源类型<select aria-label="确认来源类型" value={type} disabled={structureLocked} onChange={(e) => {setType(e.target.value);setChapters([]);setExclusions([]);if(["photo","screenshot"].includes(e.target.value))setAsBook(false);dirty();}}>
          {(draft.allowedTypes || Object.keys(typeNames)).map((value) => <option key={value} value={value}>{typeNames[value] || value}</option>)}</select></label>
        {!initialBookId && !initialTargetId && !["photo","screenshot"].includes(type) && <label className="source-checkbox"><input type="checkbox" checked={asBook} disabled={structureLocked} onChange={(e) => {setAsBook(e.target.checked);dirty();}} />作为书籍导入</label>}
      </div>
      <p>本地判断为{typeNames[draft.detectedType] || draft.detectedType}。{asBook && type.includes("pdf") ? "分章阶段提取全书原始文字，确认章节后再准备阅读正文。" : "确认后才开始准备正文。"}{["photo","screenshot"].includes(type) ? "本次图片将按顺序组成一篇文章。" : ""}</p>
      {asBook && type.includes("pdf") && <div className="source-chapters">
        <h2>确认章节与正文范围</h2><p>范围使用 PDF 实际页码。可排除封面、目录等内容；待核对边界请对照原页确认。</p>
        {draft.files?.[0] && <a className="text-button" target="_blank" rel="noreferrer" href={`/api/imports/${draft.id}/files/${draft.files[0].id}/raw`}>查看原 PDF</a>}
        <p>{type === "scan_pdf" ? "先对全书进行本地 OCR，再将全部文字交给 AI 提议章节，并标记无关内容。" : "先提取全书文字，再交给 AI 提议章节，并标记无关内容。"}</p>
        {processing && <section aria-label="PDF 分章进度" aria-live="polite" aria-busy={chapterRunning}>
          <p>{type === "scan_pdf" ? "全书本地 OCR" : "全书文字提取"}：{processing.completedPages ?? 0} / {processing.totalPages || "待确定"} 页</p>
          {processing.status === "extracting" && <progress aria-label="全书文字提取页数" value={processing.completedPages || 0} max={Math.max(1,processing.totalPages || 1)} />}
          <p>{({queued:"资源排队中，等待开始提取和分章。",extracting:"正在提取原始文字，完成全书后开始 AI 分章。",proposing:"全书文字已提取，正在由 AI 分章并识别无关内容。",failed:"分章未完成，可重试或手工添加章节。",timeout:"分章执行超时，可重试或手工添加章节。",done:"章节与建议排除的内容已准备，请确认。"})[processing.status]}</p>
          {chapterRunning && <p>可以返回其他页面，全书提取和分章会继续在后台进行。</p>}
        </section>}
        {chapterFailed && !chapters.length && <p>AI 尚未给出可用建议。可重试，或对照原 PDF 手动添加章节后确认。</p>}
        <button type="button" className="button secondary" disabled={structureLocked} onClick={propose}>{chapterRunning ? "正在分章…" : busy ? "正在提议章节…" : chapters.length ? "重新提议章节" : "AI 提议章节"}</button>
        {chapters.map((chapter,index) => <div key={chapter.id || index} className={`source-chapter ${chapter.excluded ? "excluded" : ""}`}>
          <label className="source-checkbox"><input type="checkbox" checked={!chapter.excluded} disabled={structureLocked} onChange={(e) => updateChapter(index,{excluded:!e.target.checked})} />纳入正文</label>
          <input aria-label={`章节 ${index + 1} 标题`} value={chapter.title} disabled={structureLocked} maxLength={160} onChange={(e) => updateChapter(index,{title:e.target.value})} />
          <label>PDF 页 <input aria-label={`章节 ${index + 1} 起始页`} type="number" min="1" value={chapter.startPage} disabled={structureLocked} onChange={(e) => updateChapter(index,{startPage:Number(e.target.value)})} /></label>
          <label>至 <input aria-label={`章节 ${index + 1} 结束页`} type="number" min={chapter.startPage} value={chapter.endPage} disabled={structureLocked} onChange={(e) => updateChapter(index,{endPage:Number(e.target.value)})} /></label>
          <label className="source-checkbox"><input type="checkbox" checked={!chapter.needsReview} disabled={structureLocked} onChange={(e) => updateChapter(index,{needsReview:!e.target.checked})} />已核对章节边界</label>
          {chapter.needsReview && <span className="source-status">边界待核对</span>}
          <div className="source-chapter-actions">
            <button type="button" className="text-button" disabled={structureLocked || index === 0} onClick={() => setChapters(moveChapter(chapters,index,-1))}>上移</button>
            <button type="button" className="text-button" disabled={structureLocked || index === chapters.length - 1} onClick={() => setChapters(moveChapter(chapters,index,1))}>下移</button>
            <button type="button" className="text-button" disabled={structureLocked || index === chapters.length - 1} onClick={() => setChapters(mergeChapter(chapters,index))}>与下一章合并</button>
            <button type="button" className="text-button" disabled={structureLocked || chapter.endPage <= chapter.startPage} onClick={() => {
              const value = window.prompt("从哪个 PDF 实际页开始拆为新章节？", String(Math.floor((chapter.startPage + chapter.endPage + 1) / 2)));
              if (value !== null) setChapters(splitChapter(chapters,index,Number(value)));
            }}>拆分</button>
          </div>
          {draft.files?.[0] && <ChapterPagePreview importId={draft.id} file={draft.files[0]} chapter={chapter}
            nextChapter={chapters[index + 1]} index={index} totalPages={draft.files[0].info?.pageCount || processing?.totalPages || Math.max(...chapters.map((item) => item.endPage))} />}
        </div>)}
        <button type="button" className="text-button" disabled={structureLocked} onClick={() => setChapters([...chapters,{id:crypto.randomUUID(),title:`章节 ${chapters.length + 1}`,startPage:1,endPage:1,excluded:false,needsReview:true}])}>添加章节</button>
        {!!exclusions.length && <section aria-label="建议排除的内容"><h3>建议排除的内容</h3><p>以下全部建议均可修改。取消勾选可将对应内容保留在正文中；原始文件和{type === "scan_pdf" ? "原始 OCR 结果" : "原始文字提取结果"}完整保留。</p>
          {exclusions.map((item,index) => <div key={item.id || `${item.page}:${item.startLine}:${item.endLine}:${index}`} className="source-chapter">
            <label className="source-checkbox"><input type="checkbox" checked={item.excluded !== false} disabled={structureLocked} onChange={(event) => {setExclusions((current) => current.map((entry,i) => i === index ? {...entry,excluded:event.target.checked} : entry));dirty();}} />排除 PDF 第 {item.page} 页，第 {item.startLine}–{item.endLine} 行</label>
            <p>{item.reason}</p>{item.text && <pre className="source-original-text">{item.text}</pre>}
          </div>)}
        </section>}
      </div>}
      <div className="source-actions"><button className="button subtle" disabled={busy} onClick={() => {forgetDraft();setDraft(null);setChapters([]);setExclusions([]);setError("");}}>重新选择</button>
        <button className="button primary" disabled={structureLocked || !title.trim() || (asBook && type.includes("pdf") && !chapters.some((chapter) => !chapter.excluded))} onClick={confirm}>{busy ? "正在创建资料…" : "确认导入"}</button></div>
    </>}
  </section>;
}
