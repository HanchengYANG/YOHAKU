import { stats } from "../../shared/document.mjs";
import { kinds } from "../constants.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Reader({
  document,
  onEdit,
  onDelete,
  showRuby,
  setShowRuby,
  fontSize,
  setFontSize,
  onDiscuss,
}) {
  const counts = stats(document.blocks);
  const recognition = document.recognition;
  const warnings = Array.isArray(recognition?.warnings)
    ? recognition.warnings
    : [];
  const nonBody = Array.isArray(recognition?.nonBody)
    ? recognition.nonBody
    : [];
  const imageUrl = document.sourceImageId
    ? `/api/images/${encodeURIComponent(document.sourceImageId)}/raw`
    : null;
  return (
    <section className="reader-page">
      <div className="document-meta">
        <span className="kind-label">{kinds[document.kind]}</span>
        <span>{counts.charCount} 字</span>
        <span>{counts.rubyCount} 处注音</span>
      </div>
      <div className="reader-title-row">
        <h1>{document.title}</h1>
        <span className="saved-state">
          <Icon name="check" size={14} />
          已保存
        </span>
      </div>
      <div className="reader-toolbar">
        <button
          className={`button subtle ruby-toggle ${showRuby ? "selected" : ""}`}
          onClick={() => setShowRuby(!showRuby)}
          aria-pressed={showRuby}
        >
          <Icon name="type" size={17} />
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
        {onDiscuss && (
          <button
            className="button subtle reader-ai-action"
            onClick={onDiscuss}
          >
            <Icon name="arrow" size={16} />问 AI
          </button>
        )}
        <button className="button subtle edit-action" onClick={onEdit}>
          <Icon name="edit" size={17} />
          校对文字与注音
        </button>
      </div>
      <article
        className={`reading-sheet ${document.kind}`}
        aria-label="日语原文"
      >
        <RubyText
          blocks={document.blocks}
          showRuby={showRuby}
          fontSize={fontSize}
          orientation={document.orientation}
        />
      </article>
      {imageUrl && (
        <details className="reader-recognition-details">
          <summary>
            原图与初次识别记录
            {warnings.length ? ` · ${warnings.length} 条提示` : ""}
          </summary>
          <div className="reader-recognition-content">
            <a
              className="text-button"
              href={imageUrl}
              target="_blank"
              rel="noreferrer"
            >
              查看完整原图 <Icon name="arrow" size={14} />
            </a>
            {recognition?.readingOrder && (
              <p className="ocr-reading-order">
                <strong>识别时的阅读顺序：</strong>
                {recognition.readingOrder}
              </p>
            )}
            {warnings.length > 0 && (
              <>
                <p className="ocr-history-hint">
                  这是初次识别时的提示，已校正后的正文可能与原行号不同。
                </p>
                <ul className="ocr-saved-warnings">
                  {warnings.map((warning, index) => (
                    <li key={index}>
                      {Number.isInteger(warning.blockIndex)
                        ? `识别时第 ${warning.blockIndex + 1} 行：`
                        : ""}
                      {typeof warning === "string" ? warning : warning.message}
                    </li>
                  ))}
                </ul>
              </>
            )}
            {nonBody.length > 0 && (
              <div className="ocr-nonbody-list">
                <h3>与正文分开的内容</h3>
                {nonBody.map((item, index) => (
                  <div className="ocr-nonbody-item" key={index}>
                    <span>
                      {{
                        handwriting: "手写批注",
                        page_number: "页码",
                        other: "其他内容",
                      }[item.type] || "其他内容"}
                      {item.page === "right"
                        ? " · 右页"
                        : item.page === "left"
                          ? " · 左页"
                          : ""}
                    </span>
                    <p>{item.text}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </details>
      )}
      <footer className="reader-footer">
        <span>
          更新于{" "}
          {new Date(document.updatedAt).toLocaleString("zh-CN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </span>
        <div className="export-actions">
          <a
            className="text-button"
            href={`/api/documents/${document.id}/export?format=markdown`}
            download
          >
            <Icon name="down" size={16} />
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
