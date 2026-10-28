import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import {
  OCR_SCHEMA, OCR_PROMPT, OCR_BODY_SCHEMA, OCR_TRANSCRIPTION_PROMPT,
  expandOcrBody, validateOcr, normalizeNewOcrDraft,
} from "../shared/ocr.mjs";
import { plainText, serializeBlocks } from "../shared/document.mjs";
import { createImageStore } from "../server/ai/images.mjs";

const result = () => ({
  title: "识别草稿",
  kind: "textbook",
  orientation: "horizontal",
  readingOrder: "本页横排，从上到下、从左到右。",
  blocks: [
    {
      type: "paragraph",
      confidence: "high",
      sourcePage: "single",
      segments: [
        { text: "背中", reading: "せなか", origin: "generated" },
        { text: "を", reading: null, origin: null },
        { text: "撫でる", reading: "なでる", origin: "generated" },
      ],
    },
    { type: "paragraph", confidence: "high", sourcePage: "single", segments: [] },
    {
      type: "paragraph",
      confidence: "uncertain",
      sourcePage: "single",
      segments: [
        { text: "生まれた", reading: "うまれた", origin: "generated" },
        { text: "□", reading: null, origin: null },
      ],
    },
  ],
  warnings: [
    { blockIndex: 2, message: "行末一个字被手指遮挡，请对照原图确认。" },
  ],
  nonBody: [
    { type: "handwriting", text: "绿色手写批注", page: "single" },
    { type: "page_number", text: "62", page: "single" },
  ],
});

test("正文阶段只收text，保留模型整理的段落和歌词分行，所有读音为空", () => {
  const raw = { text: "名字\r\n\r\n中国語の「名字」は姓と名の両方。\r\n眞人のお父さん。３７歳。\r\n\r\n歌の一行目\r\n歌の二行目" };
  const snapshot = structuredClone(raw);
  const draft = validateOcr(expandOcrBody(raw));
  assert.equal(plainText(draft.blocks), raw.text.replace(/\r\n/g, "\n"));
  assert.deepEqual(draft.blocks.map((block) => block.segments.map((segment) => segment.text).join("")), [
    "名字", "", "中国語の「名字」は姓と名の両方。", "眞人のお父さん。３７歳。", "", "歌の一行目", "歌の二行目",
  ]);
  assert.ok(draft.blocks.every((block) => block.type === "paragraph" && block.sourcePage === "unknown"));
  assert.ok(draft.blocks.flatMap((block) => block.segments)
    .every((segment) => segment.reading === null && segment.origin === null));
  assert.equal(draft.title, "名字");
  assert.equal(draft.kind, "article");
  assert.equal(draft.orientation, "horizontal");
  assert.match(draft.readingOrder, /按图片读序/);
  assert.match(draft.readingOrder, /注音另行执行/);
  assert.deepEqual(draft.warnings, []);
  assert.deepEqual(draft.nonBody, []);
  assert.deepEqual(raw, snapshot);
  assert.equal(OCR_BODY_SCHEMA.additionalProperties, false);
  assert.deepEqual(OCR_BODY_SCHEMA.required, ["text"]);
  assert.deepEqual(Object.keys(OCR_BODY_SCHEMA.properties), ["text"]);
});

test("正文适配不猜标题层级、列表或注音语法，长首行用默认标题", () => {
  const value = "原文".repeat(21) + "\n# 実際の記号\n{宇宙|そら}\n- 原文の記号";
  const draft = validateOcr(expandOcrBody({ text: value }));
  assert.equal(draft.title, "待校对的日语材料");
  assert.equal(plainText(draft.blocks), value);
  assert.ok(draft.blocks.every((block) => block.type === "paragraph"));
  assert.ok(draft.blocks.flatMap((block) => block.segments).every((segment) => segment.reading === null));
  assert.match(OCR_TRANSCRIPTION_PROMPT, /校正明显OCR识别错误/);
  assert.match(OCR_TRANSCRIPTION_PROMPT, /不注音/);
});

test("正文长段落分片保留补充平面汉字与全部空白，不增加段落", () => {
  const value = "  " + "あ".repeat(9997) + "𠮷" + "語".repeat(10020) + "  ";
  const draft = validateOcr(expandOcrBody({ text: value }));
  assert.equal(draft.blocks.length, 1);
  assert.equal(plainText(draft.blocks), value);
  assert.ok(draft.blocks[0].segments.every((segment) => segment.text.length <= 10000));
  assert.ok(draft.blocks[0].segments.every((segment) => !/[\ud800-\udbff]$/.test(segment.text)));
});

