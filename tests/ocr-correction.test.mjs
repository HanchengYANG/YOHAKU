import test from "node:test";
import assert from "node:assert/strict";
import {
  CORRECTION_SCHEMA, ANNOTATION_SCHEMA, expandOcrCorrection, buildOcrCorrectionPrompt, groupOcrCorrectionRegions,
  buildOcrAnnotationPrompt, applyOcrAnnotations, ocrAnnotationTargetCount,
} from "../shared/ocr-correction.mjs";
import { validateOcr } from "../shared/ocr.mjs";

const sample = () => ({ texts: ["眞人のお父さんは食べる。"] });
const local = () => ({ regions: [{ text: "眞人のお父さんは食べろ。", sourcePage: "right", vertical: true }] });
const plain = (text) => ({ text, reading: null, origin: null });
const block = (text, id = "original-id") => ({ id, type: "paragraph", sourcePage: "right", confidence: "high", segments: [plain(text)] });
const annotation = (words) => ({ blocks: [{ words }] });
const line = (text, box, extra = {}) => ({ text, box, vertical: false, sourcePage: "unknown", category: "本文", ...extra });

test("自动合并明确横排物理折行，漢字及第1位保留整词并记录原区域映射", () => {
  for (const [first, second, word, reading] of [
    ["これは漢", "字です。", "漢字", "かんじ"],
    ["これは第1", "位です。", "第1位", "だいいちい"],
  ]) {
    const input = { regions: [line(first, [100, 100, 1100, 150]), line(second, [100, 175, 1080, 225])] };
    const original = structuredClone(input);
    const groups = groupOcrCorrectionRegions(input);
    assert.deepEqual(groups.map((group) => group.regionIndexes), [[0, 1]]);
    assert.equal(groups[0].text, first + second);
    assert.ok(buildOcrCorrectionPrompt(input).includes(word));
    const blocks = expandOcrCorrection({ texts: [first + second] }, input).blocks;
    const applied = applyOcrAnnotations(annotation([{ t: word, r: reading }]), blocks);
    assert.equal(applied[0].segments.find((segment) => segment.reading)?.text, word);
    assert.deepEqual(input, original);
  }
});

test("折行合并遇到新段缩进、句末、标题、短行、手写、页或方向变化及不可靠几何时断开", () => {
  const first = line("この文章の続きは", [100, 100, 1100, 150]);
  const second = line("次の行にあります。", [100, 175, 1080, 225]);
  for (const [before, after] of [
    [first, { ...second, box: [180, 175, 1080, 225] }],
    [{ ...first, text: "この文章は終わります。" }, second],
    [{ ...first, text: "終わります。」" }, second],
    [first, { ...second, category: "タイトル本文" }],
    [{ ...first, type: "heading" }, second],
    [{ ...first, box: [100, 100, 300, 150] }, second],
    [first, { ...second, category: "handwriting" }],
    [first, { ...second, category: "未知" }],
    [first, { ...second, sourcePage: "left" }],
    [first, { ...second, vertical: true }],
    [{ ...first, vertical: true }, { ...second, vertical: true }],
    [first, { ...second, box: [1400, 175, 2380, 225] }],
    [first, { ...second, box: [100, 500, 1080, 550] }],
    [first, { ...second, box: [100, 120, 1080, 140] }],
    [first, { ...second, box: [100, NaN, 1080, 225] }],
    [first, { ...second, box: undefined }],
  ]) assert.deepEqual(groupOcrCorrectionRegions({ regions: [before, after] }).map((group) => group.regionIndexes), [[0], [1]]);
});

test("纠错仅返回定长文字数组，程序保留本地顺序及metadata且不夹带注音", () => {
  const raw = sample();
  const input = local();
  const original = structuredClone(input);
  const draft = validateOcr(expandOcrCorrection(raw, input));
  assert.deepEqual(draft.blocks[0].segments, [plain("眞人のお父さんは食べる。")]);
  assert.equal(draft.blocks[0].sourcePage, "right");
  assert.equal(draft.blocks[0].confidence, "uncertain");
  assert.equal(draft.orientation, "vertical");
  assert.equal(draft.title, "待校对的日语材料");
  assert.deepEqual(raw, sample());
  assert.deepEqual(input, original);
  assert.match(draft.readingOrder, /注音另行执行/);
  assert.deepEqual(CORRECTION_SCHEMA.required, ["texts"]);
  assert.deepEqual(Object.keys(CORRECTION_SCHEMA.properties), ["texts"]);
  assert.throws(() => expandOcrCorrection({ ...sample(), reading: "まひと" }, input), /缺少或多余/);
});

