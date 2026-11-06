import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import { articleRowState, bookFacts, bookResume, documentTaskStates } from "../library-model.mjs";

// Book page: a cover with the title, a ⋯ menu (rename, reorder, delete), one
// primary action, then the article list. Each row shows a single state, and
// the article the primary action resumes carries the bookmark ribbon.
export default function BookView({
  book,
  onOpenShelf,
  onOpenPage,
  onAddArticle,
  onRename,
  onReorder,
  onDelete,
  busy = false,
  taskCounts = {},
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState(null);
  const [title, setTitle] = useState(book.title);
  const [error, setError] = useState(null);
  const [taskStates, setTaskStates] = useState(() => new Map());
  const menu = useRef(null);
  const menuButton = useRef(null);
  const list = useRef(null);
  // Returns the element to focus once the page is no longer busy: controls are
  // disabled while a change saves, so focusing them right away would not stick.
  const focusAfter = useRef(null);
  const pages = book.pages;
  const resume = bookResume(book);
  const resumedId = resume?.page.readingPosition?.updatedAt ? resume.page.id : null;

  useEffect(() => {
    setTitle(book.title);
    setError(null);
    setMode(null);
    setMenuOpen(false);
  }, [book.id]);
  // Refetch when the polled counts change, e.g. when a preparation finishes or fails.
  useEffect(() => {
    const controller = new AbortController();
    api("/tasks?scope=active&limit=100", { signal: controller.signal })
      .then((result) => setTaskStates(documentTaskStates(result?.tasks)))
      .catch(() => { /* Without tasks the rows still show the page or length. */ });
    return () => controller.abort();
  }, [book.id, taskCounts.active, taskCounts.attention]);
  // Same disclosure behaviour as the account menu: outside press and Escape
  // close it, and Escape hands focus back to the ⋯ button.
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event) => {
      if (!menu.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = (event) => {
      if (event.key !== "Escape") return;
      setMenuOpen(false);
      menuButton.current?.focus();
    };
    window.document.addEventListener("pointerdown", outside);
    window.document.addEventListener("keydown", escape);
    return () => {
      window.document.removeEventListener("pointerdown", outside);
      window.document.removeEventListener("keydown", escape);
    };
  }, [menuOpen]);
  useEffect(() => {
    if (busy || !focusAfter.current) return;
    const target = focusAfter.current();
    focusAfter.current = null;
    target?.focus();
  });

  const run = async (action) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    }
  };
  const finish = () => {
    focusAfter.current = () => menuButton.current;
    setMode(null);
  };
  const choose = (next) => {
    setMenuOpen(false);
    // The confirmation dialog returns focus to the element focused when it
    // opened; the menu items disappear, so hand focus to the ⋯ button first.
    menuButton.current?.focus();
    if (next === "delete") void run(onDelete);
    else {
      if (next === "rename") setTitle(book.title);
      setMode(next);
    }
  };
  const rename = async (event) => {
    event.preventDefault();
    const next = title.trim();
    if (busy || !next) return;
    if (next === book.title || (await run(() => onRename(next)))) finish();
  };
  const movePage = (index, direction) => {
    const pageIds = pages.map((page) => page.id);
    const target = index + direction;
    const moved = pageIds[index];
    [pageIds[index], pageIds[target]] = [pageIds[target], pageIds[index]];
    // Keep keyboard focus on the moved article, on the same arrow while it is usable.
    focusAfter.current = () => {
      const row = [...(list.current?.children || [])].find((item) => item.dataset.pageId === moved);
      const buttons = [...(row?.querySelectorAll(".book-page-order button") || [])];
      const same = buttons[direction < 0 ? 0 : 1];
      return same && !same.disabled ? same : buttons.find((button) => !button.disabled);
    };
    void run(() => onReorder(pageIds));
  };

  return (
    <section className="book-page stage2-page" aria-busy={busy}>
      <nav className="book-breadcrumb" aria-label="位置">
        <button type="button" className="text-button" onClick={onOpenShelf}>
          <Icon name="back" size={14} />书架
        </button>
      </nav>
      <div className="book-cover">
        <div className="book-title-row">
          <h1>{book.title}</h1>
          <div className="book-menu" ref={menu}>
            <button ref={menuButton} type="button" className="icon-button" aria-label="书籍操作"
              aria-expanded={menuOpen} aria-controls={menuOpen ? "book-menu" : undefined}
              disabled={busy} onClick={() => setMenuOpen((value) => !value)}>
              <Icon name="more" size={18} />
            </button>
            {menuOpen && (
              <div className="book-menu-panel" id="book-menu">
                <button type="button" onClick={() => choose("rename")}>重命名</button>
                <button type="button" disabled={pages.length < 2} onClick={() => choose("reorder")}>调整顺序</button>
                <button type="button" className="book-delete" onClick={() => choose("delete")}>删除书籍</button>
              </div>
            )}
          </div>
        </div>
        <p className="book-facts">{bookFacts(book)}</p>
        {mode === "rename" && (
          <form className="book-rename" onSubmit={rename}
            onKeyDown={(event) => { if (event.key === "Escape" && !busy) finish(); }}>
            <label>
              书名
              <input value={title} onChange={(event) => setTitle(event.target.value)}
                maxLength={160} required autoFocus disabled={busy} />
            </label>
            <button type="submit" className="button primary" disabled={busy || !title.trim()}>保存</button>
            <button type="button" className="button subtle" disabled={busy} onClick={finish}>取消</button>
          </form>
        )}
        <div className="book-actions">
          {resume && (
            <button type="button" className="button primary" disabled={busy} onClick={() => onOpenPage(resume.page.id)}>
              <span>{resume.label}</span>
            </button>
          )}
          <button type="button" className="button secondary" disabled={busy} onClick={onAddArticle}>
            <Icon name="plus" size={15} />添加文章
          </button>
        </div>
      </div>
      {error && <ErrorNotice error={error} />}
      {mode === "reorder" && (
        <div className="book-reorder-bar">
          <span>调整顺序</span>
          <button type="button" className="button secondary" disabled={busy} onClick={finish}>完成</button>
        </div>
      )}
      {pages.length ? (
        <ol className="book-page-list" aria-label="书籍文章列表" ref={list}>
          {pages.map((page, index) => {
            const state = articleRowState(page, taskStates.get(page.id));
            return (
              <li className={`book-page-row${page.id === resumedId ? " is-current" : ""}`}
                key={page.id} data-page-id={page.id}>
                <span className="book-page-number" aria-hidden="true">{index + 1}</span>
                <button type="button" className="book-page-open"
                  aria-label={`打开第 ${index + 1} 篇：${page.title}`}
                  aria-describedby={`book-page-state-${page.id}`}
                  disabled={busy} onClick={() => onOpenPage(page.id)}>
                  <strong>{page.title}</strong>
                  <span className="book-page-leader" aria-hidden="true" />
                  <span id={`book-page-state-${page.id}`} className={`book-page-state is-${state.kind}`}>{state.label}</span>
                </button>
                {mode === "reorder" && (
                  <div className="book-page-order">
                    <button type="button" className="button subtle" aria-label={`上移第 ${index + 1} 篇`}
                      disabled={busy || index === 0} onClick={() => movePage(index, -1)}>上移</button>
                    <button type="button" className="button subtle" aria-label={`下移第 ${index + 1} 篇`}
                      disabled={busy || index === pages.length - 1} onClick={() => movePage(index, 1)}>下移</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="book-empty">还没有文章</p>
      )}
    </section>
  );
}