test("正文阶段拒绝空结果、多余读音字段、HTML、控制字符与超限文字", () => {
  for (const raw of [null, {}, [], { text: "" }, { text: " \n\t" }, { text: 1 },
    { text: "東京", reading: "とうきょう" }, { text: "東京", blocks: [] },
    { text: "<ruby>東京</ruby>" }, { text: "東京\u0000" }, { text: "字".repeat(200001) },
    { text: Array.from({ length: 2001 }, () => "字").join("\n") }])
    assert.throws(() => expandOcrBody(raw), /识别结果格式有误/);
});

test("历史完整草稿保留正文分行与生成词组注音，批注与页码独立", () => {
  const raw = result();
  const parsed = validateOcr(raw);
  assert.equal(plainText(parsed.blocks), "背中を撫でる\n\n生まれた□");
  assert.equal(
    serializeBlocks(parsed.blocks),
    "{背中|せなか}を{撫でる|なでる}\n\n{生まれた|うまれた}□",
  );
  assert.equal(parsed.blocks[0].segments[0].origin, "generated");
  assert.equal(parsed.blocks[0].segments[2].origin, "generated");
  assert.equal(parsed.blocks[2].confidence, "uncertain");
  assert.deepEqual(parsed.nonBody, raw.nonBody);
  assert.ok(!plainText(parsed.blocks).includes("绿色手写批注"));
  assert.match(parsed.blocks[0].id, /^[0-9a-f-]{36}$/);
  assert.notEqual(parsed.blocks[0].id, validateOcr(raw).blocks[0].id);
  assert.equal(Object.hasOwn(raw.blocks[0], "id"), false);
});

test("历史source草稿继续保留特殊读音和竖排页序，不改写旧来源", () => {
  const raw = result();
  raw.orientation = "vertical";
  raw.readingOrder = "先右页、再左页；每页列从右到左，每列从上到下。";
  raw.blocks = [
    {
      confidence: "high",
      sourcePage: "right",
      segments: [{ text: "宇宙", reading: "そら", origin: "source" }],
    },
    {
      confidence: "high",
      sourcePage: "left",
      segments: [
        { text: "生", reading: "う", origin: "source" },
        { text: "まれた", reading: null, origin: null },
      ],
    },
  ];
  raw.warnings = [];
  const parsed = validateOcr(raw);
  assert.equal(parsed.orientation, "vertical");
  assert.deepEqual(
    parsed.blocks.map((b) => b.sourcePage),
    ["right", "left"],
  );
  assert.equal(parsed.blocks[0].segments[0].reading, "そら");
  assert.equal(parsed.blocks[0].segments[0].origin, "source");
  assert.ok(parsed.blocks.every((block) => block.type === "paragraph"));
  assert.ok(raw.blocks.every((block) => !Object.hasOwn(block, "type")));
  assert.deepEqual(raw.blocks[0].segments[0], {
    text: "宇宙",
    reading: "そら",
    origin: "source",
  });
  assert.deepEqual(parsed.blocks[1].segments, raw.blocks[1].segments);
  assert.match(OCR_PROMPT, /先读右页、再读左页/);
});

test("受控块类型与空块规范化不改原词标点或任何segment，输入保持不变", () => {
  const raw = result();
  raw.blocks = [
    {
      type: "heading", confidence: "high", sourcePage: "single",
      segments: [{ text: "登場人物（第２章）", reading: null, origin: null }],
    },
    {
      type: "list_item", confidence: "high", sourcePage: "single",
      segments: [{ text: "アキックスの牧野さん：「ええ……。」", reading: null, origin: null }],
    },
    {
      type: "paragraph", confidence: "high", sourcePage: "single",
      segments: [{ text: "説明の続き。", reading: null, origin: null }],
    },
    { type: "heading", confidence: "high", sourcePage: "single", segments: [] },
  ];
  raw.warnings = [];
  const original = structuredClone(raw);
  const parsed = validateOcr(raw);
  assert.deepEqual(parsed.blocks.map((block) => block.type), [
    "heading", "list_item", "paragraph", "paragraph",
  ]);
  assert.deepEqual(
    parsed.blocks.map((block) => block.segments),
    original.blocks.map((block) => block.segments),
  );
  assert.deepEqual(raw, original);
  assert.equal(raw.blocks[3].type, "heading");
  const blockSchema = OCR_SCHEMA.properties.blocks.items;
  assert.ok(blockSchema.required.includes("type"));
  assert.deepEqual(blockSchema.properties.type.enum, [
    "paragraph", "heading", "list_item",
  ]);
  for (const type of ["html", "script", "bullet", "", null, {}, 1]) {
    raw.blocks[0].type = type;
    assert.throws(() => validateOcr(raw), /正文块类型/);
  }
});

