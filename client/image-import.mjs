import { plainText, serializeBlocks } from "../shared/document.mjs";
import { appendImageBodyHtml, blocksToHtml, htmlToBlocks } from "../shared/article-html.mjs";

const allowedTypes = new Set(["image/png", "image/jpeg", "image/webp"]);
const maxBytes = 12 * 1024 * 1024;
const turns = (value = 0) => ((value % 4) + 4) % 4;
const clearRecognition = (item) => {
  for (const key of ["recognized", "annotated", "importStartedAt", "annotationStartedAt"]) delete item[key];
};

export function changeImageImportDirection(entry, delta, cache) {
  const next = { ...entry, quarterTurns: turns((entry.quarterTurns || 0) + delta) };
  const item = cache.get(entry.id);
  if (item) clearRecognition(item);
  return next;
}

export function imageImportFiles(fileList, selectedCount = 0) {
  const files = Array.from(fileList || []);
  if (selectedCount + files.length > 100) throw new Error("一篇文章最多支持 100 张图片，当前队列已保留。");
  for (const file of files) {
    if (!allowedTypes.has(file.type)) throw new Error(`「${file.name || "这张图片"}」请选择 PNG、JPEG 或 WebP 图片，当前队列已保留。`);
    if (!file.size || file.size > maxBytes) throw new Error(`「${file.name || "这张图片"}」需要有内容，且大小不超过 12 MB，当前队列已保留。`);
  }
  return files;
}

// Cache by queue identity, so sorting or retrying never repeats successful work.
export async function recognizeImageBatch(entries, {
  cache, signal, upload, rotate, recognize, annotate, onUpdate, skipAnnotation = false,
  now = () => performance.now(),
}) {
  const results = [];
  for (const [index, entry] of entries.entries()) {
    signal?.throwIfAborted();
    let item = cache.get(entry.id);
    if (!item) { item = {}; cache.set(entry.id, item); }
    const targetTurns = turns(entry.quarterTurns);
    if (turns(item.appliedTurns) !== targetTurns) clearRecognition(item);
    const update = (phase, uploadPercent = null) => onUpdate?.({ id: entry.id, index, phase, uploadPercent });
    const firstPhase = !item.image ? "upload" : turns(item.appliedTurns) !== targetTurns ? "rotate" : item.recognized ? "annotate" : "recognize";
    update(firstPhase, firstPhase === "upload" ? 0 : null);
    if (!item.image) {
      item.image = await upload(entry.file, {
        signal, onProgress: (percentage) => update("upload", percentage),
      });
      item.appliedTurns = 0;
      signal?.throwIfAborted();
    }
    if (item.importStartedAt === undefined) item.importStartedAt = now();
    const rotation = turns(targetTurns - (item.appliedTurns || 0));
    if (rotation) {
      update("rotate");
      try {
        const previous = item.image;
        const image = await rotate(previous.id, { quarterTurns: rotation, revision: previous.revision }, { signal });
        if (image?.id !== previous.id || !Number.isSafeInteger(image.revision) || image.revision !== previous.revision + 1)
          throw new Error("图片版本返回异常。");
        item.image = image;
        item.appliedTurns = targetTurns;
      } catch (cause) {
        // A lost reply can follow a committed rotation. Retry from the local
        // original instead of risking applying the same turn a second time.
        delete item.image; delete item.appliedTurns; clearRecognition(item);
        if (cause.name === "AbortError") throw cause;
        throw new Error(`${cause.message} 图片方向未确认，重试会重新上传本张原图后再保存方向。`);
      }
      signal?.throwIfAborted();
    }
    if (!item.recognized) {
      update("recognize");
      const recognized = await recognize(item.image.id, { signal });
      signal?.throwIfAborted();
      if (!Array.isArray(recognized?.blocks)) throw new Error("图片识别结果缺少有效正文，请重试识别。");
      item.recognized = recognized;
    }
    if (!skipAnnotation && !item.annotated) {
      update("annotate");
      item.annotationStartedAt = now();
      const annotated = await annotate(item.image.id, item.recognized.content, { signal });
      signal?.throwIfAborted();
      if (!Array.isArray(annotated?.blocks) || plainText(annotated.blocks) !== plainText(item.recognized.blocks))
        throw new Error("注音结果改变了正文，已拒绝应用；已完成的正文保留，请重试注音。");
      item.annotated = annotated;
    }
    results.push({ ...entry, ...item });
  }
  return results;
}

export function imageImportDraft(entries, { title = "", bookId = null, targetId = null, annotationError = "" } = {}) {
  if (!entries.length) throw new Error("请先选择图片。");
  const fragments = entries.map((entry) => blocksToHtml((entry.annotated || entry.recognized).blocks, { sourceImageId: entry.image.id }));
  const bodyHtml = fragments.slice(1).reduce((html, fragment) => appendImageBodyHtml(html, fragment), fragments[0]);
  const blocks = htmlToBlocks(bodyHtml);
  const sourceImages = entries.map((entry) => ({
    id: entry.image.id,
    name: entry.file.name || "粘贴的截图",
    recognition: {
      ...(entry.annotated || {}), ...entry.recognized,
      sourceImageId: entry.image.id,
      sourceImage: entry.image,
      autoAnnotationCompleted: !!entry.annotated,
    },
  }));
  const first = entries[0], draft = first.annotated || first.recognized;
  return {
    ...draft,
    title: title.trim() || draft.title || first.file.name.replace(/\.[^.]+$/, "") || "图片文章",
    bookId: bookId || null,
    ...(bookId ? { kind: "book" } : {}),
    bodyHtml, blocks, content: serializeBlocks(blocks), sourceImages,
    sourceImageId: first.image.id, sourceImage: first.image, recognition: sourceImages[0].recognition,
    appendedImageId: first.image.id,
    appendToDocumentId: targetId || null,
    importStartedAt: first.importStartedAt,
    annotationStartedAt: first.annotationStartedAt,
    autoAnnotationCompleted: entries.every((entry) => !!entry.annotated),
    annotationError,
    initializeSentences: true,
  };
}
