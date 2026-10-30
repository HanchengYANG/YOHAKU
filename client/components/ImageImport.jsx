import { useCallback, useEffect, useRef, useState } from "react";
import { randomUuid } from "../../shared/random-uuid.mjs";
import { imageImportFiles } from "../image-import.mjs";
import api from "../api.mjs";
import uploadImage from "../upload-image.mjs";
import { newerTask, notifyImageTasksChanged, pendingLocalEntries, taskDisplayName, taskImageUrl } from "../image-tasks.mjs";
import Icon from "./Icon.jsx";
import SourceImageSorter from "./SourceImageSorter.jsx";
import "../image-import.css";
import "../image-tasks.css";

const newBook = "__new_book__";
const blankPreview = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='120'%3E%3Crect width='160' height='120' fill='%23efeee8'/%3E%3C/svg%3E";
const turns = (value) => ((value % 4) + 4) % 4;
const fieldsOf = (task) => ({ title: task?.title || "", bookId: (task?.createNewBook || task?.newBookTitle) ? newBook : task?.bookId || "", newBookTitle: task?.newBookTitle || "", targetId: task?.targetId || "" });
const bodyOf = (form) => ({ title: form.title, createNewBook: form.bookId === newBook, bookId: form.bookId === newBook ? null : form.bookId || null, newBookTitle: form.bookId === newBook ? form.newBookTitle : "", targetId: form.targetId || null });
const signature = (form) => JSON.stringify(bodyOf(form));

