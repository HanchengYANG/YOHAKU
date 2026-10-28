import { useCallback, useEffect, useRef, useState } from "react";
import { plainText } from "../../shared/document.mjs";
import api from "../api.mjs";
import Icon from "./Icon.jsx";

const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxBytes = 12 * 1024 * 1024;

export default function ImageImport({ onCancel, onReady, onDirty }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [image, setImage] = useState(null);
  const [recognizedDraft, setRecognizedDraft] = useState(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const fileInput = useRef(null);
  const pending = useRef(null);
  const importStartedAt = useRef(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      pending.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!file) {
      setPreview("");
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    setPreview(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [file]);

  const chooseFiles = useCallback(
    (fileList, fromPicker = false) => {
      const files = Array.from(fileList || []);
      if (!files.length) return;
      if (pending.current) {
        setError("正在处理图片，请完成后再更换图片。");
        return false;
      }
      if (files.length !== 1) {
        setError("一次只支持一张图片，请分开导入。当前图片未更换。");
        return false;
      }
      const selected = files[0];
      if (!allowedTypes.has(selected.type)) {
        setError("请选择 PNG、JPEG 或 WebP 图片。当前图片未更换。");
        return false;
      }
      if (!selected.size || selected.size > maxBytes) {
        setError("图片需要有内容，且大小不超过 12 MB。当前图片未更换。");
        return false;
      }
      setError("");
      setFile(selected);
      setImage(null);
      setRecognizedDraft(null);
      importStartedAt.current = null;
      setPreviewError(false);
      onDirty?.(true);
      if (fileInput.current && !fromPicker) fileInput.current.value = "";
      return true;
    },
    [onDirty],
  );

  useEffect(() => {
    const paste = (event) => {
      const data = event.clipboardData;
      if (!data) return;
      const files = data.files.length
        ? Array.from(data.files)
        : Array.from(data.items)
            .filter((item) => item.kind === "file")
            .map((item) => item.getAsFile())
            .filter(Boolean);
      if (!files.length) return;
      event.preventDefault();
      chooseFiles(files);
    };
    window.addEventListener("paste", paste);
    return () => window.removeEventListener("paste", paste);
  }, [chooseFiles]);

  const dragOver = (event) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = pending.current ? "none" : "copy";
    setDragActive(!pending.current);
  };
  const drop = (event) => {
    if (!Array.from(event.dataTransfer.types).includes("Files")) return;
    event.preventDefault();
    setDragActive(false);
    chooseFiles(event.dataTransfer.files);
  };

  const recognize = async () => {
    if (!file || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setError("");
    let uploaded = image;
    let draft = recognizedDraft;
    try {
      if (!uploaded) {
        setPhase("upload");
        const body = new FormData();
        const extension =
          file.type === "image/jpeg"
            ? "jpg"
            : file.type === "image/webp"
              ? "webp"
              : "png";
        body.append("image", file, file.name || `粘贴的图片.${extension}`);
        const response = await fetch("/api/images", {
          method: "POST",
          body,
          signal: controller.signal,
        });
        const result = await response
          .json()
          .catch(() => ({ error: "图片上传未完成，请重试。" }));
        if (!response.ok)
          throw new Error(result.error || "图片上传未完成，请重试。");
        if (typeof result.id !== "string")
          throw new Error("图片上传结果无效，请重试。");
        uploaded = result;
        if (mounted.current) setImage(uploaded);
      }
      if (!mounted.current || controller.signal.aborted) return;
      if (importStartedAt.current === null) {
        importStartedAt.current = performance.now();
        performance.mark("yohaku:ocr-upload-complete");
      }
      if (!draft) {
        setPhase("recognize");
        draft = await api(
          `/images/${encodeURIComponent(uploaded.id)}/recognize`,
          {
            method: "POST",
            body: JSON.stringify({ engine: "llm" }),
            signal: controller.signal,
          },
        );
        if (!mounted.current || controller.signal.aborted) return;
        setRecognizedDraft(draft);
      }
      setPhase("annotate");
      const annotationStartedAt = performance.now();
      const annotated = await api(`/images/${encodeURIComponent(uploaded.id)}/annotate`, {
        method: "POST",
        body: JSON.stringify({ content: draft.content, manualReadings: [] }),
        signal: controller.signal,
      });
      if (!mounted.current || controller.signal.aborted) return;
      if (!Array.isArray(annotated?.blocks) || plainText(annotated.blocks) !== plainText(draft.blocks))
        throw new Error("注音结果改变了正文，已拒绝应用；已完成的正文保留，请重试注音。");
      if (mounted.current) {
        onDirty?.(false);
        onReady({ ...annotated, sourceImageId: uploaded.id,
          importStartedAt: importStartedAt.current, annotationStartedAt,
          autoAnnotationCompleted: true });
      }
    } catch (e) {
      if (mounted.current && e.name !== "AbortError")
        setError(
          e instanceof TypeError
            ? "无法连接本机服务，所选图片已保留，请重试。"
            : e.message,
        );
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setPhase("");
    }
  };

  const reviewBody = () => {
    if (pending.current || !recognizedDraft || !image) return;
    onDirty?.(false);
    onReady({ ...recognizedDraft, sourceImageId: image.id,
      importStartedAt: importStartedAt.current, autoAnnotationCompleted: false,
      annotationError: error });
  };

  const busy = !!phase;

  return (
    <section
      className="stage2-page image-import-page"
      aria-label="图片导入"
      aria-busy={busy}
      onDragOver={dragOver}
      onDrop={drop}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setDragActive(false);
      }}
    >
      <div className="stage2-heading">
        <div>
          <span className="eyebrow">从原图开始</span>
          <h1>导入照片或截图</h1>
        </div>
        <button
          className="button subtle"
          type="button"
          disabled={busy}
          onClick={onCancel}
        >
          取消
        </button>
      </div>
      <p className="stage2-description">
        截图可直接粘贴，也可拖入图片或从设备选择照片。识别与注音会自动连续完成，再对照原图校对并保存到书架。
      </p>
      {error && (
        <div className="stage2-error" role="alert">
          {error}
          {recognizedDraft ? (
            <p>正文已完成并保留，重试只继续注音，不会重新上传或识别。</p>
          ) : image ? (
            <p>原图已上传，重试会继续使用这张图片。</p>
          ) : (
            file && <p>所选图片已保留，无需重新选择。</p>
          )}
        </div>
      )}
      <div className="image-import-workspace">
        <div
          className={`image-import-preview ${dragActive ? "is-dragging" : ""}`}
        >
          <button
            className="image-preview-picker"
            type="button"
            aria-label="点击选择或更换图片"
            aria-describedby="image-input-help"
            disabled={busy}
            onClick={() => {
              if (!pending.current) fileInput.current?.click();
            }}
          >
            {preview && !previewError ? (
              <img
                src={preview}
                alt="待识别的日语原图"
                onError={() => setPreviewError(true)}
              />
            ) : (
              <span className="image-preview-empty">
                <Icon name="book" size={32} />
                <span className="image-preview-message">
                  {previewError ? "这张图片暂时无法预览" : "点击选择一张图片"}
                </span>
                <small>也可拖放图片，或按 Ctrl / Cmd + V 粘贴截图</small>
              </span>
            )}
            {preview && !previewError && (
              <span className="image-preview-change">点击更换图片</span>
            )}
          </button>
        </div>
        <div className="image-import-controls">
          <label className="stage2-field image-file-picker">
            从设备选择图片
            <input
              aria-label="选择日语图片"
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={(event) => {
                if (!chooseFiles(event.target.files, true))
                  event.target.value = "";
              }}
            />
          </label>
          <p className="image-file-hint" id="image-input-help">
            一次一张，PNG、JPEG 或 WebP，最大 12 MB。
          </p>
          {file && (
            <div className="image-file-details">
              <strong>{file.name || "粘贴的截图"}</strong>
              <span>
                {(file.size / 1024 / 1024).toFixed(2)} MB
                {image ? ` · ${image.width} × ${image.height}` : ""}
              </span>
              <span>{image ? "原图已上传" : "等待上传"}</span>
            </div>
          )}
          <div className="image-recognition-note">
            <p>一次点击，自动识别并纠正正文，再参考原图生成含汉字完整词的假名。</p>
            <p>完成后可一起校对正文和读音。小注音、页码和手写批注不混入正文。</p>
            <p>
              照片的阴影、弯曲、反光和模糊可能影响正文识别，请在下一步确认。
            </p>
          </div>
          <button
            className="button primary"
            type="button"
            disabled={!file || busy}
            onClick={recognize}
          >
            <Icon name="arrow" size={17} />
            {phase === "upload"
              ? "正在上传原图…"
              : phase === "recognize"
                ? "正在识别正文（1/2）…"
                : phase === "annotate"
                  ? "正在参考原图注音（2/2）…"
                  : recognizedDraft
                    ? "重试注音"
                    : image
                      ? "重试识别"
                      : "识别并注音"}
          </button>
          {recognizedDraft && error && !busy && (
            <button type="button" className="button subtle" onClick={reviewBody}>
              先校对正文
            </button>
          )}
          <p className="image-recognition-state" role="status">
            {phase === "recognize"
              ? "正在识别并校正正文，随后会自动开始参考原图注音。"
              : phase === "annotate"
                ? "正文已完成，正在参考原图生成注音；两步完成后打开校对草稿。"
                : "识别与注音完成后进入校对草稿，不会自动保存为最终原文。"}
          </p>
        </div>
      </div>
    </section>
  );
}
