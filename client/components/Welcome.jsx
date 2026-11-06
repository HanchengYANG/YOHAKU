import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import { continueReading, recentEntries } from "../library-model.mjs";

// Home: continue reading, imports that need the reader, then recent reading.
// Phones start with the photo action because they are mostly used for imports;
// welcome.css reorders the blocks there.
export default function Welcome({
  books = [],
  documents = [],
  articles = [],
  loading = false,
  error = "",
  attentionCount = 0,
  onOpenBook,
  onOpenDocument,
  onOpenTasks,
  onAddPhoto,
}) {
  const current = continueReading(articles, books);
  const recent = recentEntries(books, documents);
  const empty = !current && !recent.length;
  return (
    <section className="home" aria-label="阅读首页">
      <h1 className="sr-only">首页</h1>
      {error && <ErrorNotice error={error} />}
      <button className="home-photo-action" type="button" onClick={onAddPhoto}>
        <span aria-hidden="true">📷</span>拍照添加
      </button>
      {current ? (
        <section className="home-continue closed-book" aria-label="继续阅读">
          <div className="home-continue-copy">
            <span className="eyebrow">继续阅读</span>
            <h2>{current.document.title}</h2>
            {current.book && <p className="home-continue-book">{current.book.title}</p>}
            {current.progress && (
              <div className="home-continue-progress">
                <span>{current.progress.label}</span>
                {current.progress.percent !== null && <span className="home-progress-track" role="progressbar" aria-label="阅读进度"
                  aria-valuemin={1} aria-valuemax={current.progress.total} aria-valuenow={current.progress.page}>
                  <span style={{ width: `${current.progress.percent}%` }} />
                </span>}
              </div>
            )}
          </div>
          <button className="button primary" type="button" onClick={() => onOpenDocument(current.document.id)}>
            {current.resumed ? "继续阅读" : "开始阅读"}
            <Icon name="arrow" size={16} />
          </button>
        </section>
      ) : empty && !error && (
        <div className="home-library-empty">
          <span className="home-empty-mark" aria-hidden="true">本</span>
          <div>
            <h3>{loading ? "正在打开书架…" : "还没有材料"}</h3>
            {!loading && <p>点「添加」导入照片、PDF、EPUB 或文字。</p>}
          </div>
        </div>
      )}
      {attentionCount > 0 && (
        <button className="home-task-card" type="button" onClick={onOpenTasks}>
          <span>{attentionCount} 个导入需要你处理</span>
          <span className="home-task-link">查看<Icon name="arrow" size={14} /></span>
        </button>
      )}
      {recent.length > 0 && (
        <section className="home-recent" aria-label="最近阅读">
          <h2 className="home-section-title">最近阅读</h2>
          <div className="home-recent-grid">
            {recent.map((item, index) => (
              <button
                key={`${item.entryType}-${item.id}`}
                type="button"
                className={`home-reading-card home-reading-card-${index % 3}`}
                aria-label={`${item.entryType === "book" ? "打开书籍" : "继续阅读"}：${item.title}`}
                onClick={() => (item.entryType === "book" ? onOpenBook(item.id) : onOpenDocument(item.id))}
              >
                <span className="home-reading-spine" aria-hidden="true">
                  <span>{item.entryType === "book" ? "本" : "文"}</span>
                </span>
                <span className="home-reading-content">
                  <small>{item.entryType === "book" ? `书籍 · ${item.pageCount} 篇` : "文章"}</small>
                  <strong>{item.title}</strong>
                  <span lang="ja">{item.preview?.replace(/\n/g, " ") || ""}</span>
                  <span className="home-reading-bottom">
                    {(item.charCount || 0).toLocaleString("zh-CN")} 字
                    <Icon name="arrow" size={18} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