test("按语境提供的同词不同读音与含送假名的完整词形不会被全局替换或拆分", () => {
  const raw = result();
  raw.blocks = [{
    confidence: "high",
    sourcePage: "single",
    segments: [
      { text: "中国語の", reading: null, origin: null },
      { text: "名字", reading: "ミンツー", origin: "generated" },
      { text: "と日本語の", reading: null, origin: null },
      { text: "名字", reading: "みょうじ", origin: "generated" },
      { text: "。", reading: null, origin: null },
      { text: "食べる", reading: "たべる", origin: "generated" },
      { text: "。", reading: null, origin: null },
      { text: "生まれた", reading: "うまれた", origin: "generated" },
      { text: "。", reading: null, origin: null },
    ],
  }];
  raw.warnings = [];
  const parsed = validateOcr(raw);
  assert.deepEqual(parsed.blocks[0].segments, raw.blocks[0].segments);
  assert.deepEqual(
    parsed.blocks[0].segments.filter((s) => s.text === "名字").map((s) => s.reading),
    ["ミンツー", "みょうじ"],
  );
  assert.deepEqual(
    parsed.blocks[0].segments.filter((s) => ["食べる", "生まれた"].includes(s.text)),
    [
      { text: "食べる", reading: "たべる", origin: "generated" },
      { text: "生まれた", reading: "うまれた", origin: "generated" },
    ],
  );
});

test("历史完整Schema允许清晰原图source、上下文generated或无注音", () => {
  const schema = OCR_SCHEMA.properties.blocks.items.properties.segments.items;
  assert.deepEqual(schema.properties.origin.enum, ["source", "generated", null]);
  for (const segment of result().blocks.flatMap((block) => block.segments)) {
    assert.ok(schema.properties.origin.enum.includes(segment.origin));
  }
});

test("清晰特殊source与无注音或模糊处的generated分别保留，整词及数字对应不变", () => {
  const raw = result();
  raw.blocks = [{
    type: "paragraph",
    confidence: "uncertain",
    sourcePage: "single",
    segments: [
      { text: "宇宙", reading: "そら", origin: "source" },
      { text: "食べる", reading: "たべる", origin: "source" },
      { text: "生まれた", reading: "うまれた", origin: "source" },
      { text: "背中", reading: "せなか", origin: "generated" },
      { text: "歩いた", reading: "あるいた", origin: "generated" },
      { text: "37", reading: null, origin: null },
      { text: "歳", reading: "さい", origin: "source" },
      { text: "眞人", reading: null, origin: null },
    ],
  }];
  raw.warnings = [
    { blockIndex: 0, message: "歩いた的小号原注音模糊，按上下文生成；眞人读音仍需确认。" },
  ];
  const parsed = normalizeNewOcrDraft(validateOcr(raw));
  assert.deepEqual(parsed.blocks[0].segments, raw.blocks[0].segments);
  assert.deepEqual(parsed.warnings, raw.warnings);
  assert.equal(parsed.blocks[0].segments[0].reading, "そら");
  assert.equal(parsed.blocks[0].segments[0].origin, "source");
  assert.deepEqual(parsed.blocks[0].segments.slice(1, 3).map((s) => s.text), ["食べる", "生まれた"]);
});

test("仅新草稿去掉无Han片段的冗余注音，纯假名正文与汉字混合整词保持", () => {
  const raw = result();
  raw.blocks = [{
    type: "list_item",
    confidence: "high",
    sourcePage: "single",
    segments: [
      { text: "「", reading: null, origin: null },
      { text: "ここで", reading: "ここで", origin: "generated" },
      { text: "キリコ", reading: "きりこ", origin: "source" },
      { text: "食べる", reading: "たべる", origin: "source" },
      { text: "生まれた", reading: "うまれた", origin: "generated" },
      { text: "お父さん", reading: "おとうさん", origin: "source" },
      { text: "𠮷さん", reading: "よしさん", origin: "generated" },
      { text: "。」", reading: null, origin: null },
    ],
  }];
  raw.warnings = [];
  const parsed = validateOcr(raw);
  const original = structuredClone(parsed);
  const normalized = normalizeNewOcrDraft(parsed);
  assert.notEqual(normalized, parsed);
  assert.notEqual(normalized.blocks[0], parsed.blocks[0]);
  assert.deepEqual(parsed, original);
  assert.equal(parsed.blocks[0].segments[1].reading, "ここで");
  assert.equal(parsed.blocks[0].segments[2].origin, "source");
  assert.equal(plainText(normalized.blocks), plainText(parsed.blocks));
  assert.equal(normalized.blocks[0].type, "list_item");
  assert.equal(normalized.blocks[0].id, parsed.blocks[0].id);
  assert.deepEqual(normalized.blocks[0].segments.slice(1, 3), [
    { text: "ここで", reading: null, origin: null },
    { text: "キリコ", reading: null, origin: null },
  ]);
  assert.deepEqual(normalized.blocks[0].segments.slice(3), parsed.blocks[0].segments.slice(3));
  assert.equal(serializeBlocks(normalized.blocks), '「ここでキリコ{食べる|たべる}{生まれた|うまれた}{お父さん|おとうさん}{𠮷さん|よしさん}。」');
});

