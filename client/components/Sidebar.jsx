import Icon from "./Icon.jsx";
import UserMenu from "./UserMenu.jsx";
import { kinds } from "../constants.mjs";

// The bookshelf column: add, tasks, the shelf with search, and the account
// menu. On phones the same column opens as a drawer.
export default function Sidebar({
  user, open, onClose, collapseButtonRef, onCollapse,
  saving, bookBusy, activeId, activeBookId,
  shelfBooks, documents, loading, query, onQueryChange, taskCount = 0,
  onHome, onAdd, onNewBook, onTasks, onOpenBook, onOpenDocument, onOpenPanel,
  onBeforeLogout, onLoggedOut,
}) {
  const onTasksPage = activeId === "tasks" || activeId.startsWith("tasks/");
  return (
    <>
      {open && <button className="sidebar-backdrop" onClick={onClose} aria-label="关闭书架" />}
      <aside id="bookshelf" className={`sidebar ${open ? "is-open" : ""}`} aria-label="书架">
        <button ref={collapseButtonRef} className="icon-button desktop-sidebar-collapse"
          type="button" aria-label="收起书架" aria-controls="bookshelf" aria-expanded="true"
          onClick={onCollapse}>
          <Icon name="panel-close" size={18} />
        </button>
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); onHome(); }}>
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
          <button className="button primary sidebar-primary-action" type="button" disabled={saving} onClick={onAdd}>
            <Icon name="plus" size={16} />添加
          </button>
          <button className={`sidebar-task-link ${onTasksPage ? "active" : ""}`} type="button"
            aria-label={taskCount > 0 ? `任务，${taskCount} 个需要处理` : undefined}
            aria-current={onTasksPage ? "page" : undefined} disabled={saving || bookBusy} onClick={onTasks}>
            <Icon name="menu" size={16} />
            <span>任务</span>
            {taskCount > 0 && <span className="count">{taskCount}</span>}
          </button>
        </div>
        <div className="shelf-heading">
          <h2>书架</h2>
          <button className="icon-button shelf-new-book" type="button" aria-label="新建书籍" title="新建书籍"
            disabled={saving || bookBusy} onClick={onNewBook}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <label className="search-box">
          <Icon name="search" size={15} />
          <input aria-label="搜索书架" placeholder="搜索标题或正文" value={query}
            onChange={(event) => onQueryChange(event.target.value)} maxLength={200} />
        </label>
        <nav className="document-list" aria-label="阅读材料">
          {loading && <p className="shelf-empty">正在打开书架…</p>}
          {!loading && documents.length === 0 && shelfBooks.length === 0 && (
            <p className="shelf-empty">{query ? "没有找到匹配的材料。" : "还没有材料。"}</p>
          )}
          {shelfBooks.map((item) => (
            <button className={`document-link ${item.id === activeBookId ? "active" : ""}`} key={`book-${item.id}`}
              aria-current={item.id === activeBookId ? (activeId === `book/${item.id}` ? "page" : "true") : undefined}
              type="button" disabled={saving || bookBusy} onClick={() => onOpenBook(item.id)}>
              <span className="document-link-top">
                <span className="kind-dot book" />书籍
                <span>{item.pageCount} 篇 · {item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview?.replace(/\n/g, " ") || "还没有文章"}</small>
            </button>
          ))}
          {documents.map((item) => (
            <button className={`document-link ${item.id === activeId ? "active" : ""}`} key={item.id}
              aria-current={item.id === activeId ? "page" : undefined}
              type="button" disabled={saving} onClick={() => onOpenDocument(item.id)}>
              <span className="document-link-top">
                <span className={`kind-dot ${item.kind}`} />
                {kinds[item.kind]}
                <span>{item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview?.replace(/\n/g, " ")}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <UserMenu user={user} disabled={saving} onOpenPanel={onOpenPanel}
            onBeforeLogout={onBeforeLogout} onLoggedOut={onLoggedOut} />
        </div>
      </aside>
    </>
  );
}