function ImagePreview({ entry }) {
  const stage = useRef(null);
  const [bounds, setBounds] = useState(null), [size, setSize] = useState(null);
  useEffect(() => {
    const observer = new ResizeObserver(([value]) => setBounds(value.contentRect));
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, []);
  const sideways = turns(entry.quarterTurns || 0) % 2 === 1;
  const scale = bounds && size ? Math.min(bounds.width / (sideways ? size.height : size.width), bounds.height / (sideways ? size.width : size.height)) : null;
  return <span ref={stage} className="image-import-image-stage"><img src={entry.preview || taskImageUrl(entry) || blankPreview} alt="待识别的日语原图"
    onLoad={(event) => setSize({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })}
    style={{ width: scale === null ? "100%" : size.width * scale, height: scale === null ? "100%" : size.height * scale, maxWidth: "none", maxHeight: "none", transform: `translate(-50%, -50%) rotate(${(entry.quarterTurns || 0) * 90}deg)` }} /></span>;
}

export default function ImageImport({ taskId = null, initialTask = null, onTaskCreated, onSubmitted, onCancel, onDirty,
  articles = [], books = [], initialBookId = null, initialTargetId = null }) {
  const initial = initialTask || null;
  const [task, setTask] = useState(initial);
  const [form, setForm] = useState(() => initial ? fieldsOf(initial) : ({ title: "", bookId: initialBookId || articles.find((article) => article.id === initialTargetId)?.bookId || "", targetId: initialTargetId || "", newBookTitle: "" }));
  const [activeId, setActiveId] = useState(null), [busy, setBusy] = useState(false), [loading, setLoading] = useState(!!taskId && !initial);
  const [error, setError] = useState(""), [dragActive, setDragActive] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [, repaint] = useState(0);
  const taskRef = useRef(initial), formRef = useRef(form), loadedId = useRef(initial?.id || null);
  const locals = useRef(new Map()), creationKey = useRef(randomUuid()), mounted = useRef(true);
  const unavailableRef = useRef(false);
  const operations = useRef(Promise.resolve()), pendingCount = useRef(0), controllers = useRef(new Set());
  const fileInput = useRef(null), replacementInput = useRef(null), replacementId = useRef(null), saveTimer = useRef(null);
  formRef.current = form;
  const markUnavailable = useCallback(() => {
    if (!mounted.current) return;
    unavailableRef.current = true;
    clearTimeout(saveTimer.current);
    setUnavailable(true);
    setError(locals.current.size
      ? "这份导入任务已删除或无法访问。本机选过的图片仍保留，可以另建草稿重新上传。"
      : "这份导入任务已删除或无法访问。可以新建导入草稿，重新选择图片。");
    notifyImageTasksChanged();
  }, []);
  const accept = useCallback((value, syncForm = false) => {
    if (!mounted.current) return value;
    const next = newerTask(taskRef.current, value);
    taskRef.current = next; loadedId.current = next.id; setTask(next);
    notifyImageTasksChanged();
    if (syncForm) { formRef.current = fieldsOf(next); setForm(fieldsOf(next)); }
    return next;
  }, []);
  const refresh = useCallback(async () => {
    const id = taskRef.current?.id || taskId;
    if (!id) return null;
    try {
      const value = await api(`/image-tasks/${encodeURIComponent(id)}`);
      return accept(value, !taskRef.current);
    } catch (cause) {
      if (cause.status === 404) markUnavailable();
      throw cause;
    }
  }, [accept, taskId, markUnavailable]);
  const enqueue = useCallback((work) => {
    pendingCount.current++; setBusy(true);
    const run = operations.current.catch(() => {}).then(async () => {
      try { if (!mounted.current || unavailableRef.current) return; await work(); }
      catch (cause) {
        if (!mounted.current || cause.name === "AbortError") return;
        if (cause.code === "TASK_UNAVAILABLE" || cause.status === 410) { markUnavailable(); return; }
        if (unavailableRef.current) return;
        setError(cause instanceof TypeError ? "暂时无法连接服务器。已上传的原图保留在草稿中，请恢复连接后重试。" : cause.message);
        try {
          const latest = await refresh();
          if (!mounted.current) return;
          if (latest && latest.state !== "draft") {
            if (pendingLocalEntries(locals.current.values(), latest).length) setError("其他设备已提交此批次，本机尚未上传的新图片仍保留。请另建导入草稿继续上传。");
            else onSubmitted?.(latest);
          }
        } catch { /* Keep the original error and local files until reconnection. */ }
      } finally { pendingCount.current--; if (mounted.current) { setBusy(pendingCount.current > 0); repaint((n) => n + 1); } }
    });
    operations.current = run;
    return run;
  }, [refresh, onSubmitted, markUnavailable]);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false; clearTimeout(saveTimer.current);
      for (const controller of controllers.current) controller.abort();
      for (const entry of locals.current.values()) URL.revokeObjectURL(entry.preview);
    };
  }, []);
  useEffect(() => {
    if (!taskId || loadedId.current === taskId) return;
    const controller = new AbortController();
    setLoading(true);
    api(`/image-tasks/${encodeURIComponent(taskId)}`, { signal: controller.signal }).then((value) => {
      accept(value, true); if (mounted.current && value.state !== "draft") onSubmitted?.(value);
    }).catch((cause) => { if (cause.name !== "AbortError") { if (cause.status === 404) markUnavailable(); else setError(cause.message); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [taskId, accept, onSubmitted, markUnavailable]);

  const queue = unavailable ? [...locals.current.values()] : [...(task?.items || []).map((item) => ({ ...item, ...locals.current.get(item.id) })),
    ...[...locals.current.values()].filter((entry) => !(task?.items || []).some((item) => item.id === entry.id))];
  const active = queue.find((entry) => entry.id === activeId) || queue[0];
  const uploadedCount = queue.filter((entry) => entry.imageId).length;
  const localUnsent = unavailable ? locals.current.size > 0 : [...locals.current.values()].some((entry) => !(task?.items || []).find((item) => item.id === entry.id)?.imageId);
  const frozen = unavailable || !!task && task.state !== "draft";
  const metadataPending = !!task && !frozen && signature(form) !== signature(fieldsOf(task));
  useEffect(() => { onDirty?.(localUnsent || metadataPending); }, [localUnsent, metadataPending, onDirty]);

  const ensureDraft = async () => {
    if (taskRef.current) return taskRef.current;
    const value = await api("/image-tasks", { method: "POST", body: JSON.stringify({ idempotencyKey: creationKey.current, ...bodyOf(formRef.current) }) });
    accept(value); if (mounted.current) onTaskCreated?.(value);
    return value;
  };
  const saveMetadata = async () => {
    if (unavailableRef.current || !taskRef.current || taskRef.current.state !== "draft" || signature(formRef.current) === signature(fieldsOf(taskRef.current))) return;
    const value = await api(`/image-tasks/${encodeURIComponent(taskRef.current.id)}`, { method: "PATCH", body: JSON.stringify({ version: taskRef.current.version, ...bodyOf(formRef.current) }) });
    accept(value); if (mounted.current) setError("");
  };
  const uploadEntries = async (entries) => {
    if (mounted.current) setError("");
    let current = await ensureDraft();
    if (!mounted.current) return;
    const missing = entries.filter((entry) => !current.items.some((item) => item.id === entry.id));
    if (missing.length) current = accept(await api(`/image-tasks/${encodeURIComponent(current.id)}/items`, {
      method: "POST", body: JSON.stringify({ version: current.version, items: missing.map(({ id, name }) => ({ id, name })) }),
    }));
    for (const entry of entries) {
      if (!mounted.current) return;
      if (taskRef.current.items.find((item) => item.id === entry.id)?.imageId) continue;
      const controller = new AbortController(); controllers.current.add(controller);
      entry.uploading = true; entry.error = ""; entry.percent = 0; repaint((n) => n + 1);
      const body = new FormData(); body.append("image", entry.file, entry.name);
      try {
        const value = await uploadImage(body, { signal: controller.signal, path: `/image-tasks/${encodeURIComponent(current.id)}/items/${encodeURIComponent(entry.id)}/image`, onProgress: (percent) => {
          entry.percent = percent; if (mounted.current) repaint((n) => n + 1);
        } });
        accept(value);
      } catch (cause) {
        entry.error = cause.message;
        if (cause.name !== "AbortError") { try { await refresh(); } catch {} }
        // Other selected files can still upload when a single file fails.
        if (unavailableRef.current || cause.status === 409 || cause.code === "WEBSITE_AUTH_REQUIRED" || cause.code === "TASK_UNAVAILABLE") throw cause;
        if (cause.name !== "AbortError") setError(cause.message);
      } finally { entry.uploading = false; controllers.current.delete(controller); if (mounted.current) repaint((n) => n + 1); }
    }
    await saveMetadata();
  };
  const chooseFiles = (fileList) => {
    if (unavailableRef.current) return;
    if (taskRef.current && taskRef.current.state !== "draft") { setError("此批次已提交。请将本机未上传图片另建草稿，或返回任务查看进度。"); return; }
    let files;
    try { files = imageImportFiles(fileList, queue.length); }
    catch (cause) { setError(cause.message); return; }
    if (!files.length) return;
    const entries = files.map((file) => ({ id: randomUuid(), name: file.name || "粘贴的截图.png", file, preview: URL.createObjectURL(file) }));
    entries.forEach((entry) => locals.current.set(entry.id, entry));
    setActiveId(entries[0].id); setError(""); repaint((n) => n + 1); onDirty?.(true);
    enqueue(() => uploadEntries(entries));
  };
  const chooseFilesRef = useRef(chooseFiles); chooseFilesRef.current = chooseFiles;
  useEffect(() => {
    const paste = (event) => {
      const data = event.clipboardData;
      const files = data?.files?.length ? [...data.files] : [...(data?.items || [])].filter((item) => item.kind === "file").map((item) => item.getAsFile()).filter(Boolean);
      if (files.length) { event.preventDefault(); chooseFilesRef.current(files); }
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, []);
  const field = (changes) => {
    setForm((current) => { const next = { ...current, ...changes }; formRef.current = next; return next; });
    onDirty?.(!!taskRef.current || locals.current.size > 0);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => enqueue(saveMetadata), 600);
  };
  const mutate = (body) => enqueue(async () => {
    setError("");
    const current = await ensureDraft();
    accept(await api(`/image-tasks/${encodeURIComponent(current.id)}`, { method: "PATCH", body: JSON.stringify({ version: current.version, ...body }) }));
  });
  const remove = (id) => {
    if ((taskRef.current?.items || []).some((item) => item.id === id)) enqueue(async () => {
      const current = taskRef.current;
      accept(await api(`/image-tasks/${encodeURIComponent(current.id)}`, { method: "PATCH", body: JSON.stringify({ version: current.version, removeItemIds: [id] }) }));
      const local = locals.current.get(id); if (local) URL.revokeObjectURL(local.preview); locals.current.delete(id);
      repaint((n) => n + 1);
    });
    else { const local = locals.current.get(id); if (local) URL.revokeObjectURL(local.preview); locals.current.delete(id); repaint((n) => n + 1); }
  };
  const submit = () => enqueue(async () => {
    clearTimeout(saveTimer.current); setError("");
    await saveMetadata();
    const current = taskRef.current;
    const value = accept(await api(`/image-tasks/${encodeURIComponent(current.id)}/submit`, { method: "POST", body: JSON.stringify({ version: current.version }) }));
    if (mounted.current) { onDirty?.(false); onSubmitted?.(value); }
  });
  const uploadState = (entry) => entry.imageId ? { status: "已上传", statusKind: "done" }
    : entry.uploading ? { status: entry.percent === 100 ? "正在确认保存" : `正在上传${entry.percent === null ? "" : ` ${entry.percent}%`}`, statusKind: "working" }
      : entry.error ? { status: "上传失败，可重试", statusKind: "error" } : { status: entry.file ? "等待上传" : "需重新选择文件", statusKind: "pending" };
  const missingEntries = queue.filter((entry) => !entry.imageId);
  const retryEntries = pendingLocalEntries(locals.current.values(), task);
  const startAnotherDraft = () => {
    const pending = unavailableRef.current ? [...locals.current.values()] : pendingLocalEntries(locals.current.values(), taskRef.current);
    if (!pending.length && !unavailableRef.current) return;
    clearTimeout(saveTimer.current);
    for (const [id, entry] of locals.current) if (!pending.some((item) => item.id === id)) URL.revokeObjectURL(entry.preview);
    locals.current = new Map(pending.map((entry) => [entry.id, entry]));
    // Ignore the old route while the explicitly requested replacement is being
    // created; onTaskCreated replaces it with the new durable task address.
    taskRef.current = null; loadedId.current = taskId; creationKey.current = randomUuid();
    unavailableRef.current = false; setUnavailable(false);
    setTask(null); setError(""); setActiveId(pending[0]?.id || null); repaint((n) => n + 1);
    enqueue(() => pending.length ? uploadEntries(pending) : ensureDraft());
  };
  const canSubmit = !unavailable && task?.state === "draft" && queue.length > 0 && !missingEntries.length && !busy && !loading && !(form.bookId === newBook && !form.newBookTitle.trim());
  const replaceFile = (file) => {
    const id = replacementId.current;
    if (!file || !id) return;
    try { imageImportFiles([file], 0); } catch (cause) { setError(cause.message); return; }
    const old = locals.current.get(id); if (old) URL.revokeObjectURL(old.preview);
    const item = taskRef.current?.items.find((item) => item.id === id);
    const entry = { id, file, name: item?.name || file.name, preview: URL.createObjectURL(file) };
    locals.current.set(id, entry); repaint((n) => n + 1); enqueue(() => uploadEntries([entry]));
  };

  return <section className="stage2-page image-import-page image-import-batch" aria-label="图片导入" aria-busy={loading}
    onDragOver={(event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragActive(true); } }}
    onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setDragActive(false); }}
    onDrop={(event) => { if ([...event.dataTransfer.types].includes("Files")) { event.preventDefault(); setDragActive(false); chooseFiles(event.dataTransfer.files); } }}>
    <div className="stage2-heading"><div><span className="eyebrow">从原图开始</span><h1>导入照片或截图</h1></div>
      <div className="task-preparation-actions"><button className="button subtle" type="button" onClick={onCancel}>任务与归档</button></div></div>
    <p className="stage2-description">先上传图片，再提交识别任务。草稿会保存到你的账号，可换设备继续上传。</p>
    {task && <p className="task-preparation-name">{taskDisplayName(task)}</p>}
    {loading && <p role="status">正在读取导入草稿…</p>}
    {error && <div className="stage2-error" role="alert">{error}{unavailable
      ? <button className="button primary" type="button" disabled={busy} onClick={startAnotherDraft}>{locals.current.size ? "将本机图片另建草稿" : "新建导入草稿"}</button>
      : <button className="button subtle" type="button" disabled={busy} onClick={() => enqueue(async () => { await refresh(); await saveMetadata(); if (mounted.current) setError(""); })}>重新同步</button>}</div>}
    <div className="image-import-batch-layout">
      <div className="image-import-destination">
        <h2>校对后保存到</h2>
        <label className="book-target">书籍<select aria-label="图片所属书籍" disabled={loading || frozen} value={form.bookId} onChange={(event) => field({ bookId: event.target.value, targetId: "" })}>
          <option value="">独立材料</option>{books.map((book) => <option key={book.id} value={book.id}>{book.title}</option>)}<option value={newBook}>＋ 新建书籍</option></select></label>
        {form.bookId === newBook && <label className="book-target">书籍名称<input aria-label="新书籍名称" value={form.newBookTitle} disabled={loading || frozen} maxLength={160} placeholder="输入书名" onChange={(event) => field({ newBookTitle: event.target.value })} /></label>}
        <label className="book-target">文章<select aria-label="图片所属文章" disabled={loading || frozen} value={form.targetId} onChange={(event) => field({ targetId: event.target.value })}>
          <option value="">新建文章</option>{articles.filter((article) => (article.bookId || "") === form.bookId).map((article) => <option key={article.id} value={article.id}>{article.title}</option>)}</select></label>
        {!form.targetId && <label className="book-target">文章标题<input aria-label="新文章标题" value={form.title} disabled={loading || frozen} maxLength={160} placeholder="留空则使用识别标题" onChange={(event) => field({ title: event.target.value })} /></label>}
        <p className="image-destination-rule">{form.targetId ? "校对保存后追加到原文章末尾" : "按照片顺序合为一篇新文章"}</p>
        <p className="image-destination-copy">识别完成后仍需校对并保存，不会自动改写文章。</p>
        <div className="image-import-submit">
          <button className="button primary" type="button" disabled={!canSubmit} onClick={submit}><Icon name="arrow" size={17} />识别并注音</button>
          {retryEntries.length > 0 && !busy && !frozen && <button className="button subtle" type="button" onClick={() => enqueue(() => uploadEntries(retryEntries))}>重试上传</button>}
          {frozen && !unavailable && retryEntries.length > 0 && <button className="button primary" type="button" disabled={busy} onClick={startAnotherDraft}>将未上传图片另建草稿</button>}
          {frozen && !unavailable && <p className="task-note">此批次已在其他设备提交。本机未上传的新图片会保留，另建草稿后单独处理。</p>}
          {metadataPending && !busy && <button className="button subtle" type="button" onClick={() => enqueue(saveMetadata)}>保存准备信息</button>}
          <p className="image-recognition-state" role="status">{unavailable ? "原任务已不可用，需另建草稿重新上传本机图片。" : busy ? "正在上传或保存准备信息…" : metadataPending ? "准备信息尚未保存，请同步后再离开。" : task ? `已上传 ${uploadedCount} / ${queue.length} 张。草稿已保存，可在其他设备继续。` : "选图后自动上传，全部上传完成后即可提交任务。"}</p>
          {missingEntries.length > 0 && !busy && <p className="task-note">未传完的文件可重新选择或移除，全部处理后才能提交。</p>}
        </div>
      </div>
      <div className="image-import-queue">
        <label className="stage2-field image-file-picker">从设备选择图片<input aria-label="选择日语图片" ref={fileInput} type="file" multiple accept="image/png,image/jpeg,image/webp" disabled={loading || frozen}
          onChange={(event) => { chooseFiles(event.target.files); event.target.value = ""; }} /></label>
        <input className="sr-only" aria-label="重新选择未上传图片" ref={replacementInput} type="file" accept="image/png,image/jpeg,image/webp" onChange={(event) => { replaceFile(event.target.files[0]); event.target.value = ""; }} />
        <p className="image-file-hint" id="image-input-help">可多选、拖入或粘贴；每张 PNG、JPEG 或 WebP 最大 12 MB，最多 100 张。</p>
        {queue.length > 0 && <SourceImageSorter label="照片队列" items={queue.map((entry) => ({ id: entry.id, name: entry.name, src: entry.preview || taskImageUrl(entry) || blankPreview, quarterTurns: entry.quarterTurns, ...uploadState(entry) }))}
          activeId={active?.id} onSelect={setActiveId} onReorder={(ids) => mutate({ itemOrder: ids })} onRemove={remove} summary={`已上传 ${uploadedCount} / ${queue.length}`} disabled={busy || loading || frozen} />}
        {active && <div className="image-file-details" aria-label="当前照片信息"><span className="image-file-position">照片 {queue.findIndex((entry) => entry.id === active.id) + 1} / {queue.length}</span><strong title={active.name}>{active.name}</strong><span className="image-file-status" role="status">{uploadState(active).status}</span>
          {!active.imageId && !busy && !frozen && <button type="button" className="button subtle" onClick={() => { replacementId.current = active.id; replacementInput.current?.click(); }}>重新选择这张图片</button>}</div>}
        {active && <div className="image-import-direction" aria-label="识别前调整图片方向"><div>
          <button type="button" className="button subtle" aria-label="向左旋转90°" disabled={busy || loading || frozen} onClick={() => mutate({ itemDirections: { [active.id]: turns((active.quarterTurns || 0) - 1) } })}>↶ 向左旋转</button>
          <button type="button" className="button subtle" aria-label="向右旋转90°" disabled={busy || loading || frozen} onClick={() => mutate({ itemDirections: { [active.id]: turns((active.quarterTurns || 0) + 1) } })}>↷ 向右旋转</button></div>
          <p role="status">{active.quarterTurns ? `当前方向：顺时针 ${active.quarterTurns * 90}°。` : "当前方向：原始方向。"}提交后保存实际图片方向，再进行识别。</p></div>}
        <div className={`image-import-preview ${dragActive ? "is-dragging" : ""}`}><button className="image-preview-picker" type="button" aria-label="点击选择或更换图片" aria-describedby="image-input-help" disabled={loading || frozen} onClick={() => fileInput.current?.click()}>
          {active ? <><ImagePreview key={active.id} entry={active} /><span className="image-preview-change">继续选择图片</span></> : <span className="image-preview-empty"><Icon name="book" size={32} /><span className="image-preview-message">点击选择多张图片</span><small>也可拖入照片，或粘贴截图</small></span>}</button></div>
      </div>
    </div>
  </section>;
}
