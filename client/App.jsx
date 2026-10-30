import { useEffect, useRef, useState } from "react";
import api from "./api.mjs";
import { blocksToHtml, hasCompleteSentenceBoundaries, htmlToBlocks, appendImageBodyHtml } from "../shared/article-html.mjs";
import { parseText, serializeBlocks } from "../shared/document.mjs";
import { kinds } from "./constants.mjs";
import Icon from "./components/Icon.jsx";
import Welcome from "./components/Welcome.jsx";
import Reader from "./components/Reader.jsx";
import ReadingPreparation from "./components/ReadingPreparation.jsx";
import Editor from "./components/Editor.jsx";
import AISettings from "./components/AISettings.jsx";
import ImageImport from "./components/ImageImport.jsx";
import { TaskList, TaskDetail } from "./components/ImageTasks.jsx";
import { imageTasksChangedEvent, notifyImageTasksChanged } from "./image-tasks.mjs";
import DocumentChat from "./components/DocumentChat.jsx";
import AccountGate from "./components/AccountGate.jsx";
import UserMenu from "./components/UserMenu.jsx";
import BookView from "./components/BookView.jsx";
import BookNavigation from "./components/BookNavigation.jsx";
import PWAManager from "./PWAManager.jsx";

export default function App() {
  const [session, setSession] = useState(null);
  const [sessionError, setSessionError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    api("/session", { signal: controller.signal })
      .then(setSession)
      .catch((cause) => {
        if (cause.name !== "AbortError") setSessionError(cause.message);
      });
    const expired = () => setSession({ user: null, needsSetup: false });
    window.addEventListener("yohaku:session-expired", expired);
    return () => {
      controller.abort();
      window.removeEventListener("yohaku:session-expired", expired);
    };
  }, []);
  let content;
  if (sessionError)
    content = (
      <div className="loading-page">
        <p>{sessionError}</p>
        <button
          className="button secondary"
          onClick={() => window.location.reload()}
        >
          重新连接
        </button>
      </div>
    );
  else if (!session) content = <div className="loading-page">正在读取登录状态…</div>;
  else if (!session.user)
    content = (
      <AccountGate
        session={session}
        onAuthenticated={(user, loginSession) => setSession({ user, needsSetup: false, loginSession })}
      />
    );
  else content = (
    <Workspace
      key={session.user.id}
      user={session.user}
      onLoggedOut={() => {
        history.replaceState(null, "", window.location.pathname);
        setSession({ user: null, needsSetup: false });
      }}
    />
  );
  return <><PWAManager session={session} />{content}</>;
}

function BookCreate({ initialTitle, promoting, busy, onSave, onCancel, onDirty }) {
  const [title, setTitle] = useState(initialTitle);
  return (
    <form className="book-create editor-page" onSubmit={(event) => {
      event.preventDefault();
      if (!busy && title.trim()) onSave(title.trim());
    }}>
      <h1>{promoting ? "将材料转为书籍" : "新建书籍"}</h1>
      <p>{promoting
        ? "当前材料将成为第1篇文章，正文、原图、注音和讨论都保留。以后可追加文章。"
        : "为这本书起个名字，再逐篇导入图片或文字。每篇文章独立保存原图、正文和读音。"}</p>
      <label className="book-target">
        书籍名称
        <input aria-label="书籍名称" value={title} maxLength={160} required autoFocus disabled={busy}
          onChange={(event) => { setTitle(event.target.value); onDirty(true); }} />
      </label>
      <div className="book-create-actions">
        <button className="button subtle" type="button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="button primary" type="submit" disabled={busy || !title.trim()}>
          {busy ? "正在创建…" : "创建书籍"}
        </button>
      </div>
    </form>
  );
}

