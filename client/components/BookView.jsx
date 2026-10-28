import { useEffect, useState } from "react";

export default function BookView({
  book,
  onOpenPage,
  onAddImage,
  onAddText,
  onRename,
  onReorder,
  onDelete,
  busy = false,
}) {
  const [title, setTitle] = useState(book.title);
  const [error, setError] = useState("");
  const pages = book.pages;

  useEffect(() => {
    setTitle(book.title);
    setError("");
  }, [book.id, book.title]);

  const run = async (action) => {
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error.message || "操作未完成，请重试。");
    }
  };
  const movePage = (index, direction) => {
    const pageIds = pages.map((page) => page.id);
    const target = index + direction;
    [pageIds[index], pageIds[target]] = [pageIds[target], pageIds[index]];
    run(() => onReorder(pageIds));
  };

  return (
    <section className="book-page stage2-page" aria-busy={busy}>
      <div className="stage2-heading book-heading">
        <div>
          <span className="eyebrow">一本书，逐页读</span>
          <h1>{book.title}</h1>
          <p className="book-page-count">{pages.length} 页</p>
        </div>
        <div className="book-actions">
          <button type="button" className="button primary" disabled={busy} onClick={onAddImage}>
            添加图片页
          </button>
          <button type="button" className="button secondary" disabled={busy} onClick={onAddText}>
            添加文字页
          </button>
        </div>
      </div>
      <p className="stage2-description">
        每次导入一张图片，校对后存为一页。各页保留自己的正文、注音、原图和讨论，可按阅读顺序调整。
      </p>
      <form className="book-rename" onSubmit={(event) => {
        event.preventDefault();
        if (busy || !title.trim() || title.trim() === book.title) return;
        run(() => onRename(title.trim()));
      }}>
        <label>
          书籍名称
          <input value={title} onChange={(event) => setTitle(event.target.value)}
            maxLength={160} required disabled={busy} />
        </label>
        <button type="submit" className="button subtle"
          disabled={busy || !title.trim() || title.trim() === book.title}>
          保存书名
        </button>
      </form>
      {error && <p className="stage2-error" role="alert">{error}</p>}
      {pages.length ? (
        <ol className="book-page-list" aria-label="书籍页面列表">
          {pages.map((page, index) => (
            <li className="book-page-row" key={page.id}>
              <span className="book-page-number" aria-hidden="true">{index + 1}</span>
              <button type="button" className="book-page-open"
                aria-label={`打开第 ${index + 1} 页：${page.title}`}
                disabled={busy} onClick={() => onOpenPage(page.id)}>
                <strong>{page.title}</strong>
                <span>{page.sourceImageId ? "图片页" : "文字页"} · {page.charCount} 字 · {page.rubyCount} 处注音</span>
              </button>
              <div className="book-page-order">
                <button type="button" className="button subtle"
                  aria-label={`上移第 ${index + 1} 页`} disabled={busy || index === 0}
                  onClick={() => movePage(index, -1)}>
                  上移
                </button>
                <button type="button" className="button subtle"
                  aria-label={`下移第 ${index + 1} 页`} disabled={busy || index === pages.length - 1}
                  onClick={() => movePage(index, 1)}>
                  下移
                </button>
              </div>
            </li>
          ))}
        </ol>
      ) : (
        <div className="book-empty">
          <h2>先放进第一页</h2>
          <p>选择「添加图片页」导入一张照片或截图，也可以添加文字页。保存后就能在这里逐页阅读。</p>
        </div>
      )}
      <footer className="book-footer">
        <button type="button" className="text-button book-delete" disabled={busy}
          onClick={() => run(onDelete)}>
          删除书籍
        </button>
      </footer>
    </section>
  );
}
