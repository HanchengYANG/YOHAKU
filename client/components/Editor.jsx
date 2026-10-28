import { useMemo, useRef, useState } from "react";
import {
  parseText,
  plainText,
  serializeBlocks,
  stats,
  annotateBlocks,
  editPlainText,
  findTextOccurrences,
  annotateOccurrences,
} from "../../shared/document.mjs";
import { kinds } from "../constants.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Editor({ initial, onSave, onCancel, onDirty, saving }) {
  const [value, setValue] = useState(initial);
  const [blocks, setBlocks] = useState(() =>
    parseText(initial.content, initial.blocks || []),
  );
  const [selection, setSelection] = useState(null);
  const [reading, setReading] = useState("");
  const [message, setMessage] = useState("");
  const [tab, setTab] = useState("text");
  const [batchTerm, setBatchTerm] = useState("");
  const [batchSearch, setBatchSearch] = useState(null);
  const [batchSelected, setBatchSelected] = useState([]);
  const [batchReading, setBatchReading] = useState("");
  const sourceImageId =
    initial.sourceImageId || initial.recognition?.sourceImage?.id;
  const recognition = initial.recognition || initial;
  const warnings = Array.isArray(recognition.warnings)
    ? recognition.warnings
    : [];
  const nonBody = Array.isArray(recognition.nonBody) ? recognition.nonBody : [];
  const [previewMode, setPreviewMode] = useState(
    sourceImageId ? "image" : "reading",
  );
  const [imageError, setImageError] = useState(false);
  const [imageSize, setImageSize] = useState(null);
  const [imageRotation, setImageRotation] = useState(0);
  const [imageZoom, setImageZoom] = useState(100);
  const imageSideways = imageRotation % 2 === 1;
  const imageUrl = sourceImageId
    ? `/api/images/${encodeURIComponent(sourceImageId)}/raw`
    : null;
  const textarea = useRef(null);
  const readingInput = useRef(null);
  const body = plainText(blocks);
  const counts = stats(blocks);
  const batchResults = useMemo(
    () => (batchSearch ? findTextOccurrences(blocks, batchSearch.query) : []),
    [blocks, batchSearch],
  );
  const batchAvailable = batchResults.filter((item) => item.canAnnotate);
  const allBatchSelected =
    batchAvailable.length > 0 && batchSelected.length === batchAvailable.length;
  const update = (patch) => {
    setValue((old) => ({ ...old, ...patch }));
    onDirty();
  };
  const updateBlocks = (next) => {
    setBlocks(next);
    setSelection(null);
    setBatchSelected([]);
    setBatchSearch((old) => old && { query: old.query, blocks: next });
    onDirty();
  };
  const findBatch = (query = batchTerm) => {
    const term = query.trim();
    try {
      findTextOccurrences(blocks, term);
      setBatchTerm(term);
      setBatchSelected([]);
      setBatchSearch({ query: term, blocks });
      setMessage("");
    } catch (error) {
      setMessage(error.message);
    }
  };
  const applyBatch = () => {
    try {
      if (!batchSearch || batchSearch.blocks !== blocks)
        throw new Error("正文已变化，请重新查找并选择要修改的位置。");
      const count = batchSelected.length;
      const next = annotateOccurrences(
        blocks,
        batchSearch.query,
        batchSelected,
        batchReading,
      );
      updateBlocks(next);
      setMessage(`已为选中的 ${count} 处设置手动注音，其余位置保持原样。`);
    } catch (error) {
      setMessage(error.message);
    }
  };
  const editBody = (text) => {
    const result = editPlainText(blocks, text);
    updateBlocks(result.blocks);
    if (result.removed)
      setMessage(
        `正文变化影响了 ${result.removed} 处注音，已移除对应读音，请重新校正。`,
      );
  };
  const getSelection = () => {
    const el = textarea.current;
    if (el && el.selectionEnd > el.selectionStart) {
      setSelection({
        start: el.selectionStart,
        end: el.selectionEnd,
        text: el.value.slice(el.selectionStart, el.selectionEnd),
      });
    } else setSelection(null);
  };
  const applyReading = () => {
    try {
      if (!selection) throw new Error("先在正文中选中要标注的字词。");
      if (!reading.trim()) throw new Error("请输入假名读音。");
      updateBlocks(
        annotateBlocks(blocks, selection.start, selection.end, reading),
      );
      setReading("");
      setMessage("已添加注音，可在右侧预览。");
    } catch (e) {
      setMessage(e.message);
    }
  };
  const changeReading = (blockIndex, segmentIndex, text) => {
    const next = structuredClone(blocks);
    next[blockIndex].segments[segmentIndex].reading = text;
    next[blockIndex].segments[segmentIndex].origin =
      text !== null ? "manual" : null;
    updateBlocks(next);
  };
  const rubies = blocks.flatMap((b, bi) =>
    b.segments.flatMap((s, si) =>
      s.reading !== null ? [{ ...s, bi, si, key: `${b.id}:${si}` }] : [],
    ),
  );
  const incompleteRuby = rubies.some((r) => !r.reading.trim());

  return (
    <form
      className="editor-page"
      onSubmit={(e) => {
        e.preventDefault();
        if (!incompleteRuby && !saving)
          onSave({
            ...value,
            content: serializeBlocks(blocks),
            manualReadings: blocks.flatMap((b) =>
              b.segments
                .filter((s) => s.reading)
                .flatMap((s, rubyIndex) =>
                  s.origin === "manual"
                    ? [
                        {
                          blockId: b.id,
                          rubyIndex,
                          text: s.text,
                          reading: s.reading,
                        },
                      ]
                    : [],
                ),
            ),
          });
      }}
    >
      <fieldset className="editor-controls" disabled={saving}>
        <div className="editor-heading">
          <div>
            <span className="eyebrow">
              {initial.id ? "校对材料" : "放进书架"}
            </span>
            <h1>{initial.id ? "留住准确的每一行" : "导入一篇新材料"}</h1>
          </div>
          <div className="editor-actions">
            <button
              type="button"
              className="button subtle"
              onClick={onCancel}
              disabled={saving}
            >
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={
                saving || !value.title.trim() || !body.trim() || incompleteRuby
              }
            >
              <Icon name="check" size={17} />
              {saving ? "正在保存…" : "保存并阅读"}
            </button>
          </div>
        </div>
        <div className="metadata-form">
          <label className="title-field">
            标题
            <input
              aria-label="材料标题"
              value={value.title}
              onChange={(e) => update({ title: e.target.value })}
              placeholder="给这篇材料起个名字"
              maxLength={160}
              required
              autoFocus
            />
          </label>
          <label>
            材料类型
            <select
              aria-label="材料类型"
              value={value.kind}
              onChange={(e) => update({ kind: e.target.value })}
            >
              {Object.entries(kinds).map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          <label>
            阅读方向
            <select
              aria-label="阅读方向"
              value={value.orientation}
              onChange={(e) => update({ orientation: e.target.value })}
            >
              <option value="horizontal">横排</option>
              <option value="vertical">竖排</option>
            </select>
          </label>
        </div>
        {sourceImageId && (
          <div className="ocr-review-overview">
            <strong>
              {initial.id ? "对照原图继续校对" : "这是识别草稿，请对照原图确认"}
            </strong>
            <p>
              检查正文、分行、阅读顺序和读音后再保存。右侧可以切换原图与阅读预览。
            </p>
            <details className="ocr-review-details" open={warnings.length > 0}>
              <summary>
                识别记录
                {warnings.length ? ` · ${warnings.length} 条待核对提示` : ""}
                {nonBody.length ? ` · ${nonBody.length} 条非正文` : ""}
              </summary>
              {recognition.readingOrder && (
                <p className="ocr-reading-order">
                  <strong>阅读顺序：</strong>
                  {recognition.readingOrder}
                </p>
              )}
              {warnings.length > 0 && (
                <div className="ocr-warning-list">
                  <p className="ocr-history-hint">
                    以下是初次识别时的提示。修改正文后，原行号可能变化，请结合原图核对。
                  </p>
                  <ul>
                    {warnings.map((warning, index) => (
                      <li key={index}>
                        <span className="ocr-warning-location">
                          {Number.isInteger(warning.blockIndex)
                            ? `识别时第 ${warning.blockIndex + 1} 行`
                            : "整张图片"}
                        </span>
                        {typeof warning === "string"
                          ? warning
                          : warning.message}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {nonBody.length > 0 && (
                <details className="ocr-nonbody-list">
                  <summary>与正文分开的内容 · {nonBody.length} 条</summary>
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
                </details>
              )}
              {!warnings.length && !nonBody.length && (
                <p className="ocr-history-hint">
                  识别未单独标出疑点，仍请对照原图检查细小假名和特殊读法。
                </p>
              )}
            </details>
          </div>
        )}
        <div className="editor-workspace">
          <section className="source-panel" aria-label="编辑区域">
            <div className="panel-tabs" role="tablist" aria-label="校对方式">
              <button
                type="button"
                role="tab"
                aria-selected={tab === "text"}
                aria-controls="text-editor-panel"
                id="text-editor-tab"
                onClick={() => setTab("text")}
              >
                正文编辑
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "ruby"}
                aria-controls="ruby-editor-panel"
                id="ruby-editor-tab"
                onClick={() => setTab("ruby")}
              >
                注音校正 <span>{counts.rubyCount}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={tab === "batch"}
                aria-controls="batch-editor-panel"
                id="batch-editor-tab"
                onClick={() => setTab("batch")}
              >
                批量注音
              </button>
            </div>
            {tab === "text" ? (
              <div
                id="text-editor-panel"
                role="tabpanel"
                aria-labelledby="text-editor-tab"
              >
                <p className="panel-hint">
                  粘贴日语原文，保留段落和歌词分行。选中字词后可添加注音。
                </p>
                <textarea
                  ref={textarea}
                  className="source-textarea"
                  aria-label="日语正文"
                  lang="ja"
                  placeholder={
                    "把想读的日语放在这里。\n\n可以是一段歌词、一篇文章，\n或教材中还没读懂的那一页。"
                  }
                  value={body}
                  onChange={(e) => editBody(e.target.value)}
                  onSelect={getSelection}
                  onBlur={getSelection}
                  onKeyUp={getSelection}
                  onMouseUp={getSelection}
                  maxLength={200000}
                  spellCheck={false}
                />
                <div className="annotation-tools">
                  <div className="selection-label">
                    {selection ? (
                      <>
                        已选中{" "}
                        <strong lang="ja">
                          {selection.text.length > 18
                            ? `${selection.text.slice(0, 18)}…`
                            : selection.text}
                        </strong>
                      </>
                    ) : (
                      <span>在上方选中字词，为它标注读音</span>
                    )}
                    {selection &&
                      !selection.text.includes("\n") &&
                      selection.text.length <= 100 && (
                        <button
                          type="button"
                          className="text-button"
                          onClick={() => {
                            findBatch(selection.text);
                            setTab("batch");
                          }}
                        >
                          批量标注这个词
                        </button>
                      )}
                  </div>
                  <div className="annotation-input-row">
                    <input
                      ref={readingInput}
                      aria-label="假名读音"
                      lang="ja"
                      value={reading}
                      onChange={(e) => setReading(e.target.value)}
                      placeholder="例如：せなか"
                      maxLength={120}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          applyReading();
                        }
                      }}
                    />
                    <button
                      type="button"
                      className="button secondary"
                      onClick={applyReading}
                      disabled={!selection || !reading.trim()}
                    >
                      添加注音
                    </button>
                  </div>
                </div>
              </div>
            ) : tab === "ruby" ? (
              <div
                className="ruby-editor"
                id="ruby-editor-panel"
                role="tabpanel"
                aria-labelledby="ruby-editor-tab"
              >
                <p className="panel-hint">
                  按完整词校正，例如「食べる」标注「たべる」。同词不同位置可有不同读音。
                </p>
                {incompleteRuby && (
                  <p className="panel-hint">
                    请补齐空白读音，或点击右侧 × 移除注音后再保存。
                  </p>
                )}
                {rubies.length === 0 && (
                  <div className="empty-rubies">
                    <Icon name="type" size={28} />
                    <p>还没有注音</p>
                    <small>回到正文编辑，选中字词后添加。</small>
                  </div>
                )}
                {rubies.map((r) => (
                  <div className="ruby-edit-row" key={r.key}>
                    <label>
                      <span lang="ja">
                        {r.text}
                        <small
                          className={`ruby-origin ${r.origin || "manual"}`}
                          lang="zh-CN"
                        >
                          {{
                            source: "原有",
                            generated: "AI 注音",
                            manual: "手动",
                          }[r.origin] || "手动"}
                        </small>
                      </span>
                      <input
                        aria-label={`${r.text}的读音（第${r.bi + 1}行）`}
                        lang="ja"
                        value={r.reading}
                        onChange={(e) =>
                          changeReading(r.bi, r.si, e.target.value)
                        }
                        maxLength={120}
                      />
                    </label>
                    <button
                      type="button"
                      className="icon-button"
                      aria-label={`移除${r.text}的注音（第${r.bi + 1}行）`}
                      onClick={() => changeReading(r.bi, r.si, null)}
                    >
                      <Icon name="close" size={15} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div
                className="batch-editor"
                id="batch-editor-panel"
                role="tabpanel"
                aria-labelledby="batch-editor-tab"
              >
                <p className="panel-hint">
                  查找完整词，再勾选要修改的位置。只有点击应用后，选中的位置才会改变。
                </p>
                <div className="batch-search-row">
                  <label>
                    要标注的词语
                    <input
                      aria-label="要标注的词语"
                      lang="ja"
                      value={batchTerm}
                      maxLength={100}
                      placeholder="例如：名字、食べる"
                      onChange={(event) => {
                        setBatchTerm(event.target.value);
                        setBatchSearch(null);
                        setBatchSelected([]);
                        setMessage("");
                      }}
                      onKeyDown={(event) => {
                        if (
                          event.key === "Enter" &&
                          !event.nativeEvent.isComposing
                        ) {
                          event.preventDefault();
                          findBatch();
                        }
                      }}
                    />
                  </label>
                  <button
                    type="button"
                    className="button secondary"
                    onClick={() => findBatch()}
                    disabled={!batchTerm.trim()}
                  >
                    查找位置
                  </button>
                </div>
                {batchSearch && (
                  <>
                    <div className="batch-result-heading">
                      <span role="status">
                        找到 {batchResults.length} 处 · 已选{" "}
                        {batchSelected.length} 处
                      </span>
                      <button
                        type="button"
                        className="text-button"
                        disabled={!batchAvailable.length}
                        onClick={() =>
                          setBatchSelected(
                            allBatchSelected
                              ? []
                              : batchAvailable.map((item) => item.key),
                          )
                        }
                      >
                        {allBatchSelected ? "取消全选" : "全选可修改的位置"}
                      </button>
                    </div>
                    <div
                      className="batch-results"
                      role="group"
                      aria-label="要批量标注的位置"
                    >
                      {batchResults.map((item, index) => (
                        <label
                          className={`batch-occurrence ${item.canAnnotate ? "" : "unavailable"}`}
                          key={item.key}
                        >
                          <input
                            type="checkbox"
                            aria-label={`选择第${index + 1}处${batchSearch.query}（第${item.blockIndex + 1}行）`}
                            checked={batchSelected.includes(item.key)}
                            disabled={!item.canAnnotate}
                            onChange={(event) =>
                              setBatchSelected((old) =>
                                event.target.checked
                                  ? [...old, item.key]
                                  : old.filter((key) => key !== item.key),
                              )
                            }
                          />
                          <span className="batch-occurrence-content">
                            <small>
                              第 {item.blockIndex + 1} 行 · 当前读音：
                              {item.currentReading ||
                                (item.canAnnotate ? "未标注" : "包含已有注音")}
                            </small>
                            <span lang="ja">
                              {item.before}
                              <mark>{batchSearch.query}</mark>
                              {item.after}
                            </span>
                            {!item.canAnnotate && (
                              <small className="batch-occurrence-reason">
                                {item.reason}
                              </small>
                            )}
                          </span>
                        </label>
                      ))}
                    </div>
                    {batchAvailable.length < batchResults.length && (
                      <p className="panel-hint">
                        有 {batchResults.length - batchAvailable.length}{" "}
                        处只匹配了已有注音的一部分，不能勾选。请改查完整词后修改。
                      </p>
                    )}
                    {batchResults.length === 0 && (
                      <p className="panel-hint">
                        没有找到这个词语，请检查正文或换一个完整词。
                      </p>
                    )}
                    <div className="batch-apply-row">
                      <label>
                        选中位置的假名读音
                        <input
                          aria-label="批量假名读音"
                          lang="ja"
                          value={batchReading}
                          onChange={(event) =>
                            setBatchReading(event.target.value)
                          }
                          maxLength={120}
                          placeholder="例如：みょうじ"
                          onKeyDown={(event) => {
                            if (event.key === "Enter") event.preventDefault();
                          }}
                        />
                      </label>
                      <button
                        type="button"
                        className="button secondary"
                        disabled={!batchSelected.length || !batchReading.trim()}
                        onClick={applyBatch}
                      >
                        应用到选中的 {batchSelected.length} 处
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
            {message && (
              <div className="editor-message" role="status">
                {message}
                <button
                  className="icon-button"
                  type="button"
                  aria-label="关闭校对提示"
                  onClick={() => setMessage("")}
                >
                  <Icon name="close" size={14} />
                </button>
              </div>
            )}
          </section>
          <section
            className="preview-panel"
            aria-label={previewMode === "image" ? "原图对照" : "阅读预览"}
          >
            <div className="preview-heading">
              {sourceImageId ? (
                <div
                  className="ocr-preview-switch"
                  role="tablist"
                  aria-label="对照方式"
                >
                  <button
                    type="button"
                    role="tab"
                    aria-selected={previewMode === "image"}
                    onClick={() => setPreviewMode("image")}
                  >
                    原图对照
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={previewMode === "reading"}
                    onClick={() => setPreviewMode("reading")}
                  >
                    阅读预览
                  </button>
                </div>
              ) : (
                <span>阅读预览</span>
              )}
              {previewMode === "image" ? (
                <a
                  className="text-button"
                  href={imageUrl}
                  target="_blank"
                  rel="noreferrer"
                >
                  打开完整原图 <Icon name="arrow" size={12} />
                </a>
              ) : (
                <small>随修改更新</small>
              )}
            </div>
            {previewMode === "image" ? (
              <>
                <div
                  className="ocr-image-controls"
                  role="group"
                  aria-label="原图显示调整"
                >
                  <button
                    type="button"
                    className="text-button"
                    disabled={!imageSize || imageError}
                    onClick={() => setImageRotation((turns) => (turns + 1) % 4)}
                  >
                    向左旋转90°
                  </button>
                  <label>
                    缩放
                    <select
                      aria-label="原图缩放"
                      value={imageZoom}
                      disabled={!imageSize || imageError}
                      onChange={(event) =>
                        setImageZoom(Number(event.target.value))
                      }
                    >
                      <option value={100}>适合宽度（100%）</option>
                      <option value={150}>150%</option>
                      <option value={200}>200%</option>
                      <option value={300}>300%</option>
                    </select>
                  </label>
                </div>
                <div className="ocr-original-image">
                  {imageError ? (
                    <p role="alert">原图暂时无法载入，请尝试打开完整原图。</p>
                  ) : (
                    <a
                      className="ocr-image-frame"
                      href={imageUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="打开完整原始图片"
                      style={{
                        width: `${imageZoom}%`,
                        aspectRatio: imageSize
                          ? imageSideways
                            ? `${imageSize.height} / ${imageSize.width}`
                            : `${imageSize.width} / ${imageSize.height}`
                          : "1 / 1",
                      }}
                    >
                      <img
                        src={imageUrl}
                        alt="用于校对正文和注音的日语原图"
                        style={{
                          width:
                            imageSideways && imageSize
                              ? `${(imageSize.width / imageSize.height) * 100}%`
                              : "100%",
                          transform: `translate(-50%, -50%) rotate(${-imageRotation * 90}deg)`,
                        }}
                        onLoad={(event) => {
                          const { naturalWidth: width, naturalHeight: height } =
                            event.currentTarget;
                          if (width && height) setImageSize({ width, height });
                        }}
                        onError={() => setImageError(true)}
                      />
                    </a>
                  )}
                </div>
              </>
            ) : (
              <div className="preview-content">
                {body.trim() ? (
                  <RubyText
                    blocks={blocks}
                    fontSize={23}
                    orientation={value.orientation}
                  />
                ) : (
                  <p className="preview-placeholder" lang="ja">
                    ここから、はじめよう。
                  </p>
                )}
              </div>
            )}
          </section>
        </div>
        <div className="editor-footnote">
          <span>
            {counts.charCount} 字 · {counts.rubyCount} 处注音
          </span>
          <span>保存后可在书架中重新打开</span>
        </div>
      </fieldset>
    </form>
  );
}
