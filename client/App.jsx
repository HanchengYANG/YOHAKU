import { useEffect, useRef, useState } from "react";
import api from "./api.mjs";
import { kinds, sample } from "./constants.mjs";
import Icon from "./components/Icon.jsx";
import Welcome from "./components/Welcome.jsx";
import Reader from "./components/Reader.jsx";
import Editor from "./components/Editor.jsx";
import AISettings from "./components/AISettings.jsx";
import ImageImport from "./components/ImageImport.jsx";
import DocumentChat from "./components/DocumentChat.jsx";
import AccountGate from "./components/AccountGate.jsx";
import UserMenu from "./components/UserMenu.jsx";

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

function Workspace({ user, onLoggedOut }) {
  const [documents, setDocuments] = useState([]);
  const [activeId, setActiveId] = useState(() => window.location.hash.slice(1));
  const [document, setDocument] = useState(null);
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
    new URLSearchParams(window.location.search).get("chatgpt") === "connected"
      ? "settings"
      : null,
  );
  const savedDetail = useRef(null);

  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(
      () => {
        api(`/documents?q=${encodeURIComponent(query)}`, {
          signal: controller.signal,
        })
          .then((data) => {
            setDocuments(data.documents);
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
    setDetailLoading(true);
    setDetailFailed(false);
    api(`/documents/${encodeURIComponent(activeId)}`, {
      signal: controller.signal,
    })
      .then(setDocument)
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
      if (saving) {
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
  }, [activeId, dirty, saving]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4500);
    return () => clearTimeout(timer);
  }, [notice]);

  const mayLeave = () =>
    !saving && (!dirty || window.confirm("当前修改还没有保存，确定离开吗？"));
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
  const beginEdit = () => {
    setDraft({ ...document });
    setEditorSession((n) => n + 1);
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
    if (!mayLeave()) return;
    setDraft(null);
    setPanel(name);
    setDirty(false);
    setError("");
    setSidebarOpen(false);
  };
  const closePanel = () => {
    if (!mayLeave()) return;
    setPanel(null);
    setDirty(false);
  };
  const imageReady = (value) => {
    setPanel(null);
    setDraft(value);
    setEditorSession((n) => n + 1);
    setDirty(true);
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
      if (activeId !== result.id) savedDetail.current = result.id;
      setDocument(result);
      setActiveId(result.id);
      history.replaceState(null, "", `#${result.id}`);
      setDraft(null);
      setDirty(false);
      setRefresh((n) => n + 1);
      setNotice("已保存到书架");
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
      setActiveId("");
      setPanel(null);
      setDocument(null);
      history.replaceState(null, "", window.location.pathname);
      setRefresh((n) => n + 1);
      setNotice("材料已删除");
    } catch (e) {
      setError(e.message);
    }
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
          <span>
            <strong>余白</strong>
            <small>日语阅读与笔记</small>
          </span>
        </a>
        <button
          className="button primary add-button"
          disabled={saving}
          onClick={() => beginNew()}
        >
          <Icon name="plus" size={18} />
          导入文字
        </button>
        <button
          className="button secondary"
          disabled={saving}
          onClick={() => openPanel("image")}
          style={{ marginTop: -24, marginBottom: 24 }}
        >
          导入图片
        </button>
        <button
          className="button subtle"
          disabled={saving}
          onClick={() => openPanel("settings")}
          style={{ marginBottom: 18 }}
        >
          AI 设置
        </button>
        <div className="shelf-heading">
          <span>
            <Icon name="book" size={16} />
            我的书架
          </span>
          <span className="count">{documents.length}</span>
        </div>
        <label className="search-box">
          <Icon name="search" size={16} />
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
          {!loading && documents.length === 0 && (
            <p className="shelf-empty">
              {query
                ? "没有找到匹配的材料。"
                : "还没有材料。\n从一段喜欢的日语开始。"}
            </p>
          )}
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
        <UserMenu
          user={user}
          onBeforeLogout={mayLeave}
          onLoggedOut={onLoggedOut}
        />
        <div className="sidebar-bottom">
          <span className="local-dot" />
          <span>
            本机书架<small>资料保存在当前电脑</small>
          </span>
          <span className="version">01</span>
        </div>
      </aside>
      <main className="main-panel">
        <header className="topbar">
          <div className="topbar-title">
            <button
              className="icon-button mobile-menu"
              aria-label="打开书架"
              onClick={() => setSidebarOpen(true)}
            >
              <Icon name="menu" />
            </button>
            <span>読む、わかる、残す。</span>
          </div>
          <span className="stage-tag">第二阶段 · AI 与图片识别</span>
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
        {panel === "settings" ? (
          <AISettings onClose={closePanel} />
        ) : panel === "image" ? (
          <ImageImport
            onCancel={closePanel}
            onReady={imageReady}
            onDirty={setDirty}
          />
        ) : panel === "chat" && document ? (
          <DocumentChat
            document={document}
            onClose={() => {
              setPanel(null);
              setDirty(false);
            }}
            onDirty={setDirty}
          />
        ) : draft ? (
          <Editor
            key={editorSession}
            initial={draft}
            onSave={save}
            onCancel={cancelEdit}
            onDirty={(next = true) => setDirty(next)}
            saving={saving}
          />
        ) : document ? (
          <Reader
            document={document}
            onEdit={beginEdit}
            onDelete={remove}
            onDiscuss={() => openPanel("chat")}
            showRuby={showRuby}
            setShowRuby={setShowRuby}
            fontSize={fontSize}
            setFontSize={setFontSize}
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
            onImport={() => beginNew()}
            onSample={() => beginNew(sample)}
            onImage={() => openPanel("image")}
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
