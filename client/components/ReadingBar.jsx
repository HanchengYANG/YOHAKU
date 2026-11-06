import { useEffect, useRef, useState } from "react";
import Icon from "./Icon.jsx";
import { readingPagePosition } from "../source-presentation.mjs";

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => { if (!ref.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    window.document.addEventListener("pointerdown", outside);
    window.document.addEventListener("keydown", escape);
    return () => {
      window.document.removeEventListener("pointerdown", outside);
      window.document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return { open, setOpen, ref };
}

// One thin bar above the reading column: back, title with the table of
// contents, and the reading tools. `pages` is null for single-page articles.
export default function ReadingBar({
  document, book = null, pages = null, onGoToPage, onOpenBook, onOpenShelf, onOpenArticle, onOpenSidebar,
  showRuby, setShowRuby, fontSize, setFontSize, onEdit, onDiscuss, chatOpen = false, chatCount = 0,
}) {
  const toc = usePopover(), font = usePopover();
  const bookPages = book?.pages || [];
  const pageList = pages?.list || [];
  const hasToc = bookPages.length > 1 || pageList.length > 1 || (pages && !pages.complete);
  const pageLabel = pages ? (pages.complete && pages.totalPages ? `${readingPagePosition(pages)} 页` : readingPagePosition(pages)) : "目录";
  const close = (action) => () => { toc.setOpen(false); action(); };
  return (
    <header className="reading-bar">
      <div className="reading-bar-start">
        <button type="button" className="icon-button reading-bar-shelf" aria-label="打开书架" onClick={onOpenSidebar}>
          <Icon name="panel-open" size={18} />
        </button>
        {document.bookId ? (
          <button type="button" className="text-button reading-bar-back" onClick={onOpenBook}
            aria-label={book ? `返回书籍：${book.title}` : "返回书籍"}>
            <Icon name="back" size={14} /><span>{book ? `《${book.title}》` : "书籍"}</span>
          </button>
        ) : (
          <button type="button" className="text-button reading-bar-back" onClick={onOpenShelf}>
            <Icon name="back" size={14} /><span>书架</span>
          </button>
        )}
      </div>
      <div className="reading-bar-title">
        <h1>{document.title}</h1>
        {hasToc && <div className="reading-bar-popover-anchor" ref={toc.ref}>
          <button type="button" className="reading-bar-pages" aria-haspopup="dialog" aria-expanded={toc.open}
            onClick={() => toc.setOpen(!toc.open)}>
            {pageLabel}<Icon name="chevron-down" size={14} />
          </button>
          {toc.open && <div className="reading-bar-popover reading-toc" role="dialog" aria-label="目录">
            {bookPages.length > 1 && <section>
              <h2>{book.title}</h2>
              <ol>{bookPages.map((page) => <li key={page.id}>
                <button type="button" className="text-button" aria-current={page.id === document.id ? "page" : undefined}
                  onClick={close(() => onOpenArticle(page.id))}>{page.title}</button>
              </li>)}</ol>
            </section>}
            {pageList.length > 0 && <section>
              <h2>本篇</h2>
              <ol>{pageList.map((item) => <li key={item.id}>
                <button type="button" className="text-button" aria-current={item.index === pages.index ? "page" : undefined}
                  onClick={close(() => onGoToPage(item.index))}>第 {item.index + 1} 页{item.ready ? "" : " · 准备中"}</button>
              </li>)}</ol>
              {!pages.complete && <p>后续页准备好后显示</p>}
            </section>}
          </div>}
        </div>}
      </div>
      <div className="reading-bar-tools">
        <button type="button" className={`reading-bar-tool ${showRuby ? "selected" : ""}`} aria-pressed={showRuby}
          onClick={() => setShowRuby(!showRuby)}>注音</button>
        <div className="reading-bar-popover-anchor" ref={font.ref}>
          <button type="button" className="reading-bar-tool" aria-haspopup="dialog" aria-expanded={font.open}
            onClick={() => font.setOpen(!font.open)}>字号</button>
          {font.open && <div className="reading-bar-popover reading-font" role="dialog" aria-label="字号">
            <input aria-label="阅读字号" type="range" min="18" max="34" step="2" value={fontSize}
              onChange={(event) => setFontSize(Number(event.target.value))} />
            <span>{fontSize}</span>
          </div>}
        </div>
        {onEdit && <button type="button" className="reading-bar-tool" onClick={onEdit}>校对</button>}
        {onDiscuss && <button type="button" className={`reading-bar-tool reader-ai-action ${chatOpen ? "selected" : ""}`}
          aria-pressed={chatOpen} aria-label={chatCount > 0 ? `对话，${chatCount} 组问答` : undefined} onClick={onDiscuss}>对话{chatCount > 0 && <span className="reading-bar-count">{chatCount}</span>}</button>}
      </div>
    </header>
  );
}
