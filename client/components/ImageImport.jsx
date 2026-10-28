import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";

const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxBytes = 12 * 1024 * 1024;

export default function ImageImport({ onCancel, onReady, onDirty }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState("");
  const [previewError, setPreviewError] = useState(false);
  const [image, setImage] = useState(null);
  const [phase, setPhase] = useState("");
  const [error, setError] = useState("");
  const pending = useRef(null);
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

  const chooseFile = (event) => {
    const selected = event.target.files?.[0];
    if (!selected) return;
    setError("");
    if (!allowedTypes.has(selected.type)) {
      setError("请选择 PNG、JPEG 或 WebP 图片。");
      setFile(null);
      setImage(null);
      onDirty?.(false);
      event.target.value = "";
      return;
    }
    if (!selected.size || selected.size > maxBytes) {
      setError("图片需要有内容，且大小不超过 12 MB。");
      setFile(null);
      setImage(null);
      onDirty?.(false);
      event.target.value = "";
      return;
    }
    setFile(selected);
    setImage(null);
    setPreviewError(false);
    onDirty?.(true);
  };

  const recognize = async () => {
    if (!file || pending.current) return;
    const controller = new AbortController();
    pending.current = controller;
    setError("");
    let uploaded = image;
    try {
      if (!uploaded) {
        setPhase("upload");
        const body = new FormData();
        body.append("image", file);
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
      if (controller.signal.aborted) return;
      setPhase("recognize");
      const draft = await api(
        `/images/${encodeURIComponent(uploaded.id)}/recognize`,
        {
          method: "POST",
          body: "{}",
          signal: controller.signal,
        },
      );
      if (mounted.current) {
        onDirty?.(false);
        onReady({ ...draft, sourceImageId: uploaded.id });
      }
    } catch (e) {
      if (mounted.current && e.name !== "AbortError") setError(e.message);
    } finally {
      if (pending.current === controller) pending.current = null;
      if (mounted.current) setPhase("");
    }
  };

  const busy = !!phase;

  return (
    <section className="stage2-page image-import-page" aria-label="图片导入">
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
        识别后先对照原图校对正文、分行和注音，再保存到书架。原图会保留。
      </p>
      {error && (
        <div className="stage2-error" role="alert">
          {error}
          {image && <p>原图已上传，重试会继续使用这张图片。</p>}
        </div>
      )}
      <div className="image-import-workspace">
        <div className="image-import-preview">
          {preview && !previewError ? (
            <img
              src={preview}
              alt="待识别的日语原图"
              onError={() => setPreviewError(true)}
            />
          ) : (
            <div className="image-preview-empty">
              <Icon name="book" size={32} />
              <p>
                {previewError
                  ? "这张图片暂时无法预览"
                  : "选择一张想读的日语图片"}
              </p>
              <small>截图、横排教材或竖排书页</small>
            </div>
          )}
        </div>
        <div className="image-import-controls">
          <label className="stage2-field image-file-picker">
            原始图片
            <input
              aria-label="选择日语图片"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              disabled={busy}
              onChange={chooseFile}
            />
          </label>
          <p className="image-file-hint">PNG、JPEG 或 WebP，最大 12 MB。</p>
          {file && (
            <div className="image-file-details">
              <strong>{file.name}</strong>
              <span>
                {(file.size / 1024 / 1024).toFixed(2)} MB
                {image ? ` · ${image.width} × ${image.height}` : ""}
              </span>
              <span>{image ? "原图已上传" : "等待上传"}</span>
            </div>
          )}
          <div className="image-recognition-note">
            <p>会尝试分别识别正文、原有注音、手写批注和页码。</p>
            <p>照片的阴影、弯曲和细小注音可能影响识别，请在下一步逐项确认。</p>
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
                ? "正在识别正文与注音…"
                : image
                  ? "重新识别这张图片"
                  : "识别图片"}
          </button>
          <p className="image-recognition-state" role="status">
            {phase === "recognize"
              ? "AI 正在读取原图，请稍候。完成后会打开可编辑的校对草稿。"
              : "此步骤不会自动把识别结果存为最终原文。"}
          </p>
        </div>
      </div>
    </section>
  );
}
