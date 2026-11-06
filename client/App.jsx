import { useEffect, useLayoutEffect, useRef, useState } from "react";
import api from "./api.mjs";
import { blocksToHtml, hasCompleteSentenceBoundaries, htmlToBlocks, appendImageBodyHtml } from "../shared/article-html.mjs";
import { parseText, serializeBlocks } from "../shared/document.mjs";
import Icon from "./components/Icon.jsx";
import Welcome from "./components/Welcome.jsx";
import Reader from "./components/Reader.jsx";
import ReadingPreparation from "./components/ReadingPreparation.jsx";
import PagedReader from "./components/PagedReader.jsx";
import SourceCorrection from "./components/SourceCorrection.jsx";
import UnifiedImport from "./components/UnifiedImport.jsx";
import Editor from "./components/Editor.jsx";
import AISettings from "./components/AISettings.jsx";
import RoleSettings from "./components/RoleSettings.jsx";
import ImageImport from "./components/ImageImport.jsx";
import { TaskList, TaskDetail } from "./components/ImageTasks.jsx";
import ErrorLog from "./components/ErrorLog.jsx";
import { OPEN_PANEL_EVENT } from "./components/ErrorNotice.mjs";
import { UserContext } from "./user-context.mjs";
import { imageTasksChangedEvent, notifyImageTasksChanged } from "./image-tasks.mjs";
import DocumentChat from "./components/DocumentChat.jsx";
import { createChatSession } from "./chat-history.mjs";
import AccountGate from "./components/AccountGate.jsx";
import Sidebar from "./components/Sidebar.jsx";
import BookView from "./components/BookView.jsx";
import BookNavigation from "./components/BookNavigation.jsx";
import PWAManager from "./PWAManager.jsx";
import { useConfirmation } from "./components/ConfirmDialog.jsx";

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
    <UserContext.Provider value={session.user}>
      <Workspace
        key={session.user.id}
        user={session.user}
        onLoggedOut={() => {
          history.replaceState(null, "", window.location.pathname);
          setSession({ user: null, needsSetup: false });
        }}
      />
    </UserContext.Provider>
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
  const { confirm, confirmationDialog } = useConfirmation();
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
  const [importText, setImportText] = useState(false);
  const [correctionTarget, setCorrectionTarget] = useState({});
  const [importTask, setImportTask] = useState(null);
  const [chatRequest, setChatRequest] = useState(null);
  const [chatNavigation, setChatNavigation] = useState(null);
  const [answering, setAnswering] = useState(false);
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
  const [importDraftId,setImportDraftId]=useState(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem("yohaku.sidebarCollapsed") === "1"; }
    catch { return false; }
  });
  const [showRuby, setShowRuby] = useState(true);
  const [fontSize, setFontSize] = useState(26);
  const [panel, setPanel] = useState(() =>
    user.isAdmin && new URLSearchParams(window.location.search).get("chatgpt") === "connected"
      ? "settings"
      : null,
  );
  const savedDetail = useRef(null);
  const deletingArticle = useRef(false);
  const importRequest = useRef(0);
  const segmentationRequest = useRef(0);
  const pendingSegmentations = useRef(new Map());
  const automaticSegmentationAttempt = useRef(null);
  const readingSummaryVersion = useRef(null);
  const currentView = useRef(null);
  const chatSessions = useRef(new Map());
  const chatSessionFor = (id) => {
    if (!chatSessions.current.has(id)) chatSessions.current.set(id, createChatSession());
    return chatSessions.current.get(id);
  };
  const readerMain = useRef(null);
  const readingSessions = useRef(new Map());
  const readingSessionFor = (id) => {
    if (!readingSessions.current.has(id)) readingSessions.current.set(id, {id:crypto.randomUUID(),sequence:0});
    return readingSessions.current.get(id);
  };
  const readingPosition = useRef(null);
  const readingResume = useRef(null);
  const sidebarCollapseButton = useRef(null);
  const sidebarExpandButton = useRef(null);
  const focusSidebarToggle = useRef(false);
  const currentReadingDocument = document?.id === activeId ? document : null;
  const readingReady = !!currentReadingDocument && (currentReadingDocument.sourceWorkflow || hasCompleteSentenceBoundaries(currentReadingDocument.bodyHtml || blocksToHtml(currentReadingDocument.blocks)));
  // The main view chain below falls through to Welcome exactly when this holds.
  // Welcome shows shelf load failures itself; the banner would repeat them there.
  const showsWelcome = !activeId && !draft
    && !["newBook", "import", "image"].includes(panel)
    && !(user.isAdmin && ["settings", "roles", "errors"].includes(panel))
    && !(panel === "correction" && currentReadingDocument);
  const rememberReadingPosition = () => {
    if (!window.matchMedia("(min-width: 761px)").matches) return;
    const anchor = Array.from(readerMain.current?.querySelectorAll(".article-body [data-sentence-id]") || [])
      .find((element) => {
        const rect = element.getBoundingClientRect();
        return rect.bottom > 64 && rect.top < window.innerHeight;
      });
    readingPosition.current = anchor ? { element: anchor, top: anchor.getBoundingClientRect().top } : null;
  };
  const toggleDesktopSidebar = () => {
    rememberReadingPosition();
    focusSidebarToggle.current = true;
    setSidebarCollapsed((value) => !value);
  };
  useLayoutEffect(() => {
    const anchor = readingPosition.current;
    readingPosition.current = null;
    if (anchor?.element.isConnected) window.scrollBy(0, anchor.element.getBoundingClientRect().top - anchor.top);
    if (focusSidebarToggle.current) {
      focusSidebarToggle.current = false;
      (sidebarCollapsed ? sidebarExpandButton : sidebarCollapseButton).current?.focus({ preventScroll: true });
    }
  }, [sidebarCollapsed, panel]);
  useEffect(() => {
    try { localStorage.setItem("yohaku.sidebarCollapsed", sidebarCollapsed ? "1" : "0"); }
    catch { /* Sidebar controls still work when browser storage is unavailable. */ }
  }, [sidebarCollapsed]);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; importRequest.current++; };
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
        const result = await api("/tasks?scope=active&limit=1", { signal:controller.signal });
        if (!stopped && current === sequence) setTaskCounts(result.counts || {});
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
            if (controller.signal.aborted) return;
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
  const previousActiveId = useRef(activeId);
  useEffect(() => {
    // Reading moves the saved page, so reload the summaries when the reader returns home.
    if (!activeId && previousActiveId.current) setRefresh((n) => n + 1);
    previousActiveId.current = activeId;
  }, [activeId]);
  useEffect(() => {
    if (!currentReadingDocument || currentReadingDocument.sourceWorkflow || !readingReady) return;
    // Paged articles save their page through the reading-session heartbeat;
    // single-page articles only record that they were opened.
    api(`/documents/${encodeURIComponent(currentReadingDocument.id)}/reading-position`, {
      method: "PUT", body: JSON.stringify({ pageIndex: 0 }),
    }).catch(() => { /* Progress is a convenience; reading continues without it. */ });
  }, [currentReadingDocument?.id, currentReadingDocument?.sourceWorkflow, readingReady]);

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
    const isBook = activeId.startsWith("book/");
    setDocument(null);
    setBook((current) => current && (isBook
      ? current.id === activeId.slice(5)
      : current.pages.some((page) => page.id === activeId)) ? current : null);
    setDetailLoading(true);
    setDetailFailed(false);
    api(isBook
      ? `/books/${encodeURIComponent(activeId.slice(5))}`
      : `/documents/${encodeURIComponent(activeId)}`, { signal: controller.signal })
      .then(async (result) => {
        if (controller.signal.aborted) return;
        if (isBook) setBook(result);
        else {
          setDocument(result);
          setBook((current) => current?.id === result.bookId ? current : null);
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
      readingResume.current = null;
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
    if (!document || document.sourceWorkflow || activeId !== document.id || draft || saving || (panel && panel !== "chat")) return;
    const html = document.bodyHtml || blocksToHtml(document.blocks);
    if (hasCompleteSentenceBoundaries(html)) return;
    const attempt = `${document.id}:${document.revision}:${detailRefresh}`;
    if (automaticSegmentationAttempt.current === attempt) return;
    automaticSegmentationAttempt.current = attempt;
    void segmentDocument(document, false);
  }, [document, activeId, draft, panel, saving, detailRefresh]);

  const mayLeave = () =>
    !saving && !bookBusy && (!dirty || window.confirm("当前修改还没有保存，确定离开吗？"));
  const goHome = () => {
    if (!mayLeave()) return;
    setActiveId("");
    setPanel(null);
    setDraft(null);
    setDirty(false);
    history.replaceState(null, "", window.location.pathname);
    setSidebarOpen(false);
  };
  const openDocument = (id, { reviewSourceId } = {}) => {
    if (!mayLeave()) return;
    readingResume.current = null;
    setDraft(null);
    setCorrectionTarget(reviewSourceId ? { reviewSourceId } : {});
    setPanel(reviewSourceId ? "correction" : null);
    setDirty(false);
    setError("");
    setSidebarOpen(false);
    setActiveId(id);
    history.replaceState(null, "", `#${id}`);
    setDetailRefresh((n) => n + 1);
  };
  const beginEdit = () => {
    if (!mayLeave() || !document?.id) return;
    setCorrectionTarget({});
    setPanel("correction");
    setDirty(false);
    setError("");
  };
  const cancelEdit = () => {
    if (mayLeave()) {
      setDraft(null);
      setDirty(false);
      setError("");
    }
  };
  const openPanel = (name) => {
    if (["settings", "roles", "errors"].includes(name) && !user.isAdmin) return;
    if (!mayLeave()) return;
    if (name === "chat" && panel !== "chat") rememberReadingPosition();
    importRequest.current++;
    if (name === "image" || name === "import") {
      setImportSession((current) => current + 1);
      setImportTask(null);
      setImportText(false);
      setImportDraftId(null);
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
  useEffect(() => {
    const open = (event) => openPanel(event.detail);
    window.addEventListener(OPEN_PANEL_EVENT, open);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, open);
  });
  const openUnifiedImport = (text = false) => {
    openPanel("import"); setImportText(text);
  };
  const resumeImportDraft = async (task) => {
    const request=++importRequest.current,view=currentView.current.activeId;
    const next=await api(`/imports/${encodeURIComponent(task.importId)}`);
    if(!mounted.current || request!==importRequest.current || currentView.current.activeId!==view)return;
    if (!mayLeave()) return;
    openPanel("import");setImportDraftId(next.id);setImportBookId(next.context?.bookId || null);setAppendTargetId(next.context?.targetId || null);
  };
  const imported = (result) => {
    readingResume.current = null;
    setDirty(false); setRefresh((current) => current + 1);
    setNotice("已保存原始资料，按阅读进度准备正文");
    const id = result.firstDocumentId || result.documents?.[0]?.id || (result.bookId ? `book/${result.bookId}` : "");
    setPanel(null);setDraft(null);setError("");setSidebarOpen(false);setActiveId(id);
    history.replaceState(null,"",id ? `#${id}` : window.location.pathname);setDetailRefresh((current) => current + 1);
  };
  const editSources = (ids = [], pageIndex) => {
    if (!mayLeave()) return;
    setCorrectionTarget({ sourceIds: ids, pageIndex });setPanel("correction");setDirty(false);
  };
  const returnFromCorrection = () => {
    if (!mayLeave()) return;
    if (currentReadingDocument?.sourceWorkflow)
      readingResume.current = {documentId:currentReadingDocument.id,index:correctionTarget.pageIndex ?? null};
    setPanel(null);setDirty(false);void refreshCurrentDocument();
  };
  const closePanel = () => {
    if (!mayLeave()) return;
    if (panel === "chat") rememberReadingPosition();
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
  const readingPageChanged = (page, snapshot) => {
    if (!mounted.current || !snapshot || currentView.current.activeId !== document?.id) return;
    if (readingResume.current?.documentId === document.id) readingResume.current = null;
    const pages = snapshot.pages || (page ? [page] : []);
    if (!snapshot.complete && !pages.some((item) => item.ready)) return;
    const signature = JSON.stringify([snapshot.bodyHash, pages.map((item) => [item.id,item.ready,item.bodyHtml])]);
    if (readingSummaryVersion.current?.documentId === document.id && readingSummaryVersion.current.signature === signature) return;
    readingSummaryVersion.current = {documentId:document.id,signature};
    setRefresh((value) => value + 1);
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
  const remove = async (target) => {
    if (deletingArticle.current || saving || bookBusy || !target?.id) return false;
    const view = currentView.current;
    if (!await confirm({ title: "删除整篇文章", confirmLabel: "删除整篇文章",
      description: `删除《${target.title}》？正文和讨论将一起删除，删除后无法撤销。` })) return false;
    if (!mounted.current || currentView.current.activeId !== view.activeId || currentView.current.editorSession !== view.editorSession) return false;
    deletingArticle.current = true;
    setSaving(true);
    setError("");
    try {
      await api(`/documents/${encodeURIComponent(target.id)}`, {
        method: "DELETE",
        body: JSON.stringify({ revision: target.revision }),
      });
      if (!mounted.current) return true;
      const nextId = target.bookId ? `book/${target.bookId}` : "";
      setDraft(null);
      setDirty(false);
      setSaveFailure(null);
      setActiveId(nextId);
      setPanel(null);
      setDocument(null);
      history.replaceState(null, "", nextId ? `#${nextId}` : window.location.pathname);
      setRefresh((n) => n + 1);
      setNotice("文章已删除");
      return true;
    } catch (e) {
      if (mounted.current) setError(e.message);
      return false;
    } finally {
      deletingArticle.current = false;
      if (mounted.current) setSaving(false);
    }
  };

  const openBook = (id) => openDocument(`book/${id}`);
  // Opens the add page with this book preselected.
  const beginBookPage = () => {
    if (!book || !mayLeave()) return;
    openUnifiedImport();
    setImportBookId(book.id);
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
      // The book page shows the error next to the action.
      setDetailRefresh((n) => n + 1);
      throw cause;
    } finally { setBookBusy(false); }
  };
  const deleteBook = async () => {
    if (bookBusy || !book) return;
    const target = book, viewId = activeId;
    if (!await confirm({ title: "删除书籍", confirmLabel: "删除书籍",
      description: `删除《${target.title}》及其中全部 ${target.pages.length} 篇文章？正文和讨论将一起删除，删除后无法撤销。` })) return;
    if (!mounted.current || currentView.current.activeId !== viewId) return;
    setBookBusy(true);
    try {
      await api(`/books/${encodeURIComponent(target.id)}`, {
        method: "DELETE", body: JSON.stringify({ revision: target.revision }),
      });
      setActiveId("");
      setBook(null);
      setDocument(null);
      history.replaceState(null, "", window.location.pathname);
      setRefresh((n) => n + 1);
      setNotice("书籍已删除");
    } catch (cause) {
      setDetailRefresh((n) => n + 1);
      throw cause;
    } finally { setBookBusy(false); }
  };
  const bookNavigation = book && book.pages.some((page) => page.id === activeId)
    && (!currentReadingDocument || currentReadingDocument.bookId === book.id) ? <BookNavigation
      book={book} currentPageId={activeId} onOpenBook={() => openBook(book.id)} onOpenPage={openDocument}
      onAddImage={beginBookPage} disabled={saving || bookBusy} /> : null;

  return (
    <div className={`app-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <Sidebar
        user={user} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        collapseButtonRef={sidebarCollapseButton} onCollapse={toggleDesktopSidebar}
        saving={saving} bookBusy={bookBusy} activeId={activeId} activeBookId={book?.id}
        shelfBooks={shelfBooks} documents={documents} loading={loading}
        query={query} onQueryChange={setQuery} taskCount={taskCounts.attention}
        onHome={goHome} onAdd={() => openUnifiedImport()} onNewBook={() => openPanel("newBook")}
        onTasks={() => openDocument("tasks")} onOpenBook={openBook} onOpenDocument={openDocument}
        onOpenPanel={openPanel} onBeforeLogout={mayLeave} onLoggedOut={onLoggedOut}
      />
      <main className="main-panel">
        <header className="topbar">
          {sidebarCollapsed && <button ref={sidebarExpandButton} className="icon-button desktop-sidebar-expand"
            type="button" aria-label="展开书架" aria-controls="bookshelf" aria-expanded="false"
            onClick={toggleDesktopSidebar}>
            <Icon name="panel-open" />
          </button>}
          <button
            className="icon-button mobile-menu"
            aria-label="打开书架"
            onClick={() => setSidebarOpen(true)}
          >
            <Icon name="menu" />
          </button>
          <span className="topbar-brand">余白</span>
        </header>
        {(error || (showsWelcome ? "" : shelfError)) && (
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
        ) : panel === "roles" && user.isAdmin ? (
          <RoleSettings onClose={closePanel} />
        ) : panel === "errors" && user.isAdmin ? (
          <ErrorLog onClose={closePanel} />
        ) : panel === "import" ? (
          <UnifiedImport key={importSession} initialText={importText} initialBookId={importBookId} initialTargetId={appendTargetId} initialImportId={importDraftId}
            onCancel={closePanel} onDirty={setDirty} onImported={imported} />
        ) : panel === "correction" && currentReadingDocument ? (
          <SourceCorrection key={currentReadingDocument.id} document={currentReadingDocument} sourceIds={correctionTarget.sourceIds} reviewSourceId={correctionTarget.reviewSourceId}
            chatSession={chatSessionFor(currentReadingDocument.id)} onDirty={setDirty} onDocumentChanged={refreshCurrentDocument}
            onClose={returnFromCorrection} />
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
            chatSession={draft.id ? chatSessionFor(draft.id) : null}
            onSave={save}
            onDelete={remove}
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
            onNew={() => openUnifiedImport()} onDocumentOpen={openDocument} />
        ) : activeId.startsWith("tasks/") ? (
          <TaskDetail key={activeId} taskId={activeId.slice(6)}
            onOpenDraft={resumeTaskDraft} onImportOpen={resumeImportDraft} onReady={imageReady}
            onBack={() => openDocument("tasks")} onDocumentOpen={openDocument} />
        ) : currentReadingDocument ? (
          <div className={`reader-workspace ${readingReady && panel === "chat" ? "has-chat" : ""}`}>
            <div className="reader-main-column" ref={readerMain}>
              {bookNavigation || (currentReadingDocument?.bookId ? (
                <div className="book-promotion">
                  <button className="text-button" onClick={() => openBook(document.bookId)}>打开所属书籍</button>
                  <span role="status">{detailLoading ? "正在加载目录…" : "目录暂未加载，正文已保存，可重新打开书籍。"}</span>
                </div>
              ) : null)}
              {document.sourceWorkflow ? <PagedReader
                key={document.id} document={document} active={!panel || panel === "chat"}
                session={readingSessionFor(document.id)}
                resumePosition={readingResume.current?.documentId === document.id ? readingResume.current : null}
                onPageChange={readingPageChanged}
                onEditSources={editSources} onDelete={() => remove(document)}
                onDiscuss={() => {setChatRequest(null);setPanel(panel === "chat" ? null : "chat");}}
                onAsk={(request) => {if(answering)return;setChatRequest({...request,key:crypto.randomUUID()});setPanel("chat");}}
                onGroup={(ids) => {setChatNavigation({key:crypto.randomUUID(),documentId:document.id,groupIds:ids});setPanel("chat");}}
                answering={answering} chatOpen={panel === "chat"} showRuby={showRuby} setShowRuby={setShowRuby}
                fontSize={fontSize} setFontSize={setFontSize}
                onPromoteBook={!document.bookId ? () => {
                  if (!mayLeave()) return;
                  openPanel("newBook");
                  setPromotion(document);
                } : null}
                onAppendImage={() => {openUnifiedImport();setAppendTargetId(document.id);setImportBookId(document.bookId || null);}}
              /> : readingReady ? <Reader
                document={document}
                onEdit={beginEdit}
                onDelete={() => remove(document)}
                onDiscuss={() => {
                  if (panel === "chat") closePanel();
                  else { setChatRequest(null); openPanel("chat"); }
                }}
                onAsk={(request) => { if (answering) return; if (panel !== "chat") rememberReadingPosition(); setChatRequest({...request,key:crypto.randomUUID()}); setPanel("chat"); }}
                answering={answering}
                onGroup={(ids) => { if (panel !== "chat") rememberReadingPosition(); setChatNavigation({key:crypto.randomUUID(),documentId:document.id,groupIds:ids}); setChatRequest(null); setPanel("chat"); }}
                onAppendImage={() => { openUnifiedImport(); setAppendTargetId(document.id); setImportBookId(document.bookId || null); }}
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
            {readingReady && (
              <DocumentChat
                key={document.id}
                document={document}
                open={panel === "chat"} session={chatSessionFor(document.id)}
                request={chatRequest} navigation={chatNavigation}
                onBusyChange={setAnswering}
                onOpen={() => { rememberReadingPosition(); setPanel("chat"); }}
                onDocumentChanged={refreshCurrentDocument}
                onRequestHandled={() => setChatRequest(null)}
                onClose={() => {
                  rememberReadingPosition();
                  setPanel(null);
                  setDirty(false);
                }}
              />
            )}
          </div>
        ) : book && activeId.startsWith("book/") ? (
          <BookView
            key={book.id}
            book={book}
            taskCounts={taskCounts}
            onOpenShelf={goHome}
            onOpenPage={openDocument}
            onAddArticle={beginBookPage}
            onRename={(title) => updateBook({ title })}
            onReorder={(pageIds) => updateBook({ pageIds })}
            onDelete={deleteBook}
            busy={bookBusy}
          />
        ) : activeId ? (<>
          {bookNavigation}
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
        </>) : showsWelcome && (
          <Welcome
            books={books}
            documents={libraryDocuments}
            articles={articleTargets}
            loading={loading}
            error={shelfError}
            attentionCount={taskCounts.attention ?? 0}
            onOpenBook={openBook}
            onOpenDocument={openDocument}
            onOpenTasks={() => openDocument("tasks")}
            onAddPhoto={() => openUnifiedImport()}
          />
        )}
      </main>
      {notice && (
        <div className="toast" role="status">
          <Icon name="check" size={18} />
          {notice}
        </div>
      )}
      {confirmationDialog}
    </div>
  );
}
