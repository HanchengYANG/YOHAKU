import { useEffect, useMemo, useRef, useState } from "react";
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
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";

export default function Editor({ initial, onSave, onCancel, onDirty, saving }) {
  const [value, setValue] = useState(() => ({
    ...initial,
    orientation: "horizontal",
  }));
  const [contentDirty, setContentDirty] = useState(
    () =>
      !initial.id &&
      !!(
        initial.content?.trim() ||
        initial.sourceImageId ||
        initial.recognition?.sourceImage?.id
      ),
  );
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
  const [activeRange, setActiveRange] = useState(null);
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
  const [imageMetadata, setImageMetadata] = useState(null);
  const [imageMetadataLoading, setImageMetadataLoading] =
    useState(!!sourceImageId);
  const [imageMetadataError, setImageMetadataError] = useState("");
  const [imageSaveError, setImageSaveError] = useState("");
  const [imageConflict, setImageConflict] = useState(false);
  const [imageSaving, setImageSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const metadataRequest = useRef(0);
  const rotationRequest = useRef(null);
  const submitLock = useRef(false);
  const busy = saving || imageSaving || submitting;
  const imageSideways = imageRotation % 2 === 1;
  const imageUrl = sourceImageId
    ? `/api/images/${encodeURIComponent(sourceImageId)}/raw${imageMetadata ? `?revision=${imageMetadata.revision}` : ""}`
    : null;
  useEffect(() => {
    onDirty(contentDirty || imageRotation !== 0);
  }, [contentDirty, imageRotation, onDirty]);
  const loadImageMetadata = async (resetRotation = false) => {
    if (!sourceImageId) return;
    const request = ++metadataRequest.current;
    setImageMetadataLoading(true);
    setImageMetadataError("");
    try {
      const metadata = await api(
        `/images/${encodeURIComponent(sourceImageId)}`,
      );
      if (request !== metadataRequest.current) return;
      setImageMetadata(metadata);
      setImageError(false);
      if (resetRotation) {
        setImageRotation(0);
        setImageSize({
          width: metadata.displayWidth || metadata.width,
          height: metadata.displayHeight || metadata.height,
        });
        setImageSaveError("");
        setImageConflict(false);
      }
    } catch (error) {
      if (request === metadataRequest.current)
        setImageMetadataError(error.message);
    } finally {
      if (request === metadataRequest.current) setImageMetadataLoading(false);
    }
  };
  useEffect(() => {
    loadImageMetadata();
    return () => {
      metadataRequest.current++;
    };
  }, [sourceImageId]);
  const saveImageDirection = () => {
    if (rotationRequest.current) return rotationRequest.current;
    if (imageRotation === 0) return Promise.resolve();
    const request = Promise.resolve().then(async () => {
      setImageSaving(true);
      setImageSaveError("");
      try {
        if (!imageMetadata || imageMetadataLoading)
          throw new Error("尚未读取到图片版本，请先重新读取图片信息。");
        const response = await fetch(
          `/api/images/${encodeURIComponent(sourceImageId)}/rotate`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              quarterTurns: (4 - imageRotation) % 4,
              revision: imageMetadata.revision,
            }),
          },
        );
        const result = await response.json().catch(() => ({
          error: "服务没有返回有效结果，请重试保存图片方向。",
        }));
        if (result.code === "WEBSITE_AUTH_REQUIRED")
          window.dispatchEvent(new Event("yohaku:session-expired"));
        if (!response.ok) {
          setImageConflict(response.status === 409);
          throw new Error(
            response.status === 409
              ? "图片已在其他页面修改。请重新载入当前图片，再确认方向；正文修改仍保留。"
              : result.error || "图片方向未保存，请重试。",
          );
        }
        if (!Number.isInteger(result.revision)) {
          setImageConflict(true);
          throw new Error("图片版本返回异常，请重新载入当前图片后确认方向。");
        }
        setImageMetadata(result);
        setImageRotation(0);
        setImageSize(null);
        setImageError(false);
        setImageConflict(false);
      } catch (error) {
        setImageSaveError(error.message);
        throw error;
      } finally {
        setImageSaving(false);
        rotationRequest.current = null;
      }
    });
    rotationRequest.current = request;
    return request;
  };
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
  const toggleBatchOccurrence = (key) => {
    if (
      batchSearch?.blocks !== blocks ||
      !batchAvailable.some((item) => item.key === key)
    )
      return;
    setBatchSelected((old) =>
      old.includes(key) ? old.filter((item) => item !== key) : [...old, key],
    );
  };
  const update = (patch) => {
    setValue((old) => ({ ...old, ...patch }));
    setContentDirty(true);
  };
  const updateBlocks = (next, preserveActive = false) => {
    setBlocks(next);
    setSelection(null);
    setBatchSelected([]);
    setBatchSearch((old) => old && { query: old.query, blocks: next });
    if (!preserveActive) setActiveRange(null);
    setContentDirty(true);
  };
  const findBatch = (query = batchTerm) => {
    const term = query.trim();
    try {
      findTextOccurrences(blocks, term);
      setBatchTerm(term);
      setBatchSelected([]);
      setBatchSearch({ query: term, blocks });
      setActiveRange(null);
      setPreviewMode("reading");
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
    updateBlocks(next, text !== null);
  };
  let offset = 0;
  const rubies = blocks.flatMap((b, bi) => {
    const entries = b.segments.flatMap((s, si) => {
      const start = offset;
      offset += s.text.length;
      return s.reading !== null
        ? [{ ...s, bi, si, start, end: offset, key: `${b.id}:${si}` }]
        : [];
    });
    offset++;
    return entries;
  });
  const locateRuby = (ruby) => {
    setActiveRange({ start: ruby.start, end: ruby.end });
    setPreviewMode("reading");
  };
  const incompleteRuby = rubies.some((r) => !r.reading.trim());

  return (
    <form
      className="editor-page"
      onSubmit={async (e) => {
        e.preventDefault();
        if (incompleteRuby || busy || submitLock.current) return;
        submitLock.current = true;
        setSubmitting(true);
        try {
          await saveImageDirection();
          await onSave({
            ...value,
            orientation: "horizontal",
            blocks,
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
        } catch (error) {
          setMessage(error.message);
        } finally {
          submitLock.current = false;
          setSubmitting(false);
        }
      }}
    >
      <fieldset className="editor-controls" disabled={busy}>
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
              disabled={busy}
            >
              取消
            </button>
            <button
              type="submit"
              className="button primary"
              disabled={
                busy || !value.title.trim() || !body.trim() || incompleteRuby
              }
            >
              <Icon name="check" size={17} />
              {busy ? "正在保存…" : "保存并阅读"}
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
                  识别未单独标出疑点，仍请检查正文、原图注音和 AI
                  补充的读音，特别留意人名与特殊读法。
                </p>
              )}
            </details>
          </div>
        )}
        {sourceImageId &&
          (imageMetadataError || imageSaveError || imageRotation !== 0) && (
            <div className="image-direction-status">
              {imageRotation !== 0 && (
                <p role="status">
                  图片方向尚未保存。“保存并阅读”会先保存图片方向，再保存正文。
                </p>
              )}
              {(imageMetadataError || imageSaveError) && (
                <p role="alert">{imageSaveError || imageMetadataError}</p>
              )}
              {imageConflict ? (
                <>
                  <p>重新载入将取消本页未保存的旋转，保留正文修改。</p>
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || imageMetadataLoading}
                    onClick={() => loadImageMetadata(true)}
                  >
                    重新载入当前图片
                  </button>
                </>
              ) : (
                imageMetadataError && (
                  <button
                    type="button"
                    className="text-button"
                    disabled={busy || imageMetadataLoading}
                    onClick={() => loadImageMetadata()}
                  >
                    重新读取图片信息
                  </button>
                )
              )}
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
                onClick={() => {
                  setTab("batch");
                  setPreviewMode("reading");
                }}
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
                  <div
                    className="ruby-edit-row"
                    key={r.key}
                    data-active={
                      activeRange?.start === r.start &&
                      activeRange?.end === r.end
                    }
                  >
                    <label onClick={() => locateRuby(r)}>
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
                        onFocus={() => locateRuby(r)}
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
                  查找完整词，在原文预览中点选要修改的位置；高亮为命中，深色为已选。只有点击应用后才会改变读音。
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
                    {batchAvailable.length < batchResults.length && (
                      <p className="panel-hint">
                        有 {batchResults.length - batchAvailable.length}{" "}
                        处只匹配了已有注音的一部分，原文中已标为灰色，不能选择。请改查完整词后修改。
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
                    disabled={
                      !imageSize ||
                      imageError ||
                      !imageMetadata ||
                      imageMetadataLoading
                    }
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
                  <button
                    type="button"
                    className="button secondary"
                    disabled={
                      !imageRotation ||
                      !imageMetadata ||
                      imageMetadataLoading ||
                      busy
                    }
                    onClick={async () => {
                      try {
                        await saveImageDirection();
                        setMessage("图片方向已保存，正文和注音保持原样。");
                      } catch {
                        /* The image error above keeps the pending rotation available for retry. */
                      }
                    }}
                  >
                    {imageSaving ? "正在保存图片方向…" : "保存图片方向"}
                  </button>
                  {imageMetadataLoading && (
                    <small role="status">正在读取图片信息…</small>
                  )}
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
                        key={imageUrl}
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
              <div
                className="preview-content"
                role={tab === "batch" ? "group" : undefined}
                aria-label={
                  tab === "batch" ? "完整原文中的批量注音位置" : undefined
                }
              >
                {tab === "batch" && batchResults.length > 0 && (
                  <p className="preview-selection-hint">
                    在下方原文中点选高亮词，可用 Tab 和空格选择。深色为已选，共{" "}
                    {batchSelected.length} 处。
                  </p>
                )}
                {body.trim() ? (
                  <RubyText
                    blocks={blocks}
                    fontSize={23}
                    activeRange={tab === "ruby" ? activeRange : null}
                    occurrences={tab === "batch" ? batchResults : []}
                    selectedKeys={batchSelected}
                    onOccurrenceToggle={toggleBatchOccurrence}
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
