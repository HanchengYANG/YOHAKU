import { useEffect, useRef, useState } from "react";
import api from "./api.mjs";
import { blocksToHtml, bodyText, bodyRanges, htmlToBlocks, appendBodyHtml } from "../shared/article-html.mjs";
import { parseText, serializeBlocks } from "../shared/document.mjs";
import { kinds } from "./constants.mjs";
import Icon from "./components/Icon.jsx";
import Welcome from "./components/Welcome.jsx";
import Reader from "./components/Reader.jsx";
import Editor from "./components/Editor.jsx";
import AISettings from "./components/AISettings.jsx";
import ImageImport from "./components/ImageImport.jsx";
import DocumentChat from "./components/DocumentChat.jsx";
import AccountGate from "./components/AccountGate.jsx";
import UserMenu from "./components/UserMenu.jsx";
import BookView from "./components/BookView.jsx";
import BookNavigation from "./components/BookNavigation.jsx";

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
  if (sessionError)
    return (
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
  if (!session) return <div className="loading-page">正在读取登录状态…</div>;
  if (!session.user)
    return (
      <AccountGate
        session={session}
        onAuthenticated={(user) => setSession({ user, needsSetup: false })}
      />
    );
  return (
    <Workspace
      key={session.user.id}
      user={session.user}
      onLoggedOut={() => {
        history.replaceState(null, "", window.location.pathname);
        setSession({ user: null, needsSetup: false });
      }}
    />
  );
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
  const [chatRequest, setChatRequest] = useState(null);
  const [selectedGroupIds, setSelectedGroupIds] = useState(null);
  const [appendTargetId, setAppendTargetId] = useState(null);
  const [segmentationBusy, setSegmentationBusy] = useState(false);
  const [segmentationError, setSegmentationError] = useState("");
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
  const [notice, setNotice] = useState("");
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
  const currentView = useRef(null);
  currentView.current = {activeId, panel, editorSession};

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
    if (!activeId) {
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
    setPanel(null);
    setDirty(false);
  };
  const imageReady = async (value) => {
    try {
      let next = { ...value, ...(importBookId ? { bookId: importBookId, kind: "book" } : {}) };
      const targetId = value.appendToDocumentId || appendTargetId;
      if (targetId) {
        let target = await api(`/documents/${encodeURIComponent(targetId)}`);
        if (value.appendMode === "continue" && !bodyRanges(target.bodyHtml).sentences.length) {
          await api(`/documents/${encodeURIComponent(target.id)}/sentences`, {method:"POST",body:JSON.stringify({revision:target.revision,bodyHash:target.bodyHash,force:false})});
          target = await api(`/documents/${encodeURIComponent(target.id)}`);
        }
        const source = value.sourceImageId || value.sourceImage?.id;
        let addition = blocksToHtml(value.blocks || parseText(value.content), {sourceImageId:source});
        const continuing = value.appendMode === "continue";
        if (continuing) {
          const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText(addition)));
          const bodyHash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2,"0")).join("");
          const segmented = await api(`/documents/${encodeURIComponent(target.id)}/sentences`, {
            method:"POST", body:JSON.stringify({revision:target.revision,bodyHash,bodyHtml:addition,sourceImages:[{id:source}],force:false}),
          });
          addition = segmented.bodyHtml;
        }
        const bodyHtml = appendBodyHtml(target.bodyHtml || blocksToHtml(target.blocks, {sourceImageId:target.sourceImageId}), addition, {continueLastSentence:continuing});
        next = { ...target, bodyHtml, content:serializeBlocks(htmlToBlocks(bodyHtml)),
          sourceImages: [...(target.sourceImages || (target.sourceImageId ? [{id:target.sourceImageId}] : [])), {id:source}],
          initializeSentences: !continuing, appendedImageId:source };
      }
      setPanel(null); setDraft(next); setEditorSession((n) => n + 1); setDirty(true);
    } catch (cause) { setError(cause.message); throw cause; }
  };
  const refreshCurrentDocument = async () => {
    if (!document?.id) return;
    const updated = await api(`/documents/${encodeURIComponent(document.id)}`);
    setDocument((current) => current?.id === updated.id ? updated : current);
  };
  const segmentDocument = async (target, force = true) => {
    setSegmentationBusy(true); setSegmentationError("");
    try {
      const result = await api(`/documents/${encodeURIComponent(target.id)}/sentences`, {
        method: "POST", body: JSON.stringify({ revision: target.revision, bodyHash: target.bodyHash, force }),
      });
      const updated = result.blocks ? result : await api(`/documents/${encodeURIComponent(target.id)}`);
      setDocument((current) => current?.id === target.id ? updated : current);
      return updated;
    } catch (cause) { setSegmentationError(`分句未完成，原文已保留：${cause.message}`); }
    finally { setSegmentationBusy(false); }
  };
  const save = async (value) => {
    if (saving) return;
    setSaving(true);
    setError("");
    try {
      const result = await api(
        value.id ? `/documents/${value.id}` : "/documents",
        {
          method: value.id ? "PUT" : "POST",
          body: JSON.stringify(value),
        },
      );
      const parent = result.bookId
        ? await api(`/books/${encodeURIComponent(result.bookId)}`).catch(() => null)
        : null;
      if (activeId !== result.id) savedDetail.current = result.id;
      setBook(parent);
      setDocument(result);
      setActiveId(result.id);
      history.replaceState(null, "", `#${result.id}`);
      setDraft(null);
      setDirty(false);
      setRefresh((n) => n + 1);
      setNotice(result.bookId ? "已保存到书籍" : "已保存到书架");
      if (!value.id || value.initializeSentences) await segmentDocument(result, false);
    } catch (e) {
      setError(e.message);
    } finally {
      setSaving(false);
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
            onCancel={closePanel}
            onReady={imageReady}
            onDirty={setDirty}
            articles={articleTargets}
            initialTargetId={appendTargetId}
          />
        ) : draft ? (
          <Editor
            key={editorSession}
            initial={draft}
            onSave={save}
            onCancel={cancelEdit}
            onDirty={(next = true) => setDirty(next)}
            saving={saving}
            books={books}
            onCreateBook={createBook}
          />
        ) : document ? (
          <div className={`reader-workspace ${panel === "chat" ? "has-chat" : ""}`}>
            <div className="reader-main-column">
              {book ? (
                <BookNavigation
                  book={book}
                  currentPageId={document.id}
                  onOpenBook={() => openBook(book.id)}
                  onOpenPage={openDocument}
                  onAddImage={() => beginBookPage(true)}
                  disabled={saving || bookBusy}
                />
              ) : document.bookId ? (
                <div className="book-promotion">
                  <button className="text-button" onClick={() => openBook(document.bookId)}>打开所属书籍</button>
                  <span>目录暂未加载，正文已保存，可重新打开书籍。</span>
                </div>
              ) : null}
              <Reader
                document={document}
                onEdit={beginEdit}
                onDelete={remove}
                onDiscuss={() => (panel === "chat" ? closePanel() : openPanel("chat"))}
                onAsk={(request) => { setChatRequest({...request,key:crypto.randomUUID()}); setSelectedGroupIds(null); setPanel("chat"); }}
                onGroup={(ids) => { setSelectedGroupIds(ids); setChatRequest(null); setPanel("chat"); }}
                onAppendImage={() => { openPanel("image"); setAppendTargetId(document.id); }}
                onSegment={() => segmentDocument(document, true)}
                segmentationBusy={segmentationBusy} segmentationError={segmentationError}
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
              />
            </div>
            {panel === "chat" && (
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
