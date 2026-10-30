import { useCallback, useEffect, useRef, useState } from "react";
import { randomUuid } from "../../shared/random-uuid.mjs";
import { changeImageImportDirection, imageImportDraft, imageImportFiles, recognizeImageBatch } from "../image-import.mjs";
import api from "../api.mjs";
import uploadImage from "../upload-image.mjs";
import Icon from "./Icon.jsx";
import ImportProgress from "./ImportProgress.jsx";
import SourceImageSorter from "./SourceImageSorter.jsx";
import "../image-import.css";

const newBook = "__new_book__";
const fileName = (entry, index = 0) => entry.file.name || `粘贴的截图 ${index + 1}`;
const progressSteps = [
  { id: "upload", label: "上传图片", copy: "正在发送原图，上传完成后会自动识别正文。" },
  { id: "rotate", label: "保存方向", copy: "正在保存实际图片方向，完成后再识别正文。" },
  { id: "recognize", label: "识别正文", copy: "正在等待正文识别结果，完成后会自动开始注音。" },
  { id: "annotate", label: "生成注音", copy: "正文已保留，正在等待注音结果，完成后打开校对草稿。" },
];
const processingPhases = progressSteps.map((step) => step.id);

function LocalImagePreview({ entry }) {
  const stage = useRef(null);
  const [bounds, setBounds] = useState(null), [size, setSize] = useState(null);
  useEffect(() => {
    const observer = new ResizeObserver(([value]) => setBounds(value.contentRect));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const sideways = (entry.quarterTurns || 0) % 2 === 1;
  const scale = bounds && size ? Math.min(bounds.width / (sideways ? size.height : size.width), bounds.height / (sideways ? size.width : size.height)) : null;
  return <span ref={stage} className="image-import-image-stage"><img src={entry.preview} alt="待识别的日语原图"
    onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
    style={{ width: scale === null ? "100%" : size.width * scale, height: scale === null ? "100%" : size.height * scale,
      maxWidth: "none", maxHeight: "none", transform: `translate(-50%, -50%) rotate(${(entry.quarterTurns || 0) * 90}deg)` }} /></span>;
}

export default function ImageImport({
  onCancel, onReady, onDirty, articles = [], books = [], initialBookId = null,
  initialTargetId = null, onCreateBook,
}) {
  const [bookId, setBookId] = useState(() => initialBookId || articles.find((article) => article.id === initialTargetId)?.bookId || "");
  const [targetId, setTargetId] = useState(initialTargetId || "");
  const [newBookTitle, setNewBookTitle] = useState("");
  const [title, setTitle] = useState("");
  const [queue, setQueue] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [phase, setPhase] = useState("");
  const [failedPhase, setFailedPhase] = useState("");
  const [failedId, setFailedId] = useState(null);
  const [uploadPercent, setUploadPercent] = useState(null);
  const [progressStartedAt, setProgressStartedAt] = useState(null);
  const [directionProgress, setDirectionProgress] = useState(false);
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const [, updateCache] = useState(0);
  const fileInput = useRef(null);
  const pending = useRef(null);
  const queueRef = useRef([]);
  const cache = useRef(new Map());
  const urls = useRef(new Set());
  const currentStep = useRef({ id: null, index: 0, phase: "" });
  const progressPanel = useRef(null);
  const mounted = useRef(true);
  const active = queue.find((entry) => entry.id === activeId) || queue[0];
  const activeCache = active ? cache.current.get(active.id) : null;
  const progressEntry = queue.find((entry) => entry.id === currentStep.current.id);
  const progressCache = cache.current.get(currentStep.current.id);
  const busy = !!phase;
  const availableArticles = articles.filter((article) => (article.bookId || "") === bookId);

  useEffect(() => {
    if (progressStartedAt !== null) progressPanel.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [progressStartedAt]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
      for (const url of urls.current) URL.revokeObjectURL(url);
      urls.current.clear();
    };
  }, []);

  const chooseFiles = useCallback((fileList) => {
    if (pending.current) { setError("正在处理图片，请完成后再添加图片。"); return false; }
    let files;
    try { files = imageImportFiles(fileList, queueRef.current.length); }
    catch (cause) { setError(cause.message); return false; }
    if (!files.length) return false;
    const added = files.map((file) => {
      const preview = URL.createObjectURL(file); urls.current.add(preview);
      return { id: randomUuid(), file, preview, quarterTurns: 0 };
    });
    const next = [...queueRef.current, ...added];
    queueRef.current = next; setQueue(next); setActiveId(added[0].id);
    setError(""); setFailedPhase(""); setFailedId(null); setProgressStartedAt(null);
    onDirty?.(true);
    return true;
  }, [onDirty]);

  useEffect(() => {
    const paste = (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const files = data.files.length ? Array.from(data.files) : Array.from(data.items)
        .filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); chooseFiles(files); }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [chooseFiles]);

  const removeFile = (id) => {
    if (pending.current) return;
    const entry = queueRef.current.find((item) => item.id === id);
    if (!entry) return;
    URL.revokeObjectURL(entry.preview); urls.current.delete(entry.preview); cache.current.delete(id);
    const next = queueRef.current.filter((item) => item.id !== id);
    queueRef.current = next; setQueue(next);
    if (activeId === id) setActiveId(next[0]?.id || null);
    if (failedId === id) { setError(""); setFailedPhase(""); setFailedId(null); }
    if (!next.length) setProgressStartedAt(null);
    onDirty?.(next.length > 0);
  };
  const reorder = (ids) => {
    if (pending.current) return;
    const entries = new Map(queueRef.current.map((entry) => [entry.id, entry]));
    const next = ids.map((id) => entries.get(id));
    queueRef.current = next; setQueue(next); onDirty?.(true);
  };
  const changeDirection = (delta) => {
    if (pending.current || !active) return;
    const next = queueRef.current.map((entry) => entry.id === active.id ? changeImageImportDirection(entry, delta, cache.current) : entry);
    queueRef.current = next; setQueue(next);
    setError(""); setFailedPhase(""); setFailedId(null); setProgressStartedAt(null);
    onDirty?.(true);
  };
  const dragOver = (event) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault(); event.dataTransfer.dropEffect = pending.current ? "none" : "copy";
    setDragActive(!pending.current);
  };
  const drop = (event) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault(); setDragActive(false); chooseFiles(event.dataTransfer.files);
  };

  const run = async (skipAnnotation = false) => {
    if (!queueRef.current.length || pending.current || (bookId === newBook && !newBookTitle.trim())) return;
    const controller = new AbortController(); pending.current = controller;
    setDirectionProgress(queueRef.current.some((entry) => entry.quarterTurns || cache.current.get(entry.id)?.appliedTurns));
    setError(""); setFailedPhase(""); setFailedId(null); setProgressStartedAt(performance.now());
    try {
      const entries = await recognizeImageBatch([...queueRef.current], {
        cache: cache.current, signal: controller.signal, skipAnnotation,
        upload: (file, options) => {
          const body = new FormData();
          const extension = file.type === "image/jpeg" ? "jpg" : file.type === "image/webp" ? "webp" : "png";
          body.append("image", file, file.name || `粘贴的图片.${extension}`);
          return uploadImage(body, options);
        },
        rotate: (id, direction, options) => api(`/images/${encodeURIComponent(id)}/rotate`, {
          method: "POST", body: JSON.stringify(direction), ...options,
        }),
        recognize: (id, options) => api(`/images/${encodeURIComponent(id)}/recognize`, {
          method: "POST", body: JSON.stringify({ engine: "llm" }), ...options,
        }),
        annotate: (id, content, options) => api(`/images/${encodeURIComponent(id)}/annotate`, {
          method: "POST", body: JSON.stringify({ content, manualReadings: [] }), ...options,
        }),
        onUpdate: (step) => {
          currentStep.current = step;
          if (!mounted.current || controller.signal.aborted) return;
          setActiveId(step.id); setPhase(step.phase); setUploadPercent(step.uploadPercent);
          updateCache((value) => value + 1);
        },
      });
      if (!mounted.current || controller.signal.aborted) return;
      let destinationBookId = bookId || null;
      if (bookId === newBook) {
        currentStep.current = { ...currentStep.current, phase: "destination" }; setPhase("destination");
        const created = await onCreateBook(newBookTitle.trim());
        if (!mounted.current || controller.signal.aborted) return;
        destinationBookId = created.id; setBookId(created.id);
      }
      currentStep.current = { ...currentStep.current, phase: "finish" }; setPhase("finish");
      const draft = imageImportDraft(entries, {
        title, bookId: destinationBookId, targetId,
        annotationError: skipAnnotation && entries.some((entry) => !entry.annotated) ? "部分图片尚未生成注音，可在注音校正中补全。" : "",
      });
      onDirty?.(false);
      await onReady(draft);
    } catch (cause) {
      if (mounted.current && cause.name !== "AbortError") {
        setFailedPhase(currentStep.current.phase); setFailedId(currentStep.current.id);
        onDirty?.(true); updateCache((value) => value + 1);
        setError(cause instanceof TypeError ? "无法连接本机服务，所选图片和已完成的结果已保留，请重试。" : cause.message);
      }
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setPhase("");
    }
  };
  const itemState = (entry) => {
    const value = cache.current.get(entry.id);
    if (failedId === entry.id && error && processingPhases.includes(failedPhase)) return { status: "待重试", statusKind: "error" };
    if (busy && currentStep.current.id === entry.id && processingPhases.includes(phase)) return {
      status: phase === "upload" ? "正在上传" : phase === "rotate" ? "保存方向" : phase === "recognize" ? "识别正文" : "生成注音", statusKind: "working",
    };
    return value?.annotated ? { status: "已完成", statusKind: "done" }
      : value?.recognized ? { status: "正文已保留", statusKind: "retained" }
        : { status: value?.image ? "原图已上传" : "待处理", statusKind: "pending" };
  };
  const completedCount = queue.filter((entry) => cache.current.get(entry.id)?.annotated).length;
  const retryCache = cache.current.get(failedId);
  const buttonLabel = phase === "upload" ? "正在上传原图…"
    : phase === "rotate" ? "正在保存图片方向…"
    : phase === "recognize" ? "正在识别正文（1/2）…"
      : phase === "annotate" ? "正在参考原图注音（2/2）…"
        : phase === "destination" ? "正在创建书籍…" : phase === "finish" ? "正在打开校对…"
          : error && retryCache?.recognized && !retryCache?.annotated ? "重试注音"
            : error && retryCache?.image && !retryCache?.recognized ? "重试识别"
              : error && retryCache?.annotated ? "重试打开校对"
                : queue.length > 1 ? `识别 ${queue.length} 张并校对` : "识别并注音";

  return <section className="stage2-page image-import-page image-import-batch" aria-label="图片导入" aria-busy={busy}
    onDragOver={dragOver} onDrop={drop} onDragLeave={(event) => {
      if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false);
    }}>
    <div className="stage2-heading"><div><span className="eyebrow">从原图开始</span><h1>导入照片或截图</h1></div>
      <button className="button subtle" type="button" disabled={busy} onClick={onCancel}>取消</button></div>
    <p className="stage2-description">先选书籍和文章，再选择多张照片。按图片顺序追加正文，校对时可继续调整图片顺序。</p>
    {error && <div className="stage2-error" role="alert">{error}<p>{failedPhase === "annotate"
      ? "正文已完成并保留，重试会继续未完成的注音与后续图片，不会重新上传或识别已完成的图片。"
      : "所选图片和已完成的步骤均已保留，重试会继续未完成的步骤。"}</p></div>}
    {(phase || failedPhase) && processingPhases.includes(phase || failedPhase) && <div ref={progressPanel}>
      <p className="image-batch-current" role="status">第 {currentStep.current.index + 1} / {queue.length} 张 · {progressEntry ? fileName(progressEntry) : ""}</p>
      <ImportProgress phase={phase || failedPhase} startedAt={progressStartedAt} uploadPercent={uploadPercent} failed={!phase && !!failedPhase}
        steps={directionProgress ? progressSteps : progressSteps.filter((step) => step.id !== "rotate")}
        completedSteps={[
          ...(progressCache?.image ? ["upload"] : []),
          ...(progressCache?.image && (progressCache.appliedTurns || 0) === (progressEntry?.quarterTurns || 0) ? ["rotate"] : []),
          ...(progressCache?.recognized ? ["recognize"] : []), ...(progressCache?.annotated ? ["annotate"] : []),
        ]} />
    </div>}
    <div className="image-import-batch-layout">
      <div className="image-import-destination">
        <h2>识别后保存到</h2>
        <label className="book-target">书籍<select aria-label="图片所属书籍" disabled={busy} value={bookId} onChange={(event) => {
          setBookId(event.target.value); setTargetId(""); if (queue.length) onDirty?.(true);
        }}><option value="">独立材料</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}
          {onCreateBook && <option value={newBook}>＋ 新建书籍</option>}</select></label>
        {bookId === newBook && <label className="book-target">书籍名称<input aria-label="新书籍名称" value={newBookTitle} disabled={busy} maxLength={160} placeholder="输入书名" onChange={(event) => { setNewBookTitle(event.target.value); if (queue.length) onDirty?.(true); }} /></label>}
        <label className="book-target">文章<select aria-label="图片所属文章" disabled={busy} value={targetId} onChange={(event) => { setTargetId(event.target.value); if (queue.length) onDirty?.(true); }}>
          <option value="">新建文章</option>{availableArticles.map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}
        </select></label>
        {!targetId && <label className="book-target">文章标题<input aria-label="新文章标题" disabled={busy} value={title} maxLength={160} placeholder="留空则使用识别标题" onChange={(event) => { setTitle(event.target.value); if (queue.length) onDirty?.(true); }} /></label>}
        <p className="image-destination-rule">{targetId ? "默认追加到原文章末尾" : "按照片顺序合为一篇新文章"}</p>
        <p className="image-destination-copy">每张图片保留对应文字，全文拼接后统一分句。</p>
        <div className="image-import-submit">
          <button className="button primary" type="button" disabled={!queue.length || busy || (bookId === newBook && !newBookTitle.trim())} onClick={() => run()}>
            <Icon name="arrow" size={17} />{buttonLabel}</button>
          {error && failedPhase === "annotate" && !busy && <button type="button" className="button subtle" onClick={() => run(true)}>先校对正文</button>}
          <p className="image-recognition-state" role="status">{busy ? "正在按队列处理图片，完成后打开逐图校对。" : "识别与注音完成后进入校对草稿，不会自动保存为最终原文。"}</p>
        </div>
      </div>
      <div className="image-import-queue">
        <label className="stage2-field image-file-picker">从设备选择图片
          <input aria-label="选择日语图片" ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={busy}
            onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} /></label>
        <p className="image-file-hint" id="image-input-help">可多选、拖入或粘贴；每张 PNG、JPEG 或 WebP 最大 12 MB，最多 100 张。</p>
        {queue.length > 0 && <SourceImageSorter label="照片队列" items={queue.map((entry, index) => ({ id: entry.id, name: fileName(entry, index), src: entry.preview, quarterTurns: entry.quarterTurns, ...itemState(entry) }))}
          activeId={active?.id} onSelect={setActiveId} onReorder={reorder} onRemove={removeFile} summary={`已完成 ${completedCount} / ${queue.length}`} disabled={busy} />}
        {active && <div className="image-file-details" aria-label="当前照片信息">
          <span className="image-file-position">照片 {queue.findIndex((entry) => entry.id === active.id) + 1} / {queue.length}</span>
          <strong title={fileName(active)}>{fileName(active)}</strong>
          <span className="image-file-status" role="status">{itemState(active).status}</span>
          <small className="image-file-meta">{(active.file.size / 1024 / 1024).toFixed(2)} MB{activeCache?.image ? ` · ${activeCache.image.width} × ${activeCache.image.height}` : ""}</small>
        </div>}
        {active && <div className="image-import-direction" aria-label="识别前调整图片方向">
          <div><button type="button" className="button subtle" aria-label="向左旋转90°" disabled={busy} onClick={() => changeDirection(-1)}>↶ 向左旋转</button>
            <button type="button" className="button subtle" aria-label="向右旋转90°" disabled={busy} onClick={() => changeDirection(1)}>↷ 向右旋转</button></div>
          <p role="status">{active.quarterTurns ? `当前方向：顺时针 ${active.quarterTurns * 90}°。` : "当前方向：原始方向。"}开始识别时会先保存图片方向，再提取文字。</p>
        </div>}
        <div className={`image-import-preview ${dragActive ? "is-dragging" : ""}`}>
          <button className="image-preview-picker" type="button" aria-label="点击选择或更换图片" aria-describedby="image-input-help" disabled={busy}
            onClick={() => { if (!pending.current) fileInput.current?.click(); }}>
            {active ? <><LocalImagePreview key={active.id} entry={active} /><span className="image-preview-change">继续选择图片</span></>
              : <span className="image-preview-empty"><Icon name="book" size={32} /><span className="image-preview-message">点击选择多张图片</span><small>也可拖入照片，或粘贴截图</small></span>}
          </button>
        </div>
      </div>
    </div>
  </section>;
}