test("新草稿保留清晰数字原注音，纯假名清理不丢数量词信息或改写正文", () => {
  const raw = result();
  raw.blocks = [{ confidence: "high", sourcePage: "single", segments: [
    { text: "30", reading: "さんじゅう", origin: "source" },
    { text: "万", reading: "まん", origin: "source" },
    { text: "第１位", reading: "だいいちい", origin: "source" },
    { text: "37", reading: null, origin: null },
    { text: "歳", reading: "さい", origin: "source" },
    { text: "カナ", reading: "かな", origin: "source" },
  ] }];
  raw.warnings = [];
  const parsed = validateOcr(raw), snapshot = structuredClone(parsed);
  const normalized = normalizeNewOcrDraft(parsed);
  assert.deepEqual(normalized.blocks[0].segments.slice(0, 5), parsed.blocks[0].segments.slice(0, 5));
  assert.deepEqual(normalized.blocks[0].segments[5], { text: "カナ", reading: null, origin: null });
  assert.equal(plainText(normalized.blocks), plainText(parsed.blocks));
  assert.deepEqual(parsed, snapshot);
});

test("不确定行缺少模型说明时增加校对提示，模型下标必须有效", () => {
  const raw = result();
  raw.warnings = [];
  assert.deepEqual(validateOcr(raw).warnings, [
    { blockIndex: 2, message: "这一行识别不确定，请对照原图检查正文与读音。" },
  ]);
  for (const blockIndex of [-1, 3, 0.5, "2"]) {
    raw.warnings = [{ blockIndex, message: "不确定" }];
    assert.throws(() => validateOcr(raw), /不存在的行/);
  }
});

test("拒绝模型多余字段、路径或HTML、空正文和无效注音来源", () => {
  const variants = [
    (raw) => {
      raw.path = "/etc/passwd";
    },
    (raw) => {
      raw.blocks[0].id = "model-assigned-id";
    },
    (raw) => {
      raw.blocks[0].segments[0].html = "<ruby>背中</ruby>";
    },
    (raw) => {
      raw.blocks[0].segments[0].text = "<script>alert(1)</script>";
    },
    (raw) => {
      raw.blocks[0].segments[0].origin = "manual";
    },
    (raw) => {
      raw.blocks[0].segments[1].origin = "source";
    },
    (raw) => {
      raw.blocks[0].segments[0].reading = " ";
    },
    (raw) => {
      raw.blocks[0].segments[0].reading = false;
    },
    (raw) => {
      raw.blocks[0].segments[0].text = "背中\n空";
    },
    (raw) => {
      raw.blocks[0].sourcePage = "../left";
    },
    (raw) => {
      raw.blocks = [];
      raw.warnings = [];
    },
    (raw) => {
      raw.blocks = [{ confidence: "high", sourcePage: "single", segments: [] }];
      raw.warnings = [];
    },
    (raw) => {
      raw.title = "長".repeat(161);
    },
    (raw) => {
      raw.nonBody[0].type = "instructions";
    },
    (raw) => {
      raw.blocks[0].segments = [
        { text: "長".repeat(10001), reading: null, origin: null },
      ];
    },
  ];
  for (const mutate of variants) {
    const raw = result();
    mutate(raw);
    assert.throws(() => validateOcr(raw), /识别结果格式有误/);
  }
});

test("Schema 对每个对象禁止额外字段，所有属性均为 required", () => {
  const visit = (schema) => {
    if (schema.type === "object") {
      assert.equal(schema.additionalProperties, false);
      assert.deepEqual(
        [...schema.required].sort(),
        Object.keys(schema.properties).sort(),
      );
      Object.values(schema.properties).forEach(visit);
    }
    if (schema.items) visit(schema.items);
  };
  visit(OCR_SCHEMA);
});

async function temporaryStore(t) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-images-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return { directory, store: createImageStore({ storageDir: directory }) };
}

