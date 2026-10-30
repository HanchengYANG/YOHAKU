import { useEffect, useState } from "react";
import { blocksToHtml, bodyRanges } from "../../shared/article-html.mjs";
import ArticleBody from "./ArticleBody.jsx";
import { stats } from "../../shared/document.mjs";
import { kinds } from "../constants.mjs";
import Icon from "./Icon.jsx";

export default function Reader({
  document,
  onEdit,
  onDelete,
  showRuby,
  setShowRuby,
  fontSize,
  setFontSize,
  onDiscuss,
  chatOpen = false,
  onPromoteBook = null,
  onAsk, onGroup, onAppendImage, onSegment, segmentationBusy, segmentationError,
}) {
  const counts = stats(document.blocks);
  const [selection, setSelection] = useState(null);
  const [customQuestion, setCustomQuestion] = useState("");
  const [custom, setCustom] = useState(false);
  const html = document.bodyHtml || blocksToHtml(document.blocks);
  useEffect(() => { setSelection(null); setCustom(false); }, [document.id, document.bodyHtml]);
  const ask = (operation) => {
    if (!selection) return;
    const { rect, ...reference } = selection;
    reference.bodyHash = document.bodyHash;
    reference.sentenceIds = bodyRanges(html).sentences.filter((item) => item.start < selection.end && item.end > selection.start).map((item) => item.id);
    onAsk?.({ selection: reference, operation, question: operation === "custom" ? customQuestion.trim() : undefined });
    setSelection(null); setCustom(false); setCustomQuestion("");
  };
  return (
    <section className="reader-page">
      <div className="document-meta">
        <span className="kind-label">{kinds[document.kind]}</span>
        <span>{counts.charCount} 字</span>
        <span>{counts.rubyCount} 处注音</span>
        <span className="saved-state">
          <Icon name="check" size={14} />
          已保存
        </span>
      </div>
      <div className="reader-title-row">
        <h1>{document.title}</h1>
      </div>
      <div className="reader-toolbar">
        <div className="reader-toolbar-main">
          <button
            className={`button subtle ruby-toggle ${showRuby ? "selected" : ""}`}
            onClick={() => setShowRuby(!showRuby)}
            aria-pressed={showRuby}
          >
            <Icon name="type" size={16} />
            {showRuby ? "隐藏注音" : "显示注音"}
          </button>
          <label className="font-control">
            字号
            <input
              aria-label="阅读字号"
              type="range"
              min="18"
              max="34"
              step="2"
              value={fontSize}
              onChange={(e) => setFontSize(Number(e.target.value))}
            />
            <span>{fontSize}</span>
          </label>
        </div>
        <div className="reader-toolbar-actions">
          <button className="button subtle edit-action" onClick={onEdit}>
            <Icon name="edit" size={16} />
            校对文字与注音
          </button>
          {onDiscuss && (
            <button
              className={`button ${chatOpen ? "primary" : "secondary"} reader-ai-action`}
              aria-pressed={chatOpen}
              onClick={onDiscuss}
            >
              <Icon name="arrow" size={15} />对话记录
            </button>
          )}
        </div>
      </div>
      {onSegment && <div className="sentence-actions">
        <button type="button" className="text-button" disabled={segmentationBusy} onClick={onSegment}>
          {segmentationBusy ? "正在分句…" : bodyRanges(html).sentences.length ? "重新分句" : "初始化分句"}
        </button>
        {onAppendImage && <button type="button" className="text-button" onClick={onAppendImage}>追加来源图片</button>}
        {segmentationError && <span role="alert">{segmentationError}</span>}
      </div>}
      <article
        className={`reading-sheet ${document.kind}`}
        aria-label="日语原文"
      >
        <ArticleBody html={html} showRuby={showRuby} fontSize={fontSize}
          onSelection={setSelection} onGroup={onGroup} />
      </article>
      {selection && <div className="selection-questions" role="dialog" aria-label="划词提问"
        style={{ left: Math.max(12, Math.min(selection.rect.left, window.innerWidth - 310)), top: Math.max(12, Math.min(selection.rect.bottom + 8, window.innerHeight - (custom ? 190 : 100))) }}>
        <strong lang="ja">{selection.text.length > 36 ? `${selection.text.slice(0, 36)}…` : selection.text}</strong>
        <div className="selection-actions">
          <button className="button subtle" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ask("translation")}>翻译</button>
          <button className="button subtle" type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => ask("grammar")}>解释语法</button>
          <button className="button subtle" type="button" onClick={() => setCustom(true)}>自定义问题</button>
          <button className="icon-button" type="button" aria-label="关闭划词提问" onClick={() => setSelection(null)}>×</button>
        </div>
        {custom && <form onSubmit={(e) => { e.preventDefault(); if(customQuestion.trim()) ask("custom"); }}>
          <input aria-label="选区自定义问题" autoFocus value={customQuestion} maxLength={4000} onChange={(e) => setCustomQuestion(e.target.value)} />
          <button className="button primary" disabled={!customQuestion.trim()}>发送</button>
        </form>}
      </div>}
      <footer className="reader-footer">
        <span>
          更新于{" "}
          {new Date(document.updatedAt).toLocaleString("zh-CN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
        <div className="export-actions">
          {onPromoteBook && (
            <button
              type="button"
              className="text-button promote-book-button"
              onClick={onPromoteBook}
            >
              转为书籍
            </button>
          )}
          <a
            className="text-button"
            href={`/api/documents/${document.id}/export?format=markdown`}
            download
          >
            <Icon name="down" size={15} />
            Markdown
          </a>
          <a
            className="text-button"
            href={`/api/documents/${document.id}/export?format=json`}
            download
          >
            JSON
          </a>
          <button
            className="icon-button delete-button"
            aria-label="删除材料"
            title="删除材料"
            onClick={onDelete}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      </footer>
    </section>
  );
}
