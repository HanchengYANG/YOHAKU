import test from "node:test";
import assert from "node:assert/strict";
import { changeImageImportDirection, imageImportDraft, imageImportFiles, recognizeImageBatch } from "../client/image-import.mjs";
import { bodyRanges, bodyText } from "../shared/article-html.mjs";
import { parseText } from "../shared/document.mjs";

const file = (name) => ({ name, type: "image/png", size: 10 });
const entries = () => [{ id: "queue-a", file: file("first.png") }, { id: "queue-b", file: file("second.png") }];
const draft = (content) => ({ content, blocks: parseText(content), title: "图片文章" });

function pipeline({ failFirstAnnotation = false } = {}) {
  const calls = { uploads: [], recognitions: [], annotations: [] };
  let firstFailed = false;
  return {
    calls, cache: new Map(),
    upload: async (value) => { calls.uploads.push(value.name); return { id: value.name === "first.png" ? "image-a" : "image-b" }; },
    recognize: async (id) => { calls.recognitions.push(id); return draft(id === "image-a" ? "日本" : "語"); },
    annotate: async (id, content) => {
      calls.annotations.push(id);
      if (failFirstAnnotation && id === "image-a" && !firstFailed) { firstFailed = true; throw new Error("暂时无法注音"); }
      const result = draft(content);
      if (id === "image-a") result.blocks[0].segments[0] = { ...result.blocks[0].segments[0], reading: "にほん", origin: "generated" };
      return result;
    },
  };
}

test("批量图片在重试和重排后仍复用各自已上传及识别结果", async () => {
  const items = entries(), actions = pipeline({ failFirstAnnotation: true });
  const updates = []; actions.onUpdate = (step) => updates.push(step);
  await assert.rejects(recognizeImageBatch(items, actions), /暂时无法注音/);
  assert.equal(updates[0].phase, "upload");
  assert.equal(updates[0].uploadPercent, 0);
  assert.ok(updates.filter((step) => step.phase !== "upload").every((step) => step.uploadPercent === null));
  assert.ok(actions.cache.get("queue-a").recognized);
  assert.equal(actions.cache.get("queue-a").annotated, undefined);
  const completed = await recognizeImageBatch([items[1], items[0]], actions);
  assert.deepEqual(completed.map((entry) => entry.image.id), ["image-b", "image-a"]);
  assert.deepEqual(actions.calls.uploads, ["first.png", "second.png"]);
  assert.deepEqual(actions.calls.recognitions, ["image-a", "image-b"]);
  assert.deepEqual(actions.calls.annotations, ["image-a", "image-b", "image-a"]);
  const combined = imageImportDraft(completed, { title: "自定标题", bookId: "book-a", targetId: "article-a" });
  assert.equal(combined.title, "自定标题");
  assert.equal(combined.bookId, "book-a");
  assert.equal(combined.appendToDocumentId, "article-a");
  assert.equal(bodyText(combined.bodyHtml), "語日本");
  assert.deepEqual(combined.sourceImages.map((entry) => entry.id), ["image-b", "image-a"]);
  assert.deepEqual(bodyRanges(combined.bodyHtml).sources.map(({ id, start, end }) => ({ id, start, end })), [
    { id: "image-b", start: 0, end: 1 }, { id: "image-a", start: 1, end: 3 },
  ]);
  assert.match(combined.bodyHtml, /<rt>にほん<\/rt>/);
  assert.equal(combined.autoAnnotationCompleted, true);
});

test("改变正文的注音被拒绝，先校对正文仍包含整批图片", async () => {
  const items = entries(), actions = pipeline();
  actions.annotate = async () => draft("正文被改写");
  await assert.rejects(recognizeImageBatch(items, actions), /注音结果改变了正文/);
  assert.equal(actions.cache.get("queue-a").recognized.content, "日本");
  assert.equal(actions.cache.get("queue-a").annotated, undefined);
  const completed = await recognizeImageBatch(items, { ...actions, skipAnnotation: true });
  assert.deepEqual(actions.calls.uploads, ["first.png", "second.png"]);
  assert.deepEqual(actions.calls.recognitions, ["image-a", "image-b"]);
  const combined = imageImportDraft(completed);
  assert.equal(bodyText(combined.bodyHtml), "日本語");
  assert.equal(combined.sourceImages.length, 2);
  assert.equal(combined.autoAnnotationCompleted, false);
});

test("离开批量导入后不再继续注音或下一张上传", async () => {
  const actions = pipeline(), controller = new AbortController();
  actions.recognize = async () => { controller.abort(); return draft("日本"); };
  await assert.rejects(recognizeImageBatch(entries(), { ...actions, signal: controller.signal }), { name: "AbortError" });
  assert.deepEqual(actions.calls.uploads, ["first.png"]);
  assert.deepEqual(actions.calls.annotations, []);
});