async function png() {
  return sharp({
    create: { width: 20, height: 30, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
}

test("原图字节和安全元数据持久保存，重开后可读PNG/JPEG/WebP", async (t) => {
  const { directory, store } = await temporaryStore(t);
  for (const [format, mimeType] of [
    ["png", "image/png"],
    ["jpeg", "image/jpeg"],
    ["webp", "image/webp"],
  ]) {
    const buffer = await sharp({
      create: { width: 20, height: 30, channels: 3, background: "#abc" },
    })
      .toFormat(format)
      .toBuffer();
    const image = await store.save(buffer, {
      mimeType,
      originalName: `../../手机\u0000照片.${format}`,
    });
    assert.equal(image.originalName, `手机照片.${format}`);
    assert.equal(image.width, 20);
    assert.equal(image.height, 30);
    assert.equal(image.displayWidth, 20);
    assert.equal(image.orientation, 1);
    assert.deepEqual(await store.read(image.id), buffer);
    assert.deepEqual(
      await createImageStore({ storageDir: directory }).get(image.id),
      image,
    );
    assert.equal((await stat(image.path)).mode & 0o777, 0o600);
    assert.equal(
      (await stat(join(directory, `${image.id}.json`))).mode & 0o777,
      0o600,
    );
  }
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
});

test("EXIF方向保留于原图，模型旋转副本与浏览器显示尺寸一致", async (t) => {
  const { store } = await temporaryStore(t);
  const buffer = await sharp({
    create: { width: 20, height: 30, channels: 3, background: "#abc" },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();
  const image = await store.save(buffer, {
    mimeType: "image/jpeg",
    originalName: "手机照片.jpg",
  });
  assert.equal(image.orientation, 6);
  assert.equal(image.displayWidth, 30);
  assert.equal(image.displayHeight, 20);
  const copy = await store.read(image.id, { normalizeOrientation: true });
  const copyMetadata = await sharp(copy).metadata();
  assert.equal(copyMetadata.width, image.displayWidth);
  assert.equal(copyMetadata.height, image.displayHeight);
  assert.equal(copyMetadata.orientation, undefined);
  assert.deepEqual(await store.read(image.id), buffer);
  assert.equal(
    (await sharp(await readFile(image.path)).metadata()).orientation,
    6,
  );
});

test("拒绝超大上传、类型伪造、损坏文件及路径穿越", async (t) => {
  const { store } = await temporaryStore(t);
  await assert.rejects(
    store.save(Buffer.alloc(12 * 1024 * 1024 + 1), { mimeType: "image/png" }),
    (e) => e.status === 413,
  );
  await assert.rejects(
    store.save(Buffer.alloc(0), { mimeType: "image/png" }),
    (e) => e.status === 400,
  );
  await assert.rejects(
    store.save(await png(), { mimeType: "image/jpeg" }),
    (e) => e.status === 415,
  );
  await assert.rejects(
    store.save(Buffer.from("<svg>not an allowed image</svg>"), {
      mimeType: "image/svg+xml",
    }),
    (e) => e.status === 415,
  );
  await assert.rejects(
    store.save(Buffer.from("not an image"), { mimeType: "image/png" }),
    (e) => e.status === 415,
  );
  const largePixels = await sharp({
    create: { width: 6401, height: 6250, channels: 3, background: "#fff" },
  })
    .png()
    .toBuffer();
  assert.ok(largePixels.length < 12 * 1024 * 1024);
  await assert.rejects(
    store.save(largePixels, { mimeType: "image/png" }),
    (e) => e.status === 415 && /像素/.test(e.message),
  );
  for (const id of [
    "../../etc/passwd",
    "../file",
    "/etc/passwd",
    "c:\\secret",
    "A".repeat(36),
    null,
  ]) {
    await assert.rejects(store.get(id), (e) => e.status === 400);
    await assert.rejects(store.read(id), (e) => e.status === 400);
  }
  await assert.rejects(
    store.get("11111111-1111-4111-8111-111111111111"),
    (e) => e.status === 404,
  );
});

test("图片元数据不能指定文件路径或不受支持的格式", async (t) => {
  const { directory, store } = await temporaryStore(t);
  const image = await store.save(await png(), {
    mimeType: "image/png",
    originalName: "照片.png",
  });
  const metadataPath = join(directory, `${image.id}.json`);
  const metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata, path: "/etc/passwd" }),
  );
  assert.equal((await store.get(image.id)).path, image.path);
  await writeFile(
    metadataPath,
    JSON.stringify({ ...metadata, mimeType: "text/html" }),
  );
  await assert.rejects(store.get(image.id), (e) => e.status === 500);
});
