import { normalizeBodyHtml, bodyText, htmlToBlocks, syncBodyReadings } from "../../shared/article-html.mjs";
import { serializeBlocks } from "../../shared/document.mjs";
import { buildOcrAnnotationPrompt, applyOcrAnnotations, ocrAnnotationTargetCount } from "../../shared/ocr-correction.mjs";

const fail = (message) => Object.assign(new Error(message), { status: 400, expose: true });

// Keep canonical HTML as the authority: block conversion is only the model's
// input, and readings are projected back without changing any document marks.
export function prepareBodyAnnotation(bodyHtml, { referenceImage = false } = {}) {
  const html = normalizeBodyHtml(bodyHtml), text = bodyText(html);
  if (!text.trim() || text.length > 200000) throw fail("请提供有效的待注音正文，最多 200000 字。");
  const blocks = htmlToBlocks(html).map((block) => ({ ...block,
    type: block.type || "paragraph", sourcePage: "unknown", confidence: "high",
  }));
  return { bodyHtml: html, blocks, targetCount: ocrAnnotationTargetCount(blocks),
    prompt: buildOcrAnnotationPrompt(blocks, { referenceImage }) };
}

export function applyBodyAnnotation(raw, prepared) {
  const blocks = applyOcrAnnotations(raw, prepared.blocks);
  const bodyHtml = syncBodyReadings(prepared.bodyHtml, blocks);
  if (bodyText(bodyHtml) !== bodyText(prepared.bodyHtml)) throw fail("注音结果改变了正文，未应用。");
  return { bodyHtml, blocks, content: serializeBlocks(blocks) };
}
