import { useEffect, useRef, useState } from "react";
import api, { apiFetch, readApiResult } from "../api.mjs";
import ErrorNotice from "./ErrorNotice.mjs";
import "../photo-import.css";

const TARGET_KEY = "yohaku.photoTarget";
const isImageFile = (file) => /^image\/(?:png|jpeg|webp)$/i.test(file.type) || /\.(?:png|jpe?g|webp)$/i.test(file.name);
const defaultTitle = (date = new Date()) => `${date.getMonth() + 1}月${date.getDate()}日 · 照片`;
const coarsePointer = () => { try { return window.matchMedia("(pointer: coarse)").matches; } catch { return false; } };
function savedTarget(books) {
  let value = null;
  try { value = localStorage.getItem(TARGET_KEY); } catch { /* falls back to a single article */ }
  return value && books.some((book) => book.id === value) ? value : "article";
}

// Phones are mostly used to photograph pages. Every picture is uploaded as soon
// as it is taken, so nothing is lost when the page is left; the server draft is
// edited picture by picture and confirmed with one tap.
export default function PhotoImport({ books = [], initialFiles = null, initialImportId = null, onCancel, onOpenDocument, onCreated, onDirty }) {
  const [draft, setDraft] = useState(null);
  const [pending, setPending] = useState([]);
  const [title, setTitle] = useState("");
  const [type, setType] = useState("photo");
  const [target, setTarget] = useState(() => savedTarget(books));
  const [newBookTitle, setNewBookTitle] = useState("");
  const [active, setActive] = useState(null);
  const [sorting, setSorting] = useState(false);
  const [dragging, setDragging] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [done, setDone] = useState(null);
  const draftRef = useRef(null), typeChosen = useRef(false), queue = useRef(Promise.resolve());
  const localUrls = useRef(new Map()), camera = useRef(null), album = useRef(null), press = useRef(null);
  const [placeholder] = useState(() => defaultTitle());
  const [phone] = useState(coarsePointer);
  const files = draft?.files || [];
  const draftPath = () => `/imports/${encodeURIComponent(draftRef.current.id)}`;
  const accept = (result) => {
    draftRef.current = result; setDraft(result);
    if (!typeChosen.current && result.allowedTypes?.includes(result.suggestedType)) setType(result.suggestedType);
  };
  // Uploads and edits run one at a time, so an edit always sees every finished upload.
  const enqueue = (work) => {
    const run = queue.current.then(work);
    queue.current = run.catch(() => {});
    return run;
  };
  const send = (entry) => enqueue(async () => {
    try {
      const body = new FormData(); body.append("files", entry.file);
      const before = new Set(draftRef.current?.files.map((file) => file.id) || []);
      let result;
      if (draftRef.current) result = await readApiResult(await apiFetch(`/api${draftPath()}/files`, { method: "POST", body }));
      else { body.append("title", placeholder); result = await readApiResult(await apiFetch("/api/imports", { method: "POST", body })); }
      const added = result.files.find((file) => !before.has(file.id));
      if (added) localUrls.current.set(added.id, entry.url); else URL.revokeObjectURL(entry.url);
      accept(result);
      setPending((current) => current.filter((item) => item.key !== entry.key));
    } catch (cause) {
      setPending((current) => current.map((item) => item.key === entry.key ? { ...item, failed: cause } : item));
    }
  });
  const add = (selected) => {
    const images = [...selected].filter(isImageFile);
    if (images.length < selected.length) setError("只能添加 PNG、JPEG 或 WebP 照片。");
    else setError(null);
    const entries = images.map((file) => ({ key: crypto.randomUUID(), file, url: URL.createObjectURL(file), failed: null }));
    setPending((current) => [...current, ...entries]);
    entries.forEach(send);
  };
  const edit = (work) => enqueue(async () => {
    setBusy(true); setError(null);
    try { accept(await work()); return true; }
    catch (cause) { setError(cause); return false; }
    finally { setBusy(false); }
  });
  useEffect(() => {
    if (initialFiles?.length) add(initialFiles);
    else if (initialImportId) void edit(() => api(`/imports/${encodeURIComponent(initialImportId)}`));
    return () => { for (const url of localUrls.current.values()) URL.revokeObjectURL(url); };
  }, []);
  useEffect(() => { onDirty?.(pending.length > 0); }, [pending.length]);

  const fileAt = (id) => files.find((file) => file.id === id);
  // The order shown while a photo is being dragged.
  const shownIds = () => {
    const ids = files.map((file) => file.id);
    if (!dragging) return ids;
    const rest = ids.filter((id) => id !== dragging.id);
    rest.splice(dragging.over, 0, dragging.id);
    return rest;
  };
  const order = (ids) => edit(() => api(`${draftPath()}/files`, { method: "PUT", body: JSON.stringify({ order: ids }) }));
  const move = (id, delta) => {
    const ids = files.map((file) => file.id), from = ids.indexOf(id), to = from + delta;
    if (from < 0 || to < 0 || to >= ids.length) return;
    [ids[from], ids[to]] = [ids[to], ids[from]];
    void order(ids);
  };
  const rotate = (id, turns) => {
    localUrls.current.delete(id);
    void edit(() => api(`${draftPath()}/files/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ turns }) }));
  };
  const remove = async (id) => {
    if (await edit(() => api(`${draftPath()}/files/${encodeURIComponent(id)}`, { method: "DELETE" }))) setActive(null);
  };
  const retry = (entry) => {
    setPending((current) => current.map((item) => item.key === entry.key ? { ...item, failed: null } : item));
    void send(entry);
  };
  const discard = (entry) => {
    URL.revokeObjectURL(entry.url);
    setPending((current) => current.filter((item) => item.key !== entry.key));
  };

  // Long press enters sorting; in sorting mode a thumbnail follows the finger.
  const pressStart = (event, id) => {
    if (sorting) {
      event.currentTarget.setPointerCapture?.(event.pointerId);
      setDragging({ id, over: files.findIndex((file) => file.id === id) });
      return;
    }
    const timer = setTimeout(() => { press.current = null; setSorting(true); navigator.vibrate?.(10); }, 450);
    press.current = { timer, x: event.clientX, y: event.clientY };
  };
  const pressMove = (event) => {
    if (press.current && Math.hypot(event.clientX - press.current.x, event.clientY - press.current.y) > 8) pressEnd();
    if (!dragging) return;
    // The dragged photo itself sits under the pointer once moved; only another
    // photo's place changes the drop position.
    const target = window.document.elementFromPoint(event.clientX, event.clientY)?.closest("[data-photo-id]")?.dataset.photoId;
    if (!target || target === dragging.id) return;
    const index = shownIds().indexOf(target);
    if (index >= 0 && index !== dragging.over) setDragging({ ...dragging, over: index });
  };
  const pressEnd = () => { clearTimeout(press.current?.timer); press.current = null; };
  const dropEnd = () => {
    pressEnd();
    if (!dragging) return;
    const ids = shownIds();
    setDragging(null);
    if (ids.some((id, index) => id !== files[index].id)) void order(ids);
  };

  const finish = async () => {
    await queue.current;
    if (!draftRef.current || pending.length) return;
    setBusy(true); setError(null);
    try {
      let bookId = target === "article" || target === "new" ? undefined : target;
      if (target === "new") bookId = (await api("/books", { method: "POST", body: JSON.stringify({ title: newBookTitle.trim() }) })).id;
      const result = await api(`${draftPath()}/confirm`, { method: "POST", body: JSON.stringify({ type, title: title.trim() || placeholder, bookId }) });
      try { localStorage.setItem(TARGET_KEY, bookId || "article"); } catch { /* the next import starts as a single article */ }
      onDirty?.(false); setDone(result); onCreated?.(result);
    } catch (cause) { setError(cause); }
    finally { setBusy(false); }
  };
  const again = () => {
    draftRef.current = null; typeChosen.current = false;
    setDraft(null); setPending([]); setTitle(""); setType("photo"); setDone(null); setError(null); setActive(null); setSorting(false);
    camera.current?.click();
  };

  const count = files.length + pending.length;
  const canFinish = !busy && files.length > 0 && !pending.length && (target !== "new" || !!newBookTitle.trim());
  const activeFile = active && fileAt(active), activeIndex = activeFile ? files.indexOf(activeFile) : -1;
  const inputs = <>
    <input ref={camera} hidden type="file" accept="image/*" capture="environment" aria-label="拍照"
      onChange={(event) => { const selected = [...event.currentTarget.files]; event.currentTarget.value = ""; add(selected); }} />
    <input ref={album} hidden type="file" accept="image/png,image/jpeg,image/webp" multiple aria-label="从相册选择"
      onChange={(event) => { const selected = [...event.currentTarget.files]; event.currentTarget.value = ""; add(selected); }} />
  </>;

  if (done) return <section className="photo-import photo-done" aria-label="已添加">
    {inputs}
    <h1>已添加，正在识别</h1>
    <div className="photo-done-actions">
      <button type="button" className="button primary" onClick={again}>再拍一篇</button>
      <button type="button" className="button secondary" onClick={() => onOpenDocument(done.firstDocumentId)}>查看进度</button>
    </div>
  </section>;

  return <section className="photo-import" aria-label="拍照添加"
    onPaste={(event) => { const selected = [...event.clipboardData.files]; if (selected.length) { event.preventDefault(); add(selected); } }}
    onDragOver={(event) => event.preventDefault()}
    onDrop={(event) => { event.preventDefault(); add(event.dataTransfer.files); }}>
    {inputs}
    <header className="photo-header">
      <button type="button" className="text-button" onClick={onCancel}>返回</button>
      <input className="photo-title" aria-label="标题" value={title} placeholder={placeholder} maxLength={160}
        onChange={(event) => setTitle(event.target.value)} />
      <button type="button" className="photo-type" aria-label={`来源类型：${type === "photo" ? "照片" : "截图"}，点按切换`}
        onClick={() => { typeChosen.current = true; setType(type === "photo" ? "screenshot" : "photo"); }}>{type === "photo" ? "照片" : "截图"}</button>
    </header>
    <label className="photo-target">放进
      <select aria-label="放进" value={target} onChange={(event) => setTarget(event.target.value)}>
        {books.map((book) => <option key={book.id} value={book.id}>《{book.title}》</option>)}
        <option value="article">单独文章</option>
        <option value="new">新书籍…</option>
      </select>
    </label>
    {target === "new" && <input className="photo-new-book" aria-label="新书籍名称" placeholder="书名" value={newBookTitle} maxLength={160}
      onChange={(event) => setNewBookTitle(event.target.value)} />}
    {error && <ErrorNotice error={error} />}
    {sorting && <div className="photo-sorting" role="status">拖动照片调整顺序
      <button type="button" className="text-button" onClick={() => setSorting(false)}>完成排序</button></div>}
    {count === 0 ? <p className="photo-empty">{phone ? "拍下第一页" : "拖入照片，或点下方添加"}</p> : <ol className={`photo-grid${sorting ? " is-sorting" : ""}`} aria-label="照片顺序">
      {files.map((file, index) => {
        const shown = dragging ? shownIds().indexOf(file.id) : index;
        return <li key={file.id} data-photo-id={file.id} style={{ order: shown }} className={dragging?.id === file.id ? "is-dragging" : undefined}>
          <button type="button" className="photo-thumb" aria-label={`第 ${index + 1} 张照片`} disabled={busy && !sorting}
            onClick={() => { if (!sorting) setActive(file.id); }} onContextMenu={(event) => event.preventDefault()}
            onPointerDown={(event) => pressStart(event, file.id)} onPointerMove={pressMove} onPointerUp={dropEnd} onPointerCancel={() => { pressEnd(); setDragging(null); }}>
            <img src={localUrls.current.get(file.id) || file.previewUrl} alt="" draggable={false} />
            <span className="photo-number" aria-hidden="true">{shown + 1}</span>
          </button>
        </li>;
      })}
      {pending.map((entry, index) => <li key={entry.key} className="is-pending" style={{ order: files.length + index }}>
        <img src={entry.url} alt="" />
        <span className="photo-number" aria-hidden="true">{files.length + index + 1}</span>
        {entry.failed ? <div className="photo-failed">
          <ErrorNotice error={entry.failed} />
          <button type="button" className="text-button" onClick={() => retry(entry)}>重试</button>
          <button type="button" className="text-button" onClick={() => discard(entry)}>移除</button>
        </div> : <span className="photo-uploading" role="status">上传中</span>}
      </li>)}
    </ol>}
    {activeFile && <div className="photo-sheet-backdrop" onClick={() => setActive(null)}>
      <div className="photo-sheet" role="dialog" aria-label={`第 ${activeIndex + 1} 张照片`} onClick={(event) => event.stopPropagation()}>
        <img src={localUrls.current.get(activeFile.id) || activeFile.previewUrl} alt={`第 ${activeIndex + 1} 张照片`} />
        <div className="photo-sheet-actions">
          <button type="button" className="button subtle" disabled={busy} onClick={() => rotate(activeFile.id, -1)}>向左转</button>
          <button type="button" className="button subtle" disabled={busy} onClick={() => rotate(activeFile.id, 1)}>向右转</button>
          <button type="button" className="button subtle" disabled={busy || activeIndex === 0} onClick={() => move(activeFile.id, -1)}>前移</button>
          <button type="button" className="button subtle" disabled={busy || activeIndex === files.length - 1} onClick={() => move(activeFile.id, 1)}>后移</button>
          <button type="button" className="button subtle photo-delete" disabled={busy || files.length + pending.length <= 1} onClick={() => remove(activeFile.id)}>删除</button>
          <button type="button" className="button secondary" onClick={() => setActive(null)}>关闭</button>
        </div>
      </div>
    </div>}
    <footer className="photo-bar">
      <div className="photo-bar-row">
        {phone && <button type="button" className="button secondary" onClick={() => camera.current?.click()}>📷 拍下一页</button>}
        <button type="button" className="button secondary" onClick={() => album.current?.click()}>{phone ? "相册" : "添加照片"}</button>
      </div>
      <button type="button" className="button primary photo-finish" disabled={!canFinish} onClick={finish}>
        {busy && !active ? "正在添加…" : `完成 · ${count} 张`}
      </button>
    </footer>
  </section>;
}
