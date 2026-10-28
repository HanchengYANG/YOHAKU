import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { OCR_SCHEMA, OCR_PROMPT, validateOcr } from "../shared/ocr.mjs";
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

test("新识别草稿保留正文分行与生成词组注音，批注与页码独立", () => {
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

test("新请求Schema仅允许生成注音或无注音，不再请求原图source读音", () => {
  const schema = OCR_SCHEMA.properties.blocks.items.properties.segments.items;
  assert.deepEqual(schema.properties.origin.enum, ["generated", null]);
  assert.equal(schema.properties.origin.enum.includes("source"), false);
  for (const segment of result().blocks.flatMap((block) => block.segments)) {
    assert.ok(schema.properties.origin.enum.includes(segment.origin));
  }
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