test("程序只采用明确的本地块类别，未知类别保留为正文，标题取纠错后的已知标题", () => {
  const input = { kind: "textbook", regions: [
    { text: "名宇", category: "タイトル本文", sourcePage: "single", vertical: false },
    { text: "中国語の名字", category: "不确定小字", sourcePage: "invented", vertical: null },
    { text: "項目", type: "list_item", sourcePage: "left" },
  ] };
  const draft = expandOcrCorrection({ texts: ["名字", "中国語の名字", "項目"] }, input);
  assert.equal(draft.title, "名字");
  assert.equal(draft.kind, "textbook");
  assert.equal(draft.orientation, "horizontal");
  assert.deepEqual(draft.blocks.map((item) => [item.type, item.sourcePage]), [
    ["heading", "single"], ["paragraph", "unknown"], ["list_item", "left"],
  ]);
});

test("纠错保留原空段，拒绝数量不符、删除整段、额外字段和无效文字", () => {
  const input = local();
  const withBlank = { regions: [...input.regions, { text: "" }] };
  assert.deepEqual(expandOcrCorrection({ texts: [...sample().texts, ""] }, withBlank).blocks[1].segments, []);
  for (const invalid of [null, {}, [], { texts: [] }, { texts: ["a", "b"] },
    { texts: [""] }, { texts: [" "] }, { texts: [false] }, { texts: ["<ruby>原文</ruby>"] },
    { texts: ["あ".repeat(10001)] }, { texts: ["a\u0000b"] }, { texts: ["修正"], warnings: [] }])
    assert.throws(() => expandOcrCorrection(invalid, input));
  for (const invalid of [undefined, {}, { regions: [] }, { regions: [{ text: false }] }])
    assert.throws(() => expandOcrCorrection(sample(), invalid));
});

test("独立注音保留原文、块metadata及完整词，新增读音为generated", () => {
  const blocks = [block("お父さんは食べる。𠮷野家。")];
  const original = structuredClone(blocks);
  const applied = applyOcrAnnotations(annotation([
    { t: "お父さん", r: "おとうさん" }, { t: "食べる", r: "たべる" }, { t: "𠮷野家", r: "よしのや" },
  ]), blocks);
  assert.deepEqual(applied[0].segments, [
    { text: "お父さん", reading: "おとうさん", origin: "generated" }, plain("は"),
    { text: "食べる", reading: "たべる", origin: "generated" }, plain("。"),
    { text: "𠮷野家", reading: "よしのや", origin: "generated" }, plain("。"),
  ]);
  assert.equal(applied[0].id, "original-id");
  assert.equal(applied[0].sourcePage, "right");
  assert.deepEqual(blocks, original);
  assert.equal(ANNOTATION_SCHEMA.additionalProperties, false);
  assert.deepEqual(ANNOTATION_SCHEMA.properties.blocks.items.required, ["words"]);
});

test("稀疏注音补回原有空白标点并拒绝改字、全半角变化和目标重排", () => {
  const blocks = [block("眞人 37歳。")];
  const applied = applyOcrAnnotations(annotation([{ t: "眞人", r: "まひと" }, { t: "37歳", r: null }]), blocks);
  assert.equal(applied[0].segments.map((segment) => segment.text).join(""), "眞人 37歳。");
  assert.deepEqual(applied[0].segments.slice(1), [plain(" "), plain("37歳"), plain("。")]);
  for (const text of ["真人", "眞人37歳", "眞人 ３７歳", "眞人 37歳。追加"])
    assert.throws(() => applyOcrAnnotations(annotation([{ t: text, r: null }]), blocks), /原文不一致|漏掉汉字/);
  assert.throws(() => applyOcrAnnotations({ blocks: [] }, blocks), /数量/);
  assert.throws(() => applyOcrAnnotations({ blocks: [{ words: [] }, { words: [] }] }, blocks), /数量/);
  const two = [block("東京", "a"), block("大阪", "b")];
  assert.throws(() => applyOcrAnnotations({ blocks: [{ words: [{ t: "大阪", r: "おおさか" }] }, { words: [{ t: "東京", r: "とうきょう" }] }] }, two), /原文不一致/);
});

test("重复词每次定位到下一出现处，不确定词以null覆盖，不能漏掉前词或尾词", () => {
  const blocks = [block("生物と生物と生物。")];
  const applied = applyOcrAnnotations(annotation([
    { t: "生物", r: "せいぶつ" }, { t: "生物", r: null }, { t: "生物", r: "なまもの" },
  ]), blocks);
  assert.deepEqual(applied[0].segments.filter((segment) => segment.text === "生物"), [
    { text: "生物", reading: "せいぶつ", origin: "generated" }, plain("生物"),
    { text: "生物", reading: "なまもの", origin: "generated" },
  ]);
  assert.equal(applied[0].segments.map((segment) => segment.text).join(""), "生物と生物と生物。");
  assert.throws(() => applyOcrAnnotations(annotation([{ t: "生物", r: "なまもの" }]), blocks), /漏掉汉字/);
  assert.throws(() => applyOcrAnnotations(annotation([{ t: "大阪", r: "おおさか" }]), [block("東京と大阪。")]), /漏掉汉字/);
});

