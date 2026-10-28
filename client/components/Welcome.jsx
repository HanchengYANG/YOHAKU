import { parseText } from "../../shared/document.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";
import readingRoom from "../assets/reading-room.webp";
import studyDetail from "../assets/study-detail.webp";

const readingPreview = parseText("{今日|きょう}も、{少し|すこし}ずつ。\n{好き|すき}な{言葉|ことば}を、{自分|じぶん}のものに。");

export default function Welcome({
  onImport, onSample, onImage, onCreateBook, onOpenBook, onOpenDocument,
  books = [], documents = [], loading = false,
}) {
  const recent = [
    ...books.map((item) => ({ ...item, entryType: "book" })),
    ...documents.map((item) => ({ ...item, entryType: "document" })),
  ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 3);
  const pages = books.reduce((count, book) => count + book.pageCount, 0);
  const characters = [...books, ...documents].reduce((count, item) => count + item.charCount, 0);
  const day = new Intl.DateTimeFormat("zh-CN", { month: "long", day: "numeric", weekday: "long" }).format(new Date());

  return (
    <section className="welcome home-dashboard" aria-label="阅读首页">
      <div className="home-intro">
        <div><span className="home-eyebrow">YOHAKU / 私の読書室</span><p>给喜欢的日语，留一点余白。</p></div>
        <span className="home-date">{day}</span>
      </div>
      <div className="home-hero">
        <div className="home-hero-copy">
          <span className="home-chapter"><span /> 翻开今天的第一行</span>
          <h1>从一段想读的<br />日语开始<span>。</span></h1>
          <p className="home-hero-description">一张书页、一首歌词，或是一段让你停下来的话。<br />放进余白，把读音读懂，再慢慢读下去。</p>
          <div className="home-primary-actions">
            <button className="button primary large" onClick={onImage}><Icon name="plus" size={18} />导入图片</button>
            <button className="button secondary large" onClick={onImport}>导入第一篇文字<Icon name="arrow" size={17} /></button>
          </div>
          <span className="home-input-hint">照片、截图、文字，都能成为下一页。</span>
          <div className="home-hero-footnote"><span lang="ja">読む、わかる、残す。</span><span>阅读 · 理解 · 留下</span></div>
        </div>
        <div className="home-hero-art">
          <img src={readingRoom} alt="午后书桌上的书页与茶" className="home-hero-photo" fetchPriority="high" />
          <div className="home-photo-caption"><span>日々の読書</span><span>把阅读，放回日常。</span></div>
          <div className="home-photo-note" aria-hidden="true"><span>余白の時間</span><strong>下一页，<br />慢慢来。</strong></div>
        </div>
      </div>
      <div className="home-library-strip" aria-label="我的阅读资料">
        <div><Icon name="book" size={20} /><strong>{loading ? "—" : books.length}</strong><span>本书籍</span></div>
        <div><span className="home-stat-mark">頁</span><strong>{loading ? "—" : pages}</strong><span>页已收进书中</span></div>
        <div><span className="home-stat-mark">文</span><strong>{loading ? "—" : documents.length}</strong><span>篇独立材料</span></div>
        <p>{loading ? "正在打开你的书架…" : characters ? `已经收藏 ${characters.toLocaleString("zh-CN")} 字，等你接着读。` : "书架里的第一页，从今天开始。"}</p>
      </div>
      <section className="home-recent" aria-label="最近阅读">
        <div className="home-section-heading">
          <div><span className="home-eyebrow">YOUR LIBRARY</span><h2>接着上次的那一页</h2></div>
          <button className="text-button" onClick={onCreateBook}>创建一本书<Icon name="plus" size={15} /></button>
        </div>
        {recent.length ? (
          <div className="home-recent-grid">
            {recent.map((item, index) => (
              <button key={`${item.entryType}-${item.id}`} className={`home-reading-card home-reading-card-${index}`}
                aria-label={`${item.entryType === "book" ? "打开书籍" : "继续阅读"}：${item.title}`}
                onClick={() => item.entryType === "book" ? onOpenBook(item.id) : onOpenDocument(item.id)}>
                <span className="home-reading-spine" aria-hidden="true"><span>{item.entryType === "book" ? "本" : "文"}</span></span>
                <span className="home-reading-content">
                  <small>{item.entryType === "book" ? `书籍 · ${item.pageCount} 页` : "独立材料"}</small>
                  <strong>{item.title}</strong>
                  <span lang="ja">{item.preview?.replace(/\n/g, " ") || "打开书籍，添加下一页"}</span>
                  <span className="home-reading-bottom">{item.charCount.toLocaleString("zh-CN")} 字<Icon name="arrow" size={18} /></span>
                </span>
              </button>
            ))}
          </div>
        ) : (
          <div className="home-library-empty">
            <span className="home-empty-mark" aria-hidden="true">本</span>
            <div><h3>{loading ? "正在整理书架…" : "一本书，可以从一张照片开始。"}</h3><p>先起个名字，再把想读的书页一张张加进来。</p></div>
            <button className="button secondary" onClick={onCreateBook}>创建一本书<Icon name="arrow" size={16} /></button>
          </div>
        )}
      </section>
      <div className="home-bottom-grid">
        <section className="home-ruby-card" aria-label="振假名排版示例">
          <div className="home-section-heading"><div><span className="home-eyebrow">FURIGANA / ふりがな</span><h2>让读音，回到字词上方。</h2></div><span className="home-card-index">01</span></div>
          <RubyText blocks={readingPreview} fontSize={23} />
          <div className="home-ruby-footer"><span>读音可校对，原文始终在身边。</span><button className="text-button" onClick={onSample}>试试注音示例<Icon name="arrow" size={16} /></button></div>
        </section>
        <section className="home-study-card">
          <img src={studyDetail} alt="书本与书签的阅读静物" className="home-study-photo" loading="lazy" />
          <div className="home-study-copy"><span className="home-eyebrow">ONE PAGE AT A TIME</span><h2>读过的每一页，<br />都留在自己的书架。</h2><p>原图、正文、读音和讨论，一起保存。</p><button className="text-button" onClick={onCreateBook}>给新书留个位置<Icon name="arrow" size={16} /></button></div>
        </section>
      </div>
      <p className="home-privacy-note"><span /> 你的私人阅读空间 · 资料保存在这台电脑</p>
    </section>
  );
}