function Workspace({ user, onLoggedOut }) {
  const [documents, setDocuments] = useState([]);
  const [articleTargets, setArticleTargets] = useState([]);
  const [libraryDocuments, setLibraryDocuments] = useState([]);
  const [books, setBooks] = useState([]);
  const [shelfBooks, setShelfBooks] = useState([]);
  const [activeId, setActiveId] = useState(() => window.location.hash.slice(1));
  const [document, setDocument] = useState(null);
  const [book, setBook] = useState(null);
  const [importBookId, setImportBookId] = useState(null);
  const [importSession, setImportSession] = useState(0);
  const [importTask, setImportTask] = useState(null);
  const [chatRequest, setChatRequest] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(null);
  const [appendTargetId, setAppendTargetId] = useState(null);
  const [segmentation, setSegmentation] = useState({ id: null, request: 0, busy: false, error: "" });
  const [promotion, setPromotion] = useState(null);
  const [bookBusy, setBookBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailFailed, setDetailFailed] = useState(false);
  const [shelfError, setShelfError] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [refresh, setRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [draft, setDraft] = useState(null);
  const [editorSession, setEditorSession] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFailure, setSaveFailure] = useState(null);
  const [notice, setNotice] = useState("");
  const [taskCounts, setTaskCounts] = useState({});
  const [activeTaskCount, setActiveTaskCount] = useState(0);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [showRuby, setShowRuby] = useState(true);
  const [fontSize, setFontSize] = useState(26);
  const [panel, setPanel] = useState(() =>
    user.isAdmin && new URLSearchParams(window.location.search).get("chatgpt") === "connected"
      ? "settings"
      : null,
  );
  const savedDetail = useRef(null);
  const editRequest = useRef(0);
  const importRequest = useRef(0);
  const segmentationRequest = useRef(0);
  const pendingSegmentations = useRef(new Map());
  const automaticSegmentationAttempt = useRef(null);
  const currentView = useRef(null);
  const currentReadingDocument = document?.id === activeId ? document : null;
  const readingReady = !!currentReadingDocument && hasCompleteSentenceBoundaries(currentReadingDocument.bodyHtml || blocksToHtml(currentReadingDocument.blocks));
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; importRequest.current++; editRequest.current++; };
  }, []);
  currentView.current = {activeId, panel, editorSession};

  useEffect(() => {
    let stopped = false, timer, controller, sequence = 0;
    const poll = async () => {
      clearTimeout(timer);
      if (stopped || window.document.visibilityState === "hidden") return;
      const current = ++sequence;
      controller?.abort(); controller = new AbortController();
      try {
        const result = await api("/image-tasks?scope=active&limit=1", { signal:controller.signal });
        if (!stopped && current === sequence) { setTaskCounts(result.counts || {}); setActiveTaskCount(result.activeCount || 0); }
      } catch { /* Task views display connection errors without interrupting reading. */ }
      finally { if (!stopped && current === sequence) timer = setTimeout(poll, 5000); }
    };
    const visible = () => {
      if (window.document.visibilityState === "hidden") { sequence++; clearTimeout(timer); controller?.abort(); }
      else void poll();
    };
    void poll(); window.document.addEventListener("visibilitychange", visible); window.addEventListener("online", poll); window.addEventListener(imageTasksChangedEvent, poll);
    return () => { stopped = true; clearTimeout(timer); controller?.abort();
      window.document.removeEventListener("visibilitychange", visible); window.removeEventListener("online", poll); window.removeEventListener(imageTasksChangedEvent, poll); };
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        Promise.all([
          api(`/documents?q=${encodeURIComponent(query)}`, { signal: controller.signal }),
          api(`/books?q=${encodeURIComponent(query)}`, { signal: controller.signal }),
          query ? api("/books", { signal: controller.signal }) : null,
          query ? api("/documents", { signal: controller.signal }) : null,
          api("/documents?all=1", {signal:controller.signal}),
        ])
          .then(([data, shelf, all, allDocuments, targets]) => {
            setArticleTargets(targets.documents);
            setDocuments(data.documents);
            setLibraryDocuments(allDocuments?.documents || data.documents);
            setShelfBooks(shelf.books);
            setBooks(all?.books || shelf.books);
            setShelfError("");
          })
          .catch((e) => {
            if (e.name !== "AbortError") setShelfError(e.message);
          })
          .finally(() => {
            if (!controller.signal.aborted) setLoading(false);
          });
      },
      query ? 180 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, refresh]);

  useEffect(() => {
    if (!activeId || activeId === "tasks" || activeId.startsWith("tasks/")) {
      setDocument(null);
      setBook(null);
      setDetailLoading(false);
      setDetailFailed(false);
      return;
    }
    // Saving already returned the complete document. Show it immediately
    // instead of clearing it and fetching the identical record again.
    if (savedDetail.current === activeId) {
      savedDetail.current = null;
      setDetailLoading(false);
      setDetailFailed(false);
      return;
    }
    const controller = new AbortController();
    setDocument(null);
    setBook(null);
    setDetailLoading(true);
    setDetailFailed(false);
    const isBook = activeId.startsWith("book/");
    api(isBook
      ? `/books/${encodeURIComponent(activeId.slice(5))}`
      : `/documents/${encodeURIComponent(activeId)}`, { signal: controller.signal })
      .then(async (result) => {
        if (isBook) setBook(result);
        else {
          if (controller.signal.aborted) return;
          setDocument(result);
          const parent = result.bookId
            ? await api(`/books/${encodeURIComponent(result.bookId)}`, { signal: controller.signal })
            : null;
          if (controller.signal.aborted) return;
          setBook(parent);
        }
      })
      .catch((e) => {
        if (e.name !== "AbortError") {
          setError(e.message);
          setDetailFailed(true);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setDetailLoading(false);
      });
    return () => controller.abort();
  }, [activeId, detailRefresh]);

  useEffect(() => {
    const guard = (e) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [dirty]);

  useEffect(() => {
    const changed = () => {
      const nextId = window.location.hash.slice(1);
      if (nextId === activeId) return;
      if (saving || bookBusy) {
        history.replaceState(
          null,
          "",
          activeId ? `#${activeId}` : window.location.pathname,
        );
        return;
      }
      if (dirty && !window.confirm("当前修改还没有保存，确定离开吗？")) {
        history.replaceState(
          null,
          "",
          activeId ? `#${activeId}` : window.location.pathname,
        );
        return;
      }
      setDraft(null);
      setPanel(null);
      setDirty(false);
      setError("");
      setActiveId(nextId);
    };
    window.addEventListener("hashchange", changed);
    return () => window.removeEventListener("hashchange", changed);
  }, [activeId, dirty, saving, bookBusy]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    if (!document || activeId !== document.id || draft || saving || (panel && panel !== "chat")) return;
    const html = document.bodyHtml || blocksToHtml(document.blocks);
    if (hasCompleteSentenceBoundaries(html)) return;
    const attempt = `${document.id}:${document.revision}:${detailRefresh}`;
    if (automaticSegmentationAttempt.current === attempt) return;
    automaticSegmentationAttempt.current = attempt;
    void segmentDocument(document, false);
  }, [document, activeId, draft, panel, saving, detailRefresh]);

  const mayLeave = () =>
    !saving && !bookBusy && (!dirty || window.confirm("当前修改还没有保存，确定离开吗？"));
  const openDocument = (id) => {
    if (!mayLeave()) return;
    setDraft(null);
    setPanel(null);
    setDirty(false);
    setError("");
    setSidebarOpen(false);
    setActiveId(id);
    history.replaceState(null, "", `#${id}`);
    setDetailRefresh((n) => n + 1);
  };
  const beginNew = (value) => {
    if (!mayLeave()) return;
    setError("");
    setPanel(null);
    setSidebarOpen(false);
    setDraft(
      value || {
        title: "",
        kind: "lyrics",
        orientation: "horizontal",
        content: "",
      },
    );
    setEditorSession((n) => n + 1);
    setDirty(!!value);
  };
  const beginEdit = async () => {
    if (!mayLeave()) return;
    const id = document.id;
    const request = ++editRequest.current;
    const view = currentView.current;
    const isCurrent = () => request === editRequest.current && currentView.current.activeId === view.activeId && currentView.current.panel === view.panel && currentView.current.editorSession === view.editorSession;
    setError("");
    try {
      const attempt = `${document.id}:${document.revision}:${detailRefresh}`;
      if (!hasCompleteSentenceBoundaries(document.bodyHtml || blocksToHtml(document.blocks)) && automaticSegmentationAttempt.current !== attempt) {
        await segmentDocument(document, false);
      } else {
        // Initialization persists a new revision. Wait before opening a draft,
        // but keep editing available when automatic initialization failed.
        await pendingSegmentations.current.get(id)?.catch(() => {});
      }
      if (!isCurrent()) return;
      // A submitted question can already have attached marks while its answer
      // is still being generated. Start the draft from that saved revision.
      const latest = await api(`/documents/${encodeURIComponent(id)}`);
      if (!isCurrent()) return;
      setPanel(null); setDocument(latest); setDraft({...latest});
      setEditorSession((n) => n + 1); setDirty(false);
    } catch (cause) { if (isCurrent()) setError(cause.message); }
  };
  const cancelEdit = () => {
    if (mayLeave()) {
      setDraft(null);
      setDirty(false);
      setError("");
    }
  };
  const openPanel = (name) => {
    if (name === "settings" && !user.isAdmin) return;
    if (!mayLeave()) return;
    importRequest.current++;
    if (name === "image") {
      setImportSession((current) => current + 1);
      setImportTask(null);
    }
    setDraft(null);
    setPanel(name);
    setDirty(false);
    setError("");
    setSidebarOpen(false);
    setImportBookId(null);
    setPromotion(null);
    setAppendTargetId(null);
  };
  const closePanel = () => {
    if (!mayLeave()) return;
    importRequest.current++;
    setPanel(null);
    setDirty(false);
  };
  const taskCreated = (task) => {
    if (!mounted.current) return;
    setImportTask(task);
    setActiveId(`tasks/${task.id}`);
    history.replaceState(null, "", `#tasks/${task.id}`);
  };
  const taskSubmitted = (task) => {
    if (!mounted.current) return;
    taskCreated(task);
    setPanel(null);
    setDirty(false);
    setNotice("任务已提交，可以离开此页面");
  };
  const resumeTaskDraft = (task) => {
    setImportTask(task);
    setImportSession((current) => current + 1);
    setPanel("image");
    setDirty(false);
  };
  const imageReady = async (value) => {
    const request = ++importRequest.current;
    const view = currentView.current;
    const isCurrent = () => mounted.current && request === importRequest.current &&
      (currentView.current.panel === "image" || currentView.current.activeId.startsWith("tasks/")) &&
      currentView.current.activeId === view.activeId &&
      currentView.current.editorSession === view.editorSession;
    try {
      const bookId = Object.hasOwn(value, "bookId") ? value.bookId : importBookId;
      const images = value.sourceImages?.length ? value.sourceImages : [{
        id: value.sourceImageId || value.sourceImage?.id,
        recognition: value.recognition || value,
      }];
      const addition = value.bodyHtml || blocksToHtml(value.blocks || parseText(value.content), {
        sourceImageId: images[0]?.id,
      });
      let next = { ...value, bodyHtml: addition, sourceImages: images,
        sourceImageId: images[0]?.id, bookId: bookId || undefined,
        ...(bookId ? { kind: "book" } : {}), initializeSentences: !hasCompleteSentenceBoundaries(addition),
        appendedImageId: value.appendedImageId || images[0]?.id };
      const targetId = Object.hasOwn(value, "appendToDocumentId") ? value.appendToDocumentId : appendTargetId;
      if (targetId) {
        await pendingSegmentations.current.get(targetId)?.catch(() => {});
        if (!isCurrent()) return;
        let target;
        try { target = await api(`/documents/${encodeURIComponent(targetId)}`); }
        catch (error) {
          if (error.status !== 404) throw error;
          if (!isCurrent()) return;
          setNotice("原目标文章已删除，识别结果已保留，可另存为新文章");
        }
        if (!isCurrent()) return;
        if (target) {
          const previousImages = target.sourceImages || (target.sourceImageId ? [{id:target.sourceImageId}] : []);
          if (previousImages.length + images.length > 100) {
            setNotice("原文章加图后会超过 100 张，已打开本次结果作为新文章校对，原文章保留。");
            next = { ...next, appendToDocumentId:null };
          } else {
            const bodyHtml = appendImageBodyHtml(target.bodyHtml || blocksToHtml(target.blocks, {sourceImageId:target.sourceImageId}), addition);
            next = { ...target, taskId:value.taskId, taskVersion:value.taskVersion,
              taskResultVersion:value.taskResultVersion,
              autoAnnotationCompleted:value.autoAnnotationCompleted, annotationError:value.annotationError,
              bodyHtml, content:serializeBlocks(htmlToBlocks(bodyHtml)),
              sourceImages: [...previousImages, ...images],
              initializeSentences: true, appendedImageId: value.appendedImageId || images[0]?.id };
          }
        } else next = { ...next, bookId: undefined, newBookTitle: undefined };
      }
      if (!isCurrent()) return;
      setError("");
      setSaveFailure(null);
      setPanel(null); setDraft(next); setEditorSession((n) => n + 1); setDirty(true);
    } catch (cause) { if (isCurrent()) setError(cause.message); throw cause; }
  };
  const refreshCurrentDocument = async () => {
    if (!document?.id) return;
    const updated = await api(`/documents/${encodeURIComponent(document.id)}`);
    setDocument((current) => current?.id === updated.id ? updated : current);
  };
  const segmentDocument = async (target, force = true) => {
    automaticSegmentationAttempt.current = `${target.id}:${target.revision}:${detailRefresh}`;
    const request = ++segmentationRequest.current;
    setSegmentation({ id: target.id, request, busy: true, error: "" });
    let pending = pendingSegmentations.current.get(target.id);
    if (!pending) {
      pending = (async () => {
        let latest = target;
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await api(`/documents/${encodeURIComponent(target.id)}/sentences`, {
              method: "POST", body: JSON.stringify({ revision: latest.revision, bodyHash: latest.bodyHash, force }),
            });
            latest = await api(`/documents/${encodeURIComponent(target.id)}`);
            if (!hasCompleteSentenceBoundaries(latest.bodyHtml || blocksToHtml(latest.blocks)))
              throw new Error("分句结果尚未覆盖全文，请重试。");
            return latest;
          } catch (cause) {
            if (cause.status === 409) {
              latest = await api(`/documents/${encodeURIComponent(target.id)}`);
              if (hasCompleteSentenceBoundaries(latest.bodyHtml || blocksToHtml(latest.blocks))) return latest;
              if (attempt === 0) continue;
            }
            cause.latestDocument = latest;
            throw cause;
          }
        }
      })();
      pendingSegmentations.current.set(target.id, pending);
    }
    try {
      const updated = await pending;
      if (mounted.current && currentView.current.activeId === target.id)
        setDocument((current) => current?.id === target.id && current.revision <= updated.revision ? updated : current);
      return updated;
    } catch (cause) {
      if (mounted.current && currentView.current.activeId === target.id) {
        const latest = cause.latestDocument || target;
        automaticSegmentationAttempt.current = `${latest.id}:${latest.revision}:${detailRefresh}`;
        setDocument((current) => current?.id === target.id && current.revision <= latest.revision ? latest : current);
        setSegmentation((current) => current.request === request ? { ...current, error: `分句未完成，原文已保留：${cause.message}` } : current);
      }
    } finally {
      if (pendingSegmentations.current.get(target.id) === pending) pendingSegmentations.current.delete(target.id);
      if (mounted.current) setSegmentation((current) => current.request === request ? { ...current, busy: false } : current);
    }
  };
  const save = async (value) => {
    if (saving || !mounted.current) return;
    setSaving(true);
    setSaveFailure(null);
    setError("");
    try {
      const result = await api(
        value.taskId ? `/image-tasks/${encodeURIComponent(value.taskId)}/apply`
          : value.id ? `/documents/${value.id}` : "/documents",
        {
          method: value.taskId ? "POST" : value.id ? "PUT" : "POST",
          body: JSON.stringify(value.taskId ? { version:value.taskVersion,
            resultVersion:value.taskResultVersion, document:value } : value),
        },
      );
      if (value.taskId) notifyImageTasksChanged();
      if (!mounted.current) return;
      const parent = result.bookId
        ? await api(`/books/${encodeURIComponent(result.bookId)}`).catch(() => null)
        : null;
      if (!mounted.current) return;
      if (activeId !== result.id) savedDetail.current = result.id;
      setBook(parent);
      setDocument(result);
      setActiveId(result.id);
      history.replaceState(null, "", `#${result.id}`);
      setDraft(null);
      setDirty(false);
      setRefresh((n) => n + 1);
      setNotice(result.bookId ? "已保存到书籍" : "已保存到书架");
      if (!hasCompleteSentenceBoundaries(result.bodyHtml || blocksToHtml(result.blocks))) void segmentDocument(result, false);
    } catch (e) {
      if (mounted.current) {
        setError(e.message);
        setSaveFailure({ status:e.status, code:e.code, message:e.message, taskId:value.taskId, id:value.id });
      }
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  const remove = async () => {
    if (
      !window.confirm(`删除《${document.title}》？删除后无法撤销，建议先导出。`)
    )
      return;
    try {
      await api(`/documents/${document.id}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: document.revision }),
      });
      const nextId = document.bookId ? `book/${document.bookId}` : "";
      setActiveId(nextId);
      setPanel(null);
      setDocument(null);
      history.replaceState(null, "", nextId ? `#${nextId}` : window.location.pathname);
      setRefresh((n) => n + 1);
      setNotice(document.bookId ? "文章已删除" : "材料已删除");
    } catch (e) {
      setError(e.message);
    }
  };

  const openBook = (id) => openDocument(`book/${id}`);
  const beginBookPage = (imagePage) => {
    if (!book || !mayLeave()) return;
    if (imagePage) {
      openPanel("image");
      setImportBookId(book.id);
    } else beginNew({
      title: `文章 ${book.pages.length + 1}`, kind: "book", orientation: "horizontal",
      content: "", bookId: book.id,
    });
  };
  const createBook = async (title) => {
    const created = await api("/books", {
      method: "POST", body: JSON.stringify({ title }),
    });
    setBooks((current) => [{ ...created, pageCount: created.pages.length, charCount: 0 }, ...current]);
    setRefresh((n) => n + 1);
    return created;
  };
  const saveBook = async (title) => {
    if (bookBusy) return;
    setBookBusy(true);
    setError("");
    try {
      const created = await api("/books", {
        method: "POST",
        body: JSON.stringify({ title, ...(promotion ? { documentId: promotion.id } : {}) }),
      });
      setPanel(null);
      setPromotion(null);
      setDirty(false);
      setDocument(null);
      setActiveId(`book/${created.id}`);
      history.replaceState(null, "", `#book/${created.id}`);
      setRefresh((n) => n + 1);
      setNotice(promotion ? "已转为书籍，原材料保留为第1篇文章" : "书籍已创建，可以开始添加文章");
    } catch (cause) {
      setError(cause.message);
    } finally { setBookBusy(false); }
  };
  const updateBook = async (changes) => {
    if (bookBusy || !book) return;
    setBookBusy(true);
    setError("");
    try {
      const updated = await api(`/books/${encodeURIComponent(book.id)}`, {
        method: "PUT", body: JSON.stringify({ title: book.title, revision: book.revision, ...changes }),
      });
      setBook(updated);
      setRefresh((n) => n + 1);
      return updated;
    } catch (cause) {
      setError(cause.message);
      setDetailRefresh((n) => n + 1);
      throw cause;
    } finally { setBookBusy(false); }
  };
  const deleteBook = async () => {
    if (bookBusy || !window.confirm(`删除《${book.title}》及其中全部${book.pages.length}篇文章？删除后无法撤销。`)) return;
    setBookBusy(true);
    try {
      await api(`/books/${encodeURIComponent(book.id)}`, {
        method: "DELETE", body: JSON.stringify({ revision: book.revision }),
      });
      setActiveId("");
      setBook(null);
      setDocument(null);
      history.replaceState(null, "", window.location.pathname);
      setRefresh((n) => n + 1);
      setNotice("书籍已删除");
    } catch (cause) {
      setError(cause.message);
      setDetailRefresh((n) => n + 1);
    } finally { setBookBusy(false); }
  };

  return (
    <div className="app-shell">
      {sidebarOpen && (
        <button
          className="sidebar-backdrop"
          onClick={() => setSidebarOpen(false)}
          aria-label="关闭书架"
        />
      )}
      <aside
        className={`sidebar ${sidebarOpen ? "is-open" : ""}`}
        aria-label="书架"
      >
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            if (mayLeave()) {
              setActiveId("");
              setPanel(null);
              setDraft(null);
              setDirty(false);
              history.replaceState(null, "", window.location.pathname);
              setSidebarOpen(false);
            }
          }}
        >
          <span className="brand-mark">余</span>
          <span className="brand-copy">
            <span className="brand-title-row">
              <strong>余白</strong>
              <span className="brand-en">YOHAKU</span>
            </span>
            <small>多语阅读与笔记</small>
          </span>
        </a>
        <div className="sidebar-actions">
          <button
            className="button primary sidebar-primary-action"
            disabled={saving}
            onClick={() => openPanel("image")}
          >
            <Icon name="plus" size={16} />
            导入图片
          </button>
          <div className="sidebar-secondary-actions">
            <button
              className="button secondary"
              disabled={saving}
              onClick={() => beginNew()}
            >
              导入文字
            </button>
            <button
              className="button secondary"
              disabled={saving || bookBusy}
              onClick={() => openPanel("newBook")}
            >
              新建书籍
            </button>
          </div>
          {activeTaskCount > 0 && <button className="button secondary sidebar-task-link" disabled={saving || bookBusy}
            onClick={() => openDocument("tasks")}>
            <Icon name="menu" size={16} />任务与导入草稿
            {!!(taskCounts.queued || taskCounts.running) &&
              <span className="count">处理中 {(taskCounts.queued || 0) + (taskCounts.running || 0)}</span>}
            {activeTaskCount > (taskCounts.queued || 0) + (taskCounts.running || 0) &&
              <span className="count">待处理 {activeTaskCount - (taskCounts.queued || 0) - (taskCounts.running || 0)}</span>}
          </button>}
        </div>
        <div className="shelf-heading">
          <span>
            <Icon name="book" size={15} />
            我的书架
          </span>
          <span className="count">{documents.length + shelfBooks.length}</span>
        </div>
        <label className="search-box">
          <Icon name="search" size={15} />
          <input
            aria-label="搜索书架"
            placeholder="搜索标题或正文"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            maxLength={200}
          />
        </label>
        <nav className="document-list" aria-label="阅读材料">
          {loading && <p className="shelf-empty">正在打开书架…</p>}
          {!loading && documents.length === 0 && shelfBooks.length === 0 && (
            <p className="shelf-empty">
              {query ? "没有找到匹配的材料。" : "还没有材料。"}
            </p>
          )}
          {shelfBooks.map((item) => (
            <button
              className={`document-link ${item.id === book?.id ? "active" : ""}`}
              key={`book-${item.id}`}
              disabled={saving || bookBusy}
              onClick={() => openBook(item.id)}
            >
              <span className="document-link-top">
                <span className="kind-dot book" />书籍
                <span>{item.pageCount} 篇 · {item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview?.replace(/\n/g, " ") || "添加文章，开始阅读"}</small>
            </button>
          ))}
          {documents.map((item) => (
            <button
              className={`document-link ${item.id === activeId ? "active" : ""}`}
              key={item.id}
              disabled={saving}
              onClick={() => openDocument(item.id)}
            >
              <span className="document-link-top">
                <span className={`kind-dot ${item.kind}`} />
                {kinds[item.kind]}
                <span>{item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview.replace(/\n/g, " ")}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          {user.isAdmin && (
            <div className="sidebar-admin-row">
              <button
                className={`text-button sidebar-settings-button ${panel === "settings" ? "active" : ""}`}
                type="button"
                disabled={saving}
                onClick={() => openPanel("settings")}
              >
                <span className="ai-dot" aria-hidden="true" />
                AI 设置
              </button>
            </div>
          )}
          <UserMenu
            user={user}
            onBeforeLogout={mayLeave}
            onLoggedOut={onLoggedOut}
          />
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <button
            className="icon-button mobile-menu"
            aria-label="打开书架"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="topbar-brand">余白</span>
        </header>
        {(error || shelfError) && (
          <div className="error-banner" role="alert">
            <span>{error || shelfError}</span>
            <button
              className="icon-button"
              aria-label="关闭错误提示"
              onClick={() => {
                setError("");
                setShelfError("");
              }}
            >
              <Icon name="close" size={16} />
            </button>
          </div>
        )}
        {panel === "newBook" ? (
          <BookCreate
            key={promotion?.id || "new"}
            initialTitle={promotion?.title || ""}
            promoting={!!promotion}
            busy={bookBusy}
            onSave={saveBook}
            onCancel={closePanel}
            onDirty={setDirty}
          />
        ) : panel === "settings" && user.isAdmin ? (
          <AISettings onClose={closePanel} />
        ) : panel === "image" ? (
          <ImageImport
            key={importSession}
            taskId={importTask?.id || null}
            initialTask={importTask}
            onTaskCreated={taskCreated}
            onSubmitted={taskSubmitted}
            onCancel={() => openDocument("tasks")}
            onDirty={setDirty}
            articles={articleTargets}
            books={books}
            initialBookId={importBookId}
            onCreateBook={createBook}
            initialTargetId={appendTargetId}
          />
        ) : draft ? (
          <Editor
            key={editorSession}
            initial={draft}
            onSave={save}
            onCancel={cancelEdit}
            onDirty={(next = true) => setDirty(next)}
            onDocumentChanged={(latest) => setDocument((current) => current?.id === latest.id ? latest : current)}
            saving={saving}
            saveError={saveFailure?.taskId === draft.taskId && saveFailure?.id === draft.id ? saveFailure : null}
            books={books}
            onCreateBook={createBook}
          />
        ) : activeId === "tasks" ? (
          <TaskList onOpen={(task) => openDocument(`tasks/${typeof task === "string" ? task : task.id}`)}
            onNew={() => openPanel("image")} onDocumentOpen={openDocument} />
        ) : activeId.startsWith("tasks/") ? (
          <TaskDetail key={activeId} taskId={activeId.slice(6)}
            onOpenDraft={resumeTaskDraft} onReady={imageReady}
            onBack={() => openDocument("tasks")} onDocumentOpen={openDocument} />
        ) : document ? (
          <div className={`reader-workspace ${readingReady && panel === "chat" ? "has-chat" : ""}`}>
            <div className="reader-main-column">
              {currentReadingDocument && book ? (
                <BookNavigation
                  book={book}
                  currentPageId={document.id}
                  onOpenBook={() => openBook(book.id)}
                  onOpenPage={openDocument}
                  onAddImage={() => beginBookPage(true)}
                  disabled={saving || bookBusy}
                />
              ) : currentReadingDocument?.bookId ? (
                <div className="book-promotion">
                  <button className="text-button" onClick={() => openBook(document.bookId)}>打开所属书籍</button>
                  <span>目录暂未加载，正文已保存，可重新打开书籍。</span>
                </div>
              ) : null}
              {readingReady ? <Reader
                document={document}
                onEdit={beginEdit}
                onDelete={remove}
                onDiscuss={() => {
                  if (panel === "chat") closePanel();
                  else { setSelectedGroupIds(null); setChatRequest(null); openPanel("chat"); }
                }}
                onAsk={(request) => { setChatRequest({...request,key:crypto.randomUUID()}); setSelectedGroupIds(null); setPanel("chat"); }}
                onGroup={(ids) => { setSelectedGroupIds(ids); setChatRequest(null); setPanel("chat"); }}
                onAppendImage={() => { openPanel("image"); setAppendTargetId(document.id); setImportBookId(document.bookId || null); }}
                onSegment={() => segmentDocument(document, true)}
                segmentationBusy={segmentation.id === document.id && segmentation.busy}
                segmentationError={segmentation.id === document.id ? segmentation.error : ""}
                chatOpen={panel === "chat"}
                onPromoteBook={
                  !document.bookId
                    ? () => {
                        if (!mayLeave()) return;
                        openPanel("newBook");
                        setPromotion(document);
                      }
                    : null
                }
                showRuby={showRuby}
                setShowRuby={setShowRuby}
                fontSize={fontSize}
                setFontSize={setFontSize}
              /> : <ReadingPreparation
                document={currentReadingDocument}
                error={segmentation.id === currentReadingDocument?.id ? segmentation.error : ""}
                onRetry={() => segmentDocument(currentReadingDocument, false)}
                onEdit={beginEdit}
                onBack={() => openDocument("")}
              />}
            </div>
            {readingReady && panel === "chat" && (
              <DocumentChat
                document={document}
                request={chatRequest} selectedGroupIds={selectedGroupIds}
                onDocumentChanged={refreshCurrentDocument}
                onRequestHandled={() => setChatRequest(null)}
                onClose={() => {
                  setPanel(null);
                  setDirty(false);
                }}
                onDirty={setDirty}
              />
            )}
          </div>
        ) : book && activeId.startsWith("book/") ? (
          <BookView
            book={book}
            onOpenPage={openDocument}
            onAddImage={() => beginBookPage(true)}
            onAddText={() => beginBookPage(false)}
            onRename={(title) => updateBook({ title })}
            onReorder={(pageIds) => updateBook({ pageIds })}
            onDelete={deleteBook}
            busy={bookBusy}
          />
        ) : activeId ? (
          <div className="loading-page">
            {detailLoading ? (
              "正在打开材料…"
            ) : (
              <>
                <p>
                  {detailFailed
                    ? "暂时无法打开这篇材料。"
                    : "这篇材料尚未加载。"}
                </p>
                <button
                  className="text-button"
                  onClick={() => {
                    setError("");
                    setDetailRefresh((n) => n + 1);
                  }}
                >
                  重新打开
                  <Icon name="arrow" size={16} />
                </button>
              </>
            )}
          </div>
        ) : (
          <Welcome
            onOpenBook={openBook}
            onOpenDocument={openDocument}
            books={books}
            documents={libraryDocuments}
            loading={loading}
            activeTaskCount={activeTaskCount}
            taskCounts={taskCounts}
            onOpenTasks={() => openDocument("tasks")}
          />
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
    </div>
  );
}
