import { useCallback, useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { imageTasksChangedEvent, notifyImageTasksChanged, newerTask, taskCounts, taskDisplayName, taskDuration, taskImageUrl, taskItemState, taskSegmentationState, taskStateLabel } from "../image-tasks.mjs";
import Icon from "./Icon.jsx";
import "../image-tasks.css";

function useTaskPolling(path, interval = 2000) {
  const [data, setData] = useState(null), [error, setError] = useState(""), [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let stopped = false, timer, controller, sequence = 0;
    setData(null); setLoading(true); setError("");
    const read = async () => {
      clearTimeout(timer);
      if (stopped || document.visibilityState === "hidden") return;
      const current = ++sequence;
      controller?.abort(); controller = new AbortController();
      try {
        const result = await api(path, { signal: controller.signal });
        if (!stopped && current === sequence) { setData((previous) => result.id ? newerTask(previous, result) : result); setError(""); }
      } catch (cause) { if (!stopped && current === sequence && cause.name !== "AbortError") { setError(cause.message); if (cause.status === 404) setData(null); } }
      finally { if (!stopped && current === sequence) { setLoading(false); timer = setTimeout(read, interval); } }
    };
    const visible = () => {
      if (document.visibilityState === "hidden") { sequence++; clearTimeout(timer); controller?.abort(); }
      else read();
    };
    read(); document.addEventListener("visibilitychange", visible); window.addEventListener("online", read); window.addEventListener(imageTasksChangedEvent, read);
    return () => { stopped = true; clearTimeout(timer); controller?.abort(); document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", read); window.removeEventListener(imageTasksChangedEvent, read); };
  }, [path, interval, revision]);
  return { data, setData, error, setError, loading, reload };
}

function dateLabel(value) {
  return value ? new Date(value).toLocaleString(undefined, { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";
}

export function TaskList({ onOpen, onNew, onDocumentOpen }) {
  const [offset, setOffset] = useState(0), [scope, setScope] = useState("active");
  const { data, error, loading, reload } = useTaskPolling(`/image-tasks?scope=${scope}&limit=20&offset=${offset}`, 5000);
  const tasks = data?.tasks || [];
  useEffect(() => { if (data && offset > 0 && offset >= data.total) setOffset(Math.max(0, Math.ceil(data.total / 20) * 20 - 20)); }, [data, offset]);
  return <section className="stage2-page image-tasks-page" aria-label="图片任务">
    <div className="stage2-heading"><div><span className="eyebrow">随时接着读</span><h1>图片任务</h1></div><button className="button primary" type="button" onClick={onNew}><Icon name="plus" size={16} />导入图片</button></div>
    <p className="stage2-description">上传草稿与识别任务保存在你的账号中。可换设备继续上传、查看进度或校对结果。</p>
    <div className="task-tabs" role="tablist" aria-label="任务分类">{[["active", "当前任务"], ["archived", "已归档"]].map(([value, label]) => <button className="button subtle" role="tab" type="button" key={value} aria-selected={scope === value} onClick={() => { setScope(value); setOffset(0); }}>{label}</button>)}</div>
    {error && <div className="stage2-error" role="status">暂时无法同步任务：{error}<button className="button subtle" type="button" onClick={reload}>重新同步</button></div>}
    {loading && !data && <p role="status">正在读取任务…</p>}
    {!loading && !tasks.length && !error && <div className="task-empty"><Icon name="book" size={32} /><h2>{scope === "archived" ? "还没有归档任务" : "没有待处理的图片任务"}</h2><p>{scope === "archived" ? "校对并保存到文章后，任务会自动归档。" : "先上传照片，再提交识别；上传到一半也可以换设备继续。"}</p>{scope === "active" && <button className="button primary" onClick={onNew}>上传第一张图片</button>}</div>}
    <div className="task-list">
      {tasks.map((task) => { const counts = taskCounts(task), segmentation = taskSegmentationState(task); return <article className="task-card" key={task.id} data-task-id={task.id}>
        <div className="task-card-main"><span className={`task-state is-${task.appliedDocumentId ? "saved" : task.state}`}>{taskStateLabel(task)}</span><h2><button className="task-title-button" type="button" onClick={() => onOpen(task.id)}>{taskDisplayName(task)}</button></h2>
          <p>{task.state === "draft" ? `已上传 ${counts.uploaded} / ${counts.total} 张` : `共 ${counts.total} 张 · 识别与注音完成 ${counts.completed} 张${counts.failed ? ` · ${counts.failed} 张待处理` : ""}`}</p>
          {segmentation && <p data-task-phase="segment" data-status-kind={segmentation.statusKind}>{segmentation.status}</p>}
          <small>{dateLabel(task.submittedAt || task.createdAt)}{task.state !== "draft" && taskDuration(task) ? ` · 用时 ${taskDuration(task)}` : ""}</small></div>
        <button className="button subtle" type="button" onClick={() => task.appliedDocumentId ? onDocumentOpen?.(task.appliedDocumentId) : onOpen(task.id)}>{task.appliedDocumentId ? "打开文章" : task.state === "draft" ? "继续上传" : task.state === "ready" ? "查看结果" : "查看任务"}<Icon name="arrow" size={16} /></button>
      </article>; })}
    </div>
    {(data?.total > 20 || offset > 0) && <nav className="task-pagination" aria-label="任务分页"><button className="button subtle" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 20))}>上一页</button><span>第 {Math.floor(offset / 20) + 1} 页 · 共 {data?.total ?? "…"} 个任务</span><button className="button subtle" disabled={!data || offset + 20 >= data.total} onClick={() => setOffset(offset + 20)}>下一页</button></nav>}
  </section>;
}

