import Icon from "./Icon.jsx";

export default function Welcome({
  onOpenBook,
  onOpenDocument,
  books = [],
  documents = [],
  loading = false,
}) {
  const recent = [
    ...books.map((item) => ({ ...item, entryType: "book" })),
    ...documents.map((item) => ({ ...item, entryType: "document" })),
  ]
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, 6);
  const pages = books.reduce((count, book) => count + book.pageCount, 0);
  const characters = [...books, ...documents].reduce(
    (count, item) => count + item.charCount,
    0,
  );

  return (
    <section className="welcome home-dashboard" aria-label="阅读首页">
      <div className="home-header-row">
        <section className="home-library-strip" aria-label="我的阅读资料">
          <div className="home-stat-cell">
            <span className="home-stat-mark">冊</span>
            <strong>{loading ? "—" : books.length}</strong>
            <span>本书籍</span>
          </div>
          <div className="home-stat-cell">
            <span className="home-stat-mark">頁</span>
            <strong>{loading ? "—" : pages}</strong>
            <span>页书中书页</span>
          </div>
          <div className="home-stat-cell">
            <span className="home-stat-mark">文</span>
            <strong>{loading ? "—" : documents.length}</strong>
            <span>篇独立材料</span>
          </div>
          <div className="home-stat-cell">
            <span className="home-stat-mark">字</span>
            <strong className="stat-accent">
              {loading ? "—" : characters.toLocaleString("zh-CN")}
            </strong>
            <span>总字数</span>
          </div>
        </section>
      </div>

      <section className="home-recent" aria-label="最近阅读">
        <div className="home-section-heading">
          <div>
            <h2>最近阅读</h2>
          </div>
        </div>
        {recent.length ? (
          <div className="home-recent-grid">
            {recent.map((item, index) => (
              <button
                key={`${item.entryType}-${item.id}`}
                className={`home-reading-card home-reading-card-${index % 3}`}
                aria-label={`${item.entryType === "book" ? "打开书籍" : "继续阅读"}：${item.title}`}
                onClick={() =>
                  item.entryType === "book"
                    ? onOpenBook(item.id)
                    : onOpenDocument(item.id)
                }
              >
                <span className="home-reading-spine" aria-hidden="true">
                  <span>{item.entryType === "book" ? "本" : "文"}</span>
                </span>
                <span className="home-reading-content">
                  <small>
                    {item.entryType === "book"
                      ? `书籍 · ${item.pageCount} 页`
                      : "独立材料"}
                  </small>
                  <strong>{item.title}</strong>
                  <span lang="ja">
                    {item.preview?.replace(/\n/g, " ") || "打开书籍，添加下一页"}
                  </span>
                  <span className="home-reading-bottom">
                    {item.charCount.toLocaleString("zh-CN")} 字
                    <Icon name="arrow" size={18} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="home-library-empty">
            <span className="home-empty-mark" aria-hidden="true">
              本
            </span>
            <div>
              <h3>{loading ? "正在整理书架…" : "暂无阅读记录"}</h3>
              <p>从左侧书架导入图片、导入文字或新建书籍后，最近的阅读记录会显示在这里。</p>
            </div>
          </div>
        )}
      </section>
    </section>
  );
}
