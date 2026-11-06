import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { blocksToHtml, bodyRanges, hasCompleteSentenceBoundaries } from "../../shared/article-html.mjs";
import ArticleBody from "./ArticleBody.jsx";
import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";

// The article body with selection questions and the footer. The title and
// reading tools live in ReadingBar.
export default function Reader({
  document,
  onDelete,
  showRuby,
  fontSize,
  answering = false,
  onPromoteBook = null,
  onAsk, onGroup, onSegment, segmentationBusy, segmentationError, headingSourceIds,
  afterBody = null,
}) {
  const [selection, setSelection] = useState(null);
  const [customQuestion, setCustomQuestion] = useState("");
  const [custom, setCustom] = useState(false);
  const popover = useRef(null);
  const [placement, setPlacement] = useState(null);
  const html = document.bodyHtml || blocksToHtml(document.blocks);
  useEffect(() => { setSelection(null); setCustom(false); }, [document.id, document.bodyHtml]);
  // Prefer the space above the selection so the popover does not cover the
  // sentence being asked about.
  useLayoutEffect(() => {
    if (!selection) { setPlacement(null); return; }
    const height = popover.current?.offsetHeight || 90, width = popover.current?.offsetWidth || 340;
    const above = selection.rect.top - height - 8;
    const top = above >= 12 ? above : Math.max(12, Math.min(selection.rect.bottom + 8, window.innerHeight - height - 12));
    setPlacement({ top, left: Math.max(12, Math.min(selection.rect.left, window.innerWidth - width - 12)) });
  }, [selection, custom]);
  if (!hasCompleteSentenceBoundaries(html)) return null;
  const ask = (operation) => {
    if (!selection || answering) return;
    const { rect, ...reference } = selection;
    reference.bodyHash = document.bodyHash;
    reference.sentenceIds = bodyRanges(html).sentences.filter((item) => item.start < selection.end && item.end > selection.start).map((item) => item.id);
    onAsk?.({ selection: reference, operation, question: operation === "custom" ? customQuestion.trim() : undefined });
    setSelection(null); setCustom(false); setCustomQuestion("");
  };
  return (
    <section className="reader-page">
      {onSegment && <div className="sentence-actions">
        <button type="button" className="text-button" disabled={segmentationBusy} onClick={onSegment}>
          {segmentationBusy ? "正在分句…" : bodyRanges(html).sentences.length ? "重新分句" : "初始化分句"}
        </button>
        {segmentationError && <ErrorNotice error={segmentationError} />}
      </div>}
      <article
        className={`reading-sheet ${document.kind}`}
        aria-label="日语原文"
      >
        <ArticleBody html={html} headingSourceIds={headingSourceIds} showRuby={showRuby} fontSize={fontSize}
          onSelection={setSelection} onGroup={onGroup} />
      </article>
      {afterBody}
      {selection && <div ref={popover} className="selection-questions" role="dialog" aria-label="划词提问"
        style={placement || { top: 0, left: 0, visibility: "hidden" }}>
        <strong lang={answering ? undefined : "ja"}>{answering ? "正在回答上一问…" : selection.text.length > 36 ? `${selection.text.slice(0, 36)}…` : selection.text}</strong>
        <div className="selection-actions">
          <button className="selection-pill" type="button" disabled={answering} onMouseDown={(e) => e.preventDefault()} onClick={() => ask("translation")}>翻译</button>
          <button className="selection-pill" type="button" disabled={answering} onMouseDown={(e) => e.preventDefault()} onClick={() => ask("grammar")}>讲解语法</button>
          <button className="selection-pill" type="button" disabled={answering} aria-pressed={custom} onClick={() => setCustom(true)}>提问…</button>
          <button className="icon-button" type="button" aria-label="关闭划词提问" onClick={() => setSelection(null)}>×</button>
        </div>
        {custom && <form onSubmit={(e) => { e.preventDefault(); if(customQuestion.trim()) ask("custom"); }}>
          <input aria-label="选区自定义问题" autoFocus disabled={answering} value={customQuestion} maxLength={4000} onChange={(e) => setCustomQuestion(e.target.value)} />
          <button className="button primary" disabled={answering || !customQuestion.trim()}>发送</button>
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
