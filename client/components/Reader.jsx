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
}) {
  const counts = stats(document.blocks);
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