export function TaskDetail({ taskId, onOpenDraft, onReady, onBack, onDocumentOpen }) {
  const { data: task, setData, error, setError, loading, reload } = useTaskPolling(`/image-tasks/${encodeURIComponent(taskId)}`);
  const [busy, setBusy] = useState(false), [actionError, setActionError] = useState("");
  const notifiedDraft = useRef(null), actionPending = useRef(false), mounted = useRef(true), currentTaskId = useRef(taskId);
  currentTaskId.current = taskId;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (task?.state === "draft" && notifiedDraft.current !== task.id) { notifiedDraft.current = task.id; onOpenDraft?.(task); }
  }, [task, onOpenDraft]);
  const action = async (work) => {
    if (actionPending.current) return;
    actionPending.current = true; setBusy(true); setActionError("");
    try { await work(); }
    catch (cause) { if (mounted.current) { setActionError(cause.message); if (cause.status === 409) reload(); } }
    finally { actionPending.current = false; if (mounted.current) setBusy(false); }
  };
  const updateTask = (value) => {
    if (mounted.current && currentTaskId.current === taskId) { setData((current) => newerTask(current, value)); setError(""); }
    return value;
  };
  const readLatest = async () => updateTask(await api(`/image-tasks/${encodeURIComponent(taskId)}`));
  const post = async (operation, body = {}, initial = task) => {
    let current = initial;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!mounted.current || currentTaskId.current !== taskId) throw new DOMException("页面已切换。", "AbortError");
      if (current.appliedDocumentId) return updateTask(current);
      if (["resume", "retry"].includes(operation) && ["queued", "running", "ready"].includes(current.state)) return updateTask(current);
      if (operation === "cancel" && body.freezeResult && current.resultVersion) return updateTask(current);
      try {
        const value = updateTask(await api(`/image-tasks/${encodeURIComponent(taskId)}/${operation}`, { method: "POST", body: JSON.stringify({ version: current.version, ...body }) }));
        notifyImageTasksChanged();
        return value;
      } catch (cause) {
        // Keep the requested action when another device or a checkpoint moves
        // the version. The server still validates the latest state each time.
        if (cause.status !== 409 || attempt === 2) throw cause;
        current = await readLatest();
      }
    }
  };
  const deleteTask = () => {
    if (!task?.canDelete) return;
    if (!window.confirm(`删除任务「${taskDisplayName(task)}」？未保存的识别结果和导入草稿将删除，已保存文章不受影响。`)) return;
    return action(async () => {
      try {
        await api(`/image-tasks/${encodeURIComponent(taskId)}`, { method: "DELETE", body: JSON.stringify({ version: task.version }) });
      } catch (cause) {
        if (cause.status !== 404) {
          if (cause.status === 409) await readLatest();
          throw cause;
        }
      }
      notifyImageTasksChanged();
      if (mounted.current && currentTaskId.current === taskId) onBack?.();
    });
  };
  const openResult = () => action(async () => {
    let current = await readLatest();
    if (["queued", "running"].includes(current.state)) throw new Error("任务仍在处理，请等待完成或出错后再进行人工校对或注音。");
    if (!current.appliedDocumentId && current.state !== "ready" && !current.resultVersion) current = await post("cancel", { freezeResult: true }, current);
    if (current.appliedDocumentId) { if (mounted.current && currentTaskId.current === taskId) onDocumentOpen?.(current.appliedDocumentId); return; }
    const draft = await api(`/image-tasks/${encodeURIComponent(taskId)}/result`);
    current = await readLatest();
    if (mounted.current && currentTaskId.current === taskId) {
      if (current.appliedDocumentId) onDocumentOpen?.(current.appliedDocumentId);
      else {
        if (["queued", "running"].includes(current.state) || current.resultVersion !== draft.taskResultVersion)
          throw new Error("其他设备已继续处理此任务，请等待任务完成或出错后重新打开校对。");
        await onReady?.(draft);
      }
    }
  });
  const counts = taskCounts(task);
  const items = task?.items || [];
  const hasText = items.some((item) => item.hasRecognition || item.recognized || item.recognition);
  const isRunning = ["queued", "running"].includes(task?.state);
  const canRetry = task?.state === "needs_attention" && !task.appliedDocumentId;
  const canResume = ["paused", "cancelled", "blocked"].includes(task?.state) && !task.appliedDocumentId;
  const canEdit = task?.canReview && counts.uploaded > 0;
  const currentItem = items.find((item) => item.status === "running");
  const segmentation = taskSegmentationState(task);
  const isSegmenting = task?.phase === "segment";
  return <section className="stage2-page image-tasks-page task-detail-page" aria-label="任务状态" aria-busy={busy}>
    <div className="stage2-heading"><div><span className="eyebrow">图片识别任务</span><h1>{task ? taskDisplayName(task) : "正在读取任务…"}</h1></div><button className="button subtle" type="button" onClick={onBack}><Icon name="back" size={16} />任务列表</button></div>
    {loading && !task && <p role="status">正在读取任务状态…</p>}
    {error && <div className="stage2-error" role="status">无法读取任务：{error}<button className="button subtle" type="button" onClick={reload}>重新同步</button></div>}
    {actionError && <div className="stage2-error" role="alert">{actionError}</div>}
    {task && <>
      <div className="task-status-panel"><span className={`task-state is-${task.appliedDocumentId ? "saved" : task.state}`}>{taskStateLabel(task)}</span><p className="task-status-copy" role="status">{task.appliedDocumentId ? "结果已保存，任务已自动归档。可打开文章继续阅读或校对。" : task.state === "ready" ? "识别、注音与整批分句均已完成，结果已保存为待校对草稿。校对并保存到文章后，任务会自动归档。" : task.state === "blocked" ? task.blockedReason || task.lastError || "等待网站 AI 恢复授权后继续处理。" : task.state === "needs_attention" ? isSegmenting ? "整批分句未完成，识别与注音结果已保留。可重试分句、人工处理或删除任务。" : "任务出错，已上传图片与成功结果已保留。可重试未完成步骤、人工处理或删除任务。" : ["paused", "cancelled"].includes(task.state) ? "此前暂停的任务保留了原图及已完成结果，可继续处理或人工校对。" : isSegmenting ? "图片识别与注音已完成，正在对整批正文分句。任务完成后才能开始校对，可以离开此页面等待。" : "任务已提交，可以离开此页面。锁屏、刷新或换设备不会取消任务。"}</p>
        <div className="task-statistics"><span>图片 <strong>{counts.total}</strong> 张</span><span>已注音 <strong>{counts.completed}</strong> 张</span>{counts.failed > 0 && <span>待处理 <strong>{counts.failed}</strong> 张</span>}<span>用时 <strong>{taskDuration(task)}</strong></span></div>
        {currentItem && <p className="task-current" role="status">当前：{currentItem.name || `照片 ${items.indexOf(currentItem) + 1}`} · {taskItemState(currentItem).status}</p>}
        {segmentation && <p className="task-current" role="status" data-task-phase="segment" data-status-kind={segmentation.statusKind}>{segmentation.status}</p>}
        {isSegmenting && task.segmentation?.error && <p className="task-item-error">{task.segmentation.error}</p>}
        <div className="task-actions">
          {task.appliedDocumentId && <button className="button primary" type="button" onClick={() => onDocumentOpen?.(task.appliedDocumentId)}>打开文章<Icon name="arrow" size={16} /></button>}
          {canResume && <button className="button primary" type="button" disabled={busy} onClick={() => action(() => post("resume"))}>继续处理</button>}
          {canRetry && <button className="button primary" type="button" disabled={busy} onClick={() => action(() => post("retry"))}>{isSegmenting ? "重试分句" : "重试失败步骤"}</button>}
          {canEdit && <button className={`button ${task.state === "ready" ? "primary" : "subtle"}`} type="button" disabled={busy} onClick={openResult}>{task.state === "ready" ? "开始校对" : isSegmenting ? "人工校对正文" : hasText ? "先校对正文／手动注音" : "手动录入正文"}<Icon name="edit" size={16} /></button>}
          {task.canDelete && <button className="button subtle task-delete" type="button" disabled={busy} onClick={deleteTask}>删除任务</button>}
        </div>
        {isRunning && !task.appliedDocumentId && <p className="task-note">处理期间请等待后台完成；出错暂停后可重试、人工处理或删除任务。</p>}
        {canResume && task.resultVersion && <p className="task-note">继续处理将重新开放后台执行；其他设备尚未保存的校对稿需重新读取结果。</p>}
        {task.state === "needs_attention" && <p className="task-note">{isSegmenting ? "重试只执行整批分句，不会重新识别图片或生成注音。" : "无需反复重试。识别失败可对照原图手动录入，注音失败可手动补充，也可先保存无注音正文。"}</p>}
        {task.submittedAt && <p className="task-timestamp">提交于 {dateLabel(task.submittedAt)}{task.startedAt ? ` · 开始于 ${dateLabel(task.startedAt)}` : ""}</p>}
      </div>
      <ol className="task-item-list" aria-label="逐图处理状态">{items.map((item, index) => { const status = taskItemState(item); return <li key={item.id} data-task-item-id={item.id} data-status-kind={status.statusKind}>
        {item.imageId && <img src={taskImageUrl(item)} alt={`照片 ${index + 1} 原图`} loading="lazy" />}
        <div><span className="task-item-number">照片 {index + 1}</span><h2>{item.name || `来源图 ${index + 1}`}</h2><p className="task-item-status" role="status">{status.status}</p>{item.error && <p className="task-item-error">{typeof item.error === "string" ? item.error : item.error.message || "此步骤未完成，可重试或手动处理。"}</p>}</div>
      </li>; })}</ol>
    </>}
  </section>;
}
