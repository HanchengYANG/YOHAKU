import { createPortal } from "react-dom";
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
import { blocksToHtml, htmlToBlocks, bodyText, bodyRanges, editBodyText, syncBodyReadings, removeQaMarks } from "../../shared/article-html.mjs";
import DocumentChat from "./DocumentChat.jsx";
import ArticleBody from "./ArticleBody.jsx";
import { kinds } from "../constants.mjs";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import RubyText from "./RubyText.jsx";
import ImportProgress from "./ImportProgress.jsx";

const annotationSteps = [{ id: "annotate", label: "生成注音", copy: "正在参考原图补全缺失读音，正文和已有读音保持不变。" }];

export default function Editor({ initial, onSave, onCancel, onDirty, saving, books = [], onCreateBook }) {
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
  const [bodyHtml, setBodyHtml] = useState(() => initial.bodyHtml || blocksToHtml(parseText(initial.content, initial.blocks || []), {sourceImageId:initial.sourceImageId || initial.recognition?.sourceImage?.id}));
  const [blocks, setBlocks] = useState(() => initial.bodyHtml ? htmlToBlocks(initial.bodyHtml) : parseText(initial.content, initial.blocks || []));
  const [viewGroupIds, setViewGroupIds] = useState(null);
  const beforeInput = useRef(null);
  const htmlRef = useRef(bodyHtml);
  htmlRef.current = bodyHtml;
  const undoHistory = useRef([]);
  const redoHistory = useRef([]);
  const [insertionSource, setInsertionSource] = useState("inherit");
  const [boundarySide, setBoundarySide] = useState("previous");
  const [boundaryAt, setBoundaryAt] = useState(null);
  const [segmenting, setSegmenting] = useState(false);
  const initialQaIds = useRef([...new Set(bodyRanges(bodyHtml).qa.map((range) => range.id))]);
  const currentQaIds = new Set(bodyRanges(bodyHtml).qa.map((range) => range.id));
  const orphanedIds = initialQaIds.current.filter((id) => !currentQaIds.has(id));
  const imageSources = initial.sourceImages?.length ? initial.sourceImages : (initial.sourceImageId || initial.recognition?.sourceImage?.id) ? [{id:initial.sourceImageId || initial.recognition?.sourceImage?.id, recognition:initial.recognition}] : [];
  const [activeSourceId, setActiveSourceId] = useState(initial.appendedImageId || imageSources[0]?.id || null);
  const [selection, setSelection] = useState(null);
  const [reading, setReading] = useState("");
  const [message, setMessage] = useState("");
  const [newBookTitle, setNewBookTitle] = useState("");
  const [showNewBook, setShowNewBook] = useState(false);
  const [creatingBook, setCreatingBook] = useState(false);
  const [tab, setTab] = useState("text");
  const [batchTerm, setBatchTerm] = useState("");
  const [batchSearch, setBatchSearch] = useState(null);
  const [batchSelected, setBatchSelected] = useState([]);
  const [batchReading, setBatchReading] = useState("");
  const [activeRange, setActiveRange] = useState(null);
  const sourceImageId = activeSourceId;
  const recognition = imageSources.find((image) => image.id === activeSourceId)?.recognition || initial.recognition || initial;
  const warnings = Array.isArray(recognition.warnings)
    ? recognition.warnings
    : [];
  const nonBody = Array.isArray(recognition.nonBody) ? recognition.nonBody : [];
  const [previewMode, setPreviewMode] = useState(
    sourceImageId ? "image" : "reading",
  );
  const [imageError, setImageError] = useState(false);
  const [imageSize, setImageSize] = useState(null);
  const [loadedImageUrl, setLoadedImageUrl] = useState(null);
  const [importElapsedMs, setImportElapsedMs] = useState(null);
  const [annotating, setAnnotating] = useState(false);
  const [annotationCompleted, setAnnotationCompleted] = useState(
    initial.autoAnnotationCompleted === true,
  );
  const [annotationError, setAnnotationError] = useState(initial.annotationError || "");
  const [annotationStartedAt, setAnnotationStartedAt] = useState(null);
  const [annotationElapsedMs, setAnnotationElapsedMs] = useState(null);
  const [annotationPaint, setAnnotationPaint] = useState(null);
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
  const annotationRequest = useRef(null);
  const busy = saving || imageSaving || submitting || annotating || creatingBook || segmenting;
  const imageSideways = imageRotation % 2 === 1;
  const imageUrl = sourceImageId
    ? `/api/images/${encodeURIComponent(sourceImageId)}/raw${imageMetadata ? `?revision=${imageMetadata.revision}` : ""}`
    : null;
  useEffect(() => {
    if (!Number.isFinite(initial.importStartedAt) || importElapsedMs !== null ||
        imageMetadataLoading || imageMetadataError || imageError || !imageSize || loadedImageUrl !== imageUrl) return;
    let second;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const completedAt = performance.now();
        const elapsedMs = Math.round(completedAt - initial.importStartedAt);
        const automatic = initial.autoAnnotationCompleted === true;
        const eventName = automatic ? "yohaku:import-page-ready" : "yohaku:ocr-page-ready";
        performance.mark(eventName);
        setImportElapsedMs(elapsedMs);
        if (automatic && Number.isFinite(initial.annotationStartedAt)) {
          const annotationMs = Math.round(completedAt - initial.annotationStartedAt);
          setAnnotationElapsedMs(annotationMs);
          window.dispatchEvent(new CustomEvent("yohaku:annotation-page-ready", {
            detail: { elapsedMs: annotationMs, sourceImageId, stage: "annotation" },
          }));
        }
        window.dispatchEvent(new CustomEvent(eventName, {
          detail: { elapsedMs, engine: initial.engine || "llm", sourceImageId,
            stage: automatic ? "complete" : "body" },
        }));
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [initial.importStartedAt, initial.annotationStartedAt, initial.autoAnnotationCompleted,
    importElapsedMs, imageMetadataLoading, imageMetadataError, imageError, imageSize, loadedImageUrl, imageUrl]);
  useEffect(() => () => annotationRequest.current?.abort(), []);
  useEffect(() => {
    if (!annotationPaint) return;
    let second;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => {
        const elapsedMs = Math.round(performance.now() - annotationPaint.startedAt);
        setAnnotationElapsedMs(elapsedMs);
        setAnnotationPaint(null);
        setAnnotating(false);
        setAnnotationCompleted(true);
        annotationRequest.current = null;
        window.dispatchEvent(new CustomEvent("yohaku:annotation-page-ready", {
          detail: { elapsedMs, sourceImageId, stage: "annotation" },
        }));
      });
    });
    return () => { cancelAnimationFrame(first); cancelAnimationFrame(second); };
  }, [annotationPaint, sourceImageId]);
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
  useEffect(() => {
    const element = textarea.current;
    if (!element) return;
    const capture = (event) => { beforeInput.current = {start:element.selectionStart,end:element.selectionEnd,inputType:event.inputType}; };
    element.addEventListener("beforeinput", capture);
    return () => element.removeEventListener("beforeinput", capture);
  }, [tab, body]);
  const counts = stats(blocks);
  const hasMissingReadings = blocks.some((block) => block.segments.some(
    (segment) => !segment.reading && /\p{Script=Han}/u.test(segment.text),
  ));
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
  const updateBlocks = (next, preserveActive = false, nextHtml = null) => {
    undoHistory.current.push({ blocks: structuredClone(blocks), html: bodyHtml });
    if (undoHistory.current.length > 100) undoHistory.current.shift();
    redoHistory.current = [];
    const structured = nextHtml || (bodyText(bodyHtml) === plainText(next) ? bodyHtml : editBodyText(bodyHtml, plainText(next), {boundarySide}));
    setBodyHtml(syncBodyReadings(structured, next));
    setBlocks(next);
    setSelection(null);
    setBatchSelected([]);
    setBatchSearch((old) => old && { query: old.query, blocks: next });
    if (!preserveActive) setActiveRange(null);
    setContentDirty(true);
  };
  const generateMissingReadings = async () => {
    if (busy || submitLock.current || annotationRequest.current || !sourceImageId || initial.id || !body.trim()) return;
    const controller = new AbortController();
    annotationRequest.current = controller;
    const currentContent = serializeBlocks(blocks);
    const currentBody = plainText(blocks);
    const manualReadings = blocks.flatMap((block, blockIndex) =>
      block.segments.filter((segment) => segment.reading).flatMap((segment, rubyIndex) =>
        segment.origin === "manual"
          ? [{ blockIndex, rubyIndex, text: segment.text, reading: segment.reading }]
          : [],
      ),
    );
    const startedAt = performance.now();
    setAnnotationStartedAt(startedAt);
    setAnnotating(true);
    setAnnotationError("");
    setAnnotationElapsedMs(null);
    let awaitingPaint = false;
    try {
      const result = await api(`/images/${encodeURIComponent(sourceImageId)}/annotate`, {
        method: "POST",
        body: JSON.stringify({ content: currentContent, manualReadings }),
        signal: controller.signal,
      });
      if (controller.signal.aborted) return;
      if (!Array.isArray(result?.blocks) || plainText(result.blocks) !== currentBody)
        throw new Error("注音结果改变了正文，已拒绝应用；当前正文保留，可重试。");
      const content = serializeBlocks(result.blocks);
      updateBlocks(result.blocks);
      setValue((old) => ({
        ...old,
        content,
        blocks: result.blocks,
        annotationModel: result.annotationModel,
        annotationReasoningEffort: result.annotationReasoningEffort,
        annotationElapsedMs: result.annotationElapsedMs,
      }));
      setMessage("");
      setAnnotationPaint({ startedAt });
      awaitingPaint = true;
    } catch (error) {
      if (!controller.signal.aborted)
        setAnnotationError(error instanceof TypeError
          ? "无法连接本机服务，当前正文保留，请重试生成注音。"
          : error.message);
    } finally {
      if (!awaitingPaint && annotationRequest.current === controller) {
        annotationRequest.current = null;
        if (!controller.signal.aborted) setAnnotating(false);
      }
    }
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
    let precise = beforeInput.current;
    beforeInput.current = null;
    if (precise && precise.start === precise.end && precise.inputType?.startsWith("delete")) {
      const length = body.length - text.length;
      precise = precise.inputType.includes("Backward") ? {...precise,start:Math.max(0,precise.start-length)} : {...precise,end:precise.end+length};
    }
    const edited = editBodyText(bodyHtml, text, {boundarySide,...(insertionSource === "inherit" ? {} : {sourceImageId:insertionSource || null}),...(precise ? {editStart:precise.start,editEnd:precise.end}: {})});
    updateBlocks(result.blocks, false, edited);
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
    if (el) {
      const at = el.selectionStart;
      const ranges = bodyRanges(bodyHtml);
      const preceding = ranges.sentences.find((item) => item.end === at);
      const following = ranges.sentences.find((item) => item.start === at);
      setBoundaryAt(preceding && following && preceding.id !== following.id ? {at, preceding, following} : null);
      const source = ranges.sources.find((item) => item.start <= at && item.end > at);
      if (source && source.id !== activeSourceId) {
        if (imageRotation) setMessage("先保存当前图片方向，再定位另一张来源图；正文选区已保留。");
        else { setActiveSourceId(source.id); setImageMetadata(null); setImageSize(null); setPreviewMode("image"); }
      } else if (source) setPreviewMode("image");
    }
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
  const undo = (redo = false) => {
    const from = redo ? redoHistory : undoHistory;
    const to = redo ? undoHistory : redoHistory;
    const restored = from.current.pop();
    if (!restored) return;
    to.current.push({blocks:structuredClone(blocks),html:bodyHtml});
    setBlocks(restored.blocks); setBodyHtml(restored.html); setSelection(null); setContentDirty(true);
  };
  const resegment = async () => {
    const snapshot = bodyHtml;
    setSegmenting(true); setMessage("");
    try {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(bodyText(snapshot)));
      const bodyHash = [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2,"0")).join("");
      const result = await api(`/documents/${encodeURIComponent(initial.id)}/sentences`, {
        method:"POST", body:JSON.stringify({revision:value.revision,bodyHash,bodyHtml:snapshot,force:true}),
      });
      if (htmlRef.current !== snapshot) { setMessage("正文已变化，未应用旧分句结果。请重新分句。"); return; }
      updateBlocks(htmlToBlocks(result.bodyHtml), false, result.bodyHtml);
      setMessage("分句已更新，正文、注音、来源和问答标记已保留。保存后生效。");
    } catch (error) { setMessage(`分句未完成，当前正文保留，可重试：${error.message}`); }
    finally { setSegmenting(false); }
  };
  const chooseSource = (id) => {
    if (id !== activeSourceId && imageRotation && !window.confirm("当前图片方向尚未保存，切换图片会取消这次旋转。")) return;
    setActiveSourceId(id); setImageMetadata(null); setImageRotation(0); setImageSize(null); setPreviewMode("image");
    const range = bodyRanges(bodyHtml).sources.find((item) => item.id === id);
    if (range) { textarea.current?.focus(); textarea.current?.setSelectionRange(range.start, range.end); setSelection({start:range.start,end:range.end,text:body.slice(range.start,range.end)}); }
  };

  return (
    <form
      className="editor-page"
      aria-busy={busy}
      onSubmit={async (e) => {
        e.preventDefault();
        if (incompleteRuby || busy || submitLock.current || annotationRequest.current) return;
        submitLock.current = true;
        setSubmitting(true);
        try {
          await saveImageDirection();
          await onSave({
            ...value,
            orientation: "horizontal",
            blocks,
            bodyHtml,
            sourceImages:imageSources.map((image) => ({id:image.id})),
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
              {initial.id ? "校对材料" : value.bookId ? "加入书籍" : "放进书架"}
            </span>
            <h1>{initial.id ? "留住准确的每一行" : value.bookId ? "添加一篇阅读文章" : "导入一篇新材料"}</h1>
          </div>
          <div className="editor-actions">
            <button
              type="button"
              className="button subtle"
              onClick={() => { if (!annotationRequest.current) onCancel(); }}
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
              {annotating ? "正在生成注音…" : busy ? "正在保存…" : "保存并阅读"}
            </button>
          </div>
        </div>
        {(!initial.id || !initial.bookId) && (
          <div className="book-target">
            <label>
              保存到书籍
              <select aria-label="保存到书籍" value={value.bookId || ""}
                onChange={(event) => update({ bookId: event.target.value || null })}>
                <option value="">独立材料（不放入书籍）</option>
                {books.map((item) => <option key={item.id} value={item.id}>{item.title}</option>)}
              </select>
            </label>
            {onCreateBook && (
              <button className="text-button" type="button" onClick={() => setShowNewBook(!showNewBook)}>
                {showNewBook ? "收起新建书籍" : "新建书籍"}
              </button>
            )}
            {showNewBook && (
              <div className="book-target-create">
                <label>书籍名称
                  <input aria-label="新书籍名称" value={newBookTitle} maxLength={160}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.nativeEvent.isComposing) event.preventDefault();
                    }}
                    onChange={(event) => setNewBookTitle(event.target.value)} />
                </label>
                <button className="button secondary" type="button" disabled={!newBookTitle.trim() || busy}
                  onClick={async () => {
                    if (creatingBook || !newBookTitle.trim()) return;
                    setCreatingBook(true);
                    try {
                      const created = await onCreateBook(newBookTitle.trim());
                      update({ bookId: created.id });
                      setShowNewBook(false);
                      setNewBookTitle("");
                      setMessage("");
                    } catch (cause) { setMessage(cause.message); }
                    finally { setCreatingBook(false); }
                  }}>创建并选中</button>
              </div>
            )}
            <small>一本书包含多篇文章。每次保存会添加为最后一篇，之后可在书籍目录调整顺序。</small>
          </div>
        )}
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
            {importElapsedMs !== null && (
              <p role="status"
                data-import-elapsed-ms={initial.autoAnnotationCompleted ? importElapsedMs : undefined}
                data-ocr-elapsed-ms={!initial.autoAnnotationCompleted ? importElapsedMs : undefined}>
                {initial.autoAnnotationCompleted ? "上传后识别与注音完成用时" : "上传后正文完成用时"}{" "}
                {(importElapsedMs / 1000).toFixed(2)} 秒
              </p>
            )}
            {!initial.id && (
              <div className="ocr-annotation-task">
                <p>{annotationCompleted
                  ? "正文与注音已完成，请一起校对正文和读音后保存。"
                  : "正文已完成，注音尚未完成；可重试生成注音，正文和已有读音保持不变。"}</p>
                {(!annotationCompleted || hasMissingReadings || annotating) && (
                  <button type="button" className="button secondary"
                    disabled={busy || !body.trim() || incompleteRuby}
                    onClick={generateMissingReadings}>
                    {annotating ? "正在生成缺失注音…"
                      : annotationCompleted ? "补全缺失注音" : "生成缺失注音"}
                  </button>
                )}
                {annotating && <p role="status">正在参考原图生成缺失注音，正文保持不变。</p>}
                {annotationStartedAt !== null && (annotating || annotationError) && (
                  <ImportProgress phase="annotate" startedAt={annotationStartedAt}
                    steps={annotationSteps} failed={!annotating && !!annotationError} />
                )}
                {annotationError && <p role="alert">{annotationError}</p>}
                {annotationElapsedMs !== null && (
                  <p role="status" data-annotation-elapsed-ms={annotationElapsedMs}>
                    注音完成用时 {(annotationElapsedMs / 1000).toFixed(2)} 秒
                  </p>
                )}
              </div>
            )}
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
                  仍请对照原图检查正文和读音，特别留意人名与特殊读法。
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
                  onKeyDown={(event) => {
                    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") { event.preventDefault(); undo(event.shiftKey); }
                    else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "y") { event.preventDefault(); undo(true); }
                  }}
                  maxLength={200000}
                  spellCheck={false}
                />
                <div className="sentence-actions">
                  <button type="button" className="text-button" disabled={!undoHistory.current.length} onClick={() => undo()}>撤销</button>
                  <button type="button" className="text-button" disabled={!redoHistory.current.length} onClick={() => undo(true)}>重做</button>
                  {initial.id ? <button type="button" className="text-button" disabled={busy || incompleteRuby} onClick={resegment}>{segmenting ? "正在重新分句…" : "重新分句"}</button> : <small>首次保存后初始化分句；普通校对保留现有句子。</small>}
                </div>
                {boundaryAt && <fieldset className="sentence-boundary"><legend>句子交界：新增文字插入</legend>
                  <label><input type="radio" name="boundarySide" checked={boundarySide === "previous"} onChange={() => setBoundarySide("previous")} />前句「{boundaryAt.preceding.text.slice(-12)}」</label>
                  <label><input type="radio" name="boundarySide" checked={boundarySide === "next"} onChange={() => setBoundarySide("next")} />后句「{boundaryAt.following.text.slice(0,12)}」</label>
                  <label>新增文字来源<select aria-label="新增文字来源" value={insertionSource} onChange={(event) => setInsertionSource(event.target.value)}>
                    <option value="inherit">沿用所选句子当前位置的来源</option><option value="">无图片来源</option>
                    {imageSources.map((image,index) => <option key={image.id} value={image.id}>来源图 {index+1}</option>)}
                  </select></label>
                  <small>前句来源：{(() => {const source=bodyRanges(bodyHtml).sources.find((item) => item.start < boundaryAt.at && item.end >= boundaryAt.at); return source ? `来源图 ${imageSources.findIndex((image) => image.id === source.id)+1}` : "无图片来源";})()}；后句来源：{(() => {const source=bodyRanges(bodyHtml).sources.find((item) => item.start <= boundaryAt.at && item.end > boundaryAt.at); return source ? `来源图 ${imageSources.findIndex((image) => image.id === source.id)+1}` : "无图片来源";})()}</small>
                </fieldset>}
                {orphanedIds.length > 0 && <p role="status" className="qa-orphan-warning">{orphanedIds.length} 个问答组的正文关联已删除：{orphanedIds.join("、")}。保存后将标为游离；撤销或取消可恢复。</p>}
                {body.trim() && <details className="editor-structure-preview"><summary>正文中的句子、来源与问答标记</summary><ArticleBody html={bodyHtml} fontSize={21} activeSourceId={activeSourceId} onSource={chooseSource} onGroup={setViewGroupIds} /></details>}
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
            {imageSources.length > 1 && <div className="source-image-picker" aria-label="来源图片列表">
              {imageSources.map((image,index) => <button type="button" key={image.id} className={`button ${activeSourceId === image.id ? "primary" : "subtle"}`} aria-pressed={activeSourceId === image.id} onClick={() => chooseSource(image.id)}>来源图 {index+1}</button>)}
            </div>}
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
                        onLoad={async (event) => {
                          const element = event.currentTarget;
                          try {
                            await element.decode();
                            if (!element.isConnected) return;
                            setLoadedImageUrl(element.getAttribute("src"));
                            const { naturalWidth: width, naturalHeight: height } = element;
                            if (width && height) setImageSize({ width, height });
                          } catch {
                            if (element.isConnected) setImageError(true);
                          }
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
                {body.trim() && tab === "text" ? <ArticleBody html={bodyHtml} fontSize={23} activeSourceId={activeSourceId} onSource={chooseSource} onGroup={setViewGroupIds} /> : body.trim() ? (
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
      {viewGroupIds && initial.id && createPortal(<div className="editor-chat-overlay">
        <DocumentChat document={{...initial,revision:value.revision}} selectedGroupIds={viewGroupIds}
          onClose={() => setViewGroupIds(null)}
          onDocumentChanged={async () => {
            const [latest,history] = await Promise.all([api(`/documents/${encodeURIComponent(initial.id)}`),api(`/documents/${encodeURIComponent(initial.id)}/conversations`)]);
            setValue((old) => ({...old,revision:latest.revision}));
            if (!history.conversations?.length) { const clean = removeQaMarks(htmlRef.current); setBodyHtml(clean); htmlRef.current=clean; initialQaIds.current=[]; }
          }} />
      </div>, window.document.body)}
    </form>
  );
}