test("文件选择在加入队列前检查每张格式、大小和文章图片上限", () => {
  assert.equal(imageImportFiles([file("a.png"), file("b.png")], 98).length, 2);
  assert.throws(() => imageImportFiles([file("a.png"), file("b.png")], 99), /100 张/);
  assert.throws(() => imageImportFiles([file("a.png"), { ...file("bad.gif"), type: "image/gif" }]), /bad.gif.*PNG、JPEG 或 WebP/);
  assert.throws(() => imageImportFiles([{ ...file("large.png"), size: 12 * 1024 * 1024 + 1 }]), /大小不超过 12 MB/);
});

test("先保存实际图片方向再识别，注音失败重试不重复旋转", async () => {
  const actions = pipeline({ failFirstAnnotation: true }), calls = [];
  const entry = { ...entries()[0], quarterTurns: 3 };
  actions.upload = async () => { calls.push("upload"); return { id: "image-a", revision: 1 }; };
  actions.rotate = async (id, value) => { calls.push([id, value]); return { id, revision: 2, width: 600, height: 800 }; };
  const recognize = actions.recognize;
  actions.recognize = async (id) => { calls.push("recognize"); return recognize(id); };
  await assert.rejects(recognizeImageBatch([entry], actions), /暂时无法注音/);
  assert.deepEqual(calls, ["upload", ["image-a", { quarterTurns: 3, revision: 1 }], "recognize"]);
  const completed = await recognizeImageBatch([entry], actions);
  assert.equal(calls.length, 3);
  assert.equal(completed[0].image.revision, 2);
  assert.equal(completed[0].appliedTurns, 3);
});

test("更改已处理图片的方向会失效OCR和注音，仅旋转剩余角度并保留其他图片缓存", async () => {
  const actions = pipeline(), rotations = [];
  actions.upload = async (value) => ({ id: value.name === "first.png" ? "image-a" : "image-b", revision: 1 });
  actions.rotate = async (id, value) => { rotations.push(value); return { id, revision: value.revision + 1 }; };
  let items = entries();
  await recognizeImageBatch(items, actions);
  items = [changeImageImportDirection(items[0], -1, actions.cache), items[1]];
  assert.equal(actions.cache.get("queue-a").recognized, undefined);
  assert.equal(actions.cache.get("queue-a").annotated, undefined);
  assert.ok(actions.cache.get("queue-b").annotated);
  await recognizeImageBatch(items, actions);
  items = [changeImageImportDirection(items[0], 1, actions.cache), items[1]];
  await recognizeImageBatch(items, actions);
  assert.deepEqual(rotations, [{ quarterTurns: 3, revision: 1 }, { quarterTurns: 1, revision: 2 }]);
  assert.deepEqual(actions.calls.recognitions, ["image-a", "image-b", "image-a", "image-a"]);
});

test("方向保存响应丢失或版本异常时从本地原图重试，不在未知像素上累积旋转", async () => {
  const actions = pipeline(), uploaded = [], rotations = [];
  let failure = true;
  actions.upload = async () => { const id = `image-${uploaded.length}`; uploaded.push(id); return { id, revision: 1 }; };
  actions.rotate = async (id, value) => {
    rotations.push([id, value]);
    if (failure) { failure = false; return { id, revision: 10 }; }
    return { id, revision: 2 };
  };
  const entry = { ...entries()[0], quarterTurns: 1 };
  await assert.rejects(recognizeImageBatch([entry], actions), /图片方向未确认.*重新上传/);
  assert.equal(actions.cache.get(entry.id).image, undefined);
  assert.equal(actions.calls.recognitions.length, 0);
  await recognizeImageBatch([entry], actions);
  assert.deepEqual(uploaded, ["image-0", "image-1"]);
  assert.deepEqual(rotations, [["image-0", { quarterTurns: 1, revision: 1 }], ["image-1", { quarterTurns: 1, revision: 1 }]]);
});

test("方向保存后取消不再识别或注音", async () => {
  const actions = pipeline(), controller = new AbortController();
  actions.upload = async () => ({ id: "image-a", revision: 1 });
  actions.rotate = async (id) => { controller.abort(); return { id, revision: 2 }; };
  await assert.rejects(recognizeImageBatch([{ ...entries()[0], quarterTurns: 1 }], { ...actions, signal: controller.signal }), { name: "AbortError" });
  assert.equal(actions.calls.recognitions.length, 0);
  assert.equal(actions.calls.annotations.length, 0);
  assert.equal(actions.cache.get("queue-a").appliedTurns, 1);
});
