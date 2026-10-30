import Icon from "./Icon.jsx";

export default function Welcome({
  onOpenBook,
  onOpenDocument,
  books = [],
  documents = [],
  loading = false,
  activeTaskCount = 0,
  taskCounts = {},
  onOpenTasks,
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
            <span>篇书中文章</span>
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

      {activeTaskCount > 0 && <button className="home-task-card" type="button" onClick={onOpenTasks} aria-label={`查看任务与导入草稿，共 ${activeTaskCount} 个`}>
        <Icon name="menu" size={22} />
        <span><strong>任务与导入草稿 <span className="count">{activeTaskCount}</span></strong><small>{(taskCounts.queued || 0) + (taskCounts.running || 0)} 个处理中 · {activeTaskCount - (taskCounts.queued || 0) - (taskCounts.running || 0)} 个待继续或校对</small></span>
        <Icon name="arrow" size={18} />
      </button>}

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
                      ? `书籍 · ${item.pageCount} 篇`
                      : "独立材料"}
                  </small>
                  <strong>{item.title}</strong>
                  <span lang="ja">
                    {item.preview?.replace(/\n/g, " ") || "打开书籍，添加下一篇"}
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