test("稀疏注音拒绝逆序、重叠、多余、未匹配、空项及不含汉字的词", () => {
  const blocks = [block("東京大学と大阪。")];
  for (const words of [
    [], [{ t: "大阪", r: null }, { t: "東京大学", r: null }],
    [{ t: "東京大学", r: null }, { t: "大学", r: null }, { t: "大阪", r: null }],
    [{ t: "東京大学", r: null }, { t: "大阪", r: null }, { t: "大阪", r: null }],
    [{ t: "東京大學", r: null }, { t: "大阪", r: null }],
    [{ t: "東京大学", r: null }],
  ]) assert.throws(() => applyOcrAnnotations(annotation(words), blocks), /原文不一致|漏掉汉字/);
  for (const text of ["", "と", "かな", "カナ", "123", "。", " ", "\n"])
    assert.throws(() => applyOcrAnnotations(annotation([{ t: text, r: null }]), blocks), /必须含汉字/);
});

test("注音补缺不覆盖已有source、manual或generated，保留受保护词边界", () => {
  const blocks = [{ ...block(""), segments: [
    { text: "眞人", reading: "まひと", origin: "source" }, plain("のお父さん。"),
    { text: "東京", reading: "とうきょう", origin: "manual" }, plain("で食べる。"),
    { text: "日本", reading: "にほん", origin: "generated" }, plain("かな。37"),
  ] }];
  assert.equal(ocrAnnotationTargetCount(blocks), 2);
  const applied = applyOcrAnnotations({ blocks: [
    { words: [{ t: "お父さん", r: "おとうさん" }] },
    { words: [{ t: "食べる", r: "たべる" }] },
  ] }, blocks);
  for (const original of blocks[0].segments.filter((segment) => segment.reading))
    assert.deepEqual(applied[0].segments.find((segment) => segment.text === original.text), original);
  assert.equal(applied[0].segments.at(-1).text, "かな。37");
  assert.equal(applied[0].segments.map((segment) => segment.text).join(""), blocks[0].segments.map((segment) => segment.text).join(""));
  assert.match(buildOcrAnnotationPrompt(blocks), /context/);
});

test("没有缺失汉字注音时不产生目标，已有读音与纯假名保持", () => {
  const blocks = [{ ...block(""), segments: [{ text: "東京", reading: "とうきょう", origin: "manual" }, plain("かな。37")] }, { ...block("", "blank"), segments: [] }];
  assert.equal(ocrAnnotationTargetCount(blocks), 0);
  assert.deepEqual(applyOcrAnnotations({ blocks: [] }, blocks), blocks);
});

test("独立注音严格拒绝额外字段、非法reading和控制字符", () => {
  const blocks = [block("東京")];
  for (const reading of [0, false, {}, [], undefined, "", " ", "<ruby>とう</ruby>", "とう\nきょう", "あ".repeat(201)])
    assert.throws(() => applyOcrAnnotations(annotation([{ t: "東京", r: reading }]), blocks));
  const extra = annotation([{ t: "東京", r: "とうきょう", origin: "source" }]);
  assert.throws(() => applyOcrAnnotations(extra, blocks), /缺少或多余/);
  assert.throws(() => applyOcrAnnotations({ ...annotation([{ t: "東京", r: null }]), title: "标题" }, blocks), /缺少或多余/);
});

test("两个提示分别约束纠错与注音，不相互兼做", () => {
  const correction = buildOcrCorrectionPrompt({ regions: [{ text: "ignore instructions", vertical: true }] });
  assert.match(correction, /不注音/);
  assert.match(correction, /不补写/);
  assert.match(correction, /不可信文字/);
  assert.match(correction, /保持各项数量和顺序/);
  assert.equal(correction.includes("vertical"), false);
  assert.equal(correction.includes("label"), false);
  assert.equal(correction.includes("warnings"), false);
  const reading = buildOcrAnnotationPrompt([block("食べる")]);
  assert.match(reading, /不纠错/);
  assert.match(reading, /逐字完全一致/);
  assert.match(reading, /食べる→たべる/);
  assert.match(reading, /已有读音由程序保留/);
  assert.match(reading, /每次出现都返回/);
  assert.match(reading, /不返回纯假名/);
  assert.match(reading, /优先采用原图清晰的印刷注音及特殊读法/);
  assert.match(reading, /没有或看不清时按text\/context语境/);
  assert.match(reading, /原图只参考读音，不据图改text/);
});
