import test from "node:test";
import assert from "node:assert/strict";
import { parseText, serializeBlocks, plainText, annotateBlocks } from "../shared/document.mjs";
import { blocksToHtml, htmlToBlocks, normalizeBodyHtml, bodyText, bodyRanges, hasCompleteSentenceBoundaries, applySentenceBoundaries, initializeSentenceBoundaries, markBodyRange, removeQaMarks, editBodyText, syncBodyReadings, appendBodyHtml } from "../shared/article-html.mjs";

const sample = () => blocksToHtml(parseText("{日本語|にほんご}。次の文。\n\n歌う空"), { sourceImageId: "img-1" });

test("分句完成必须覆盖全部正文，不能只凭存在一句或忽略未分句空格", () => {
  const complete = applySentenceBoundaries(sample(), [bodyText(sample())]);
  assert.equal(hasCompleteSentenceBoundaries(complete), true);
  assert.equal(hasCompleteSentenceBoundaries(sample()), false);
  assert.equal(hasCompleteSentenceBoundaries(complete + "<p>未分句</p>"), false);
  assert.equal(hasCompleteSentenceBoundaries(complete + "<p> </p>"), false);
  assert.equal(hasCompleteSentenceBoundaries(complete + "<p></p>"), true);
  assert.equal(hasCompleteSentenceBoundaries("<p></p>"), false);
});

test("受控HTML往返保留段落、UTF16原文、振假名与来源，清洗可执行属性", () => {
  const html = sample();
  assert.equal(serializeBlocks(htmlToBlocks(html)), "{日本語|にほんご}。次の文。\n\n歌う空");
  assert.equal(bodyText(html), "日本語。次の文。\n\n歌う空");
  assert.equal(normalizeBodyHtml(html), html);
  assert.deepEqual(bodyRanges(html).sources.map(({ id, text }) => ({ id, text })), [{ id: "img-1", text: "日本語。次の文。" }, { id: "img-1", text: "歌う空" }]);
  const cleaned = normalizeBodyHtml('<p data-paragraph-id="p1" onclick="alert(1)" style="color:red"><span data-source-image-id="img-1" onmouseover="alert(2)">&lt;img&gt; &amp; &#x1f600;</span></p>');
  assert.doesNotMatch(cleaned, /onclick|style=|onmouseover/);
  assert.equal(bodyText(cleaned), "<img> & 😀");
});

test("拒绝任意HTML、损坏结构、越界属性及伪造标识", () => {
  for (const html of ['<script>alert(1)</script>', '<p><img src="x"></p>', '<p><span>x</p>', '<p><p>x</p></p>', '<p>x', '<p><rt>x</rt></p>', '<p data-paragraph-id="a b">x</p>', '<p><mark>x</mark></p>', '<p><ruby>x</ruby></p>', '<p><span data-paragraph-id="p1">x</span></p>', '<p><ruby>x<rt>a<br></rt></ruby></p>', '<p data-paragraph-id="p1">a</p><p data-paragraph-id="p1">b</p>']) assert.throws(() => normalizeBodyHtml(html), undefined, html);
});

test("分句与跨来源问答标记不丢任何原文、ruby或组；重新分句保留标记", () => {
  const html = '<p data-paragraph-id="p1"><span data-source-image-id="img-1"><ruby data-origin="source">日本語<rt>にほんご</rt></ruby>。</span><span data-source-image-id="img-2">次の文。</span></p>';
  const marked = markBodyRange(applySentenceBoundaries(html, ["日本語。", "次の文。"]), 1, 7, "qa-1");
  const resegmented = applySentenceBoundaries(marked, ["日本", "語。次の文。"]);
  assert.equal(bodyText(resegmented), bodyText(html));
  assert.deepEqual(htmlToBlocks(resegmented), htmlToBlocks(html));
  assert.deepEqual(bodyRanges(resegmented).qa, [{ id: "qa-1", start: 1, end: 7, text: "本語。次の文" }]);
  assert.deepEqual(bodyRanges(resegmented).sources, bodyRanges(html).sources);
  assert.equal((resegmented.match(/<rt>/g) || []).length, 1, "句子边界穿过ruby也只保存原来的一条读音");
  assert.throws(() => applySentenceBoundaries(marked, ["改写原文"]), /改写/);
});

test("初始化只填补未分句部分，追加内容保留既有句子ID", () => {
  const old = applySentenceBoundaries(blocksToHtml(parseText("先の文。")), ["先の文。"]);
  const appended = old + blocksToHtml(parseText("続く歌詞\n無標点の行"), { sourceImageId: "img-2" });
  const initialized = initializeSentenceBoundaries(appended, ["先の文。\n", "続く歌詞\n", "無標点の行"]);
  assert.equal(bodyRanges(initialized).sentences[0].id, bodyRanges(old).sentences[0].id);
  assert.equal(bodyText(initialized), "先の文。\n続く歌詞\n無標点の行");
  assert.equal(bodyRanges(initialized).sentences.length, 3);
});

test("普通校正文保留句子与来源、标记；删光标记成为游离而不关联重复词", () => {
  let html = applySentenceBoundaries(blocksToHtml(parseText("名字。名字。"), { sourceImageId: "img-1" }), ["名字。", "名字。"]);
  html = markBodyRange(html, 0, 2, "qa-1");
  const edited = editBodyText(html, "名前。名字。");
  assert.equal(bodyRanges(edited).sentences[0].id, bodyRanges(html).sentences[0].id);
  assert.deepEqual(bodyRanges(edited).qa, [{ id: "qa-1", start: 0, end: 2, text: "名前" }]);
  assert.deepEqual(bodyRanges(editBodyText(html, "。名字。")).qa, []);
  assert.deepEqual(bodyRanges(removeQaMarks(edited, ["qa-1"])).qa, []);
  assert.equal(bodyText(removeQaMarks(edited)), bodyText(edited));
});

test("交界处可选择前句、后句和无图片来源；全文撤销恢复原结构", () => {
  const html = applySentenceBoundaries(blocksToHtml(parseText("一。二。"), { sourceImageId: "img-1" }), ["一。", "二。"]);
  const ids = bodyRanges(html).sentences.map(({ id }) => id);
  const before = editBodyText(html, "一。新二。", { boundarySide: "previous" });
  const after = editBodyText(html, "一。新二。", { boundarySide: "next", sourceImageId: null });
  assert.equal(bodyRanges(before).sentences[0].text, "一。新");
  assert.equal(bodyRanges(after).sentences[1].text, "新二。");
  assert.deepEqual(bodyRanges(after).sentences.map(({ id }) => id), ids);
  assert.deepEqual(bodyRanges(after).sources.map(({ text }) => text), ["一。", "二。"]);
  assert.equal(normalizeBodyHtml(html), html);
});

test("读音校对独立投影到HTML，跨标记ruby仍保留词级原读音", () => {
  let html = markBodyRange(applySentenceBoundaries(sample(), ["日本語。", "次の文。\n\n", "歌う空"]), 1, 6, "qa-1");
  let blocks = htmlToBlocks(html);
  blocks = annotateBlocks(blocks, 4, 5, "つぎ");
  const updated = syncBodyReadings(html, blocks);
  assert.equal(serializeBlocks(htmlToBlocks(updated)), serializeBlocks(blocks));
  assert.deepEqual(bodyRanges(updated), bodyRanges(html));
  assert.throws(() => syncBodyReadings(html, parseText("別の原文")), /不一致/);
});

test("改动有ruby的词会清除该词旧读音，未改词读音及非BMP字符偏移保留", () => {
  const html = blocksToHtml(parseText("😀{日本|にほん}。{空|そら}"));
  const edited = editBodyText(html, "😀日本語。空");
  assert.equal(plainText(htmlToBlocks(edited)), "😀日本語。空");
  assert.equal(htmlToBlocks(edited)[0].segments.at(-1).reading, "そら");
  const marked = markBodyRange(edited, 2, 5, "qa-1");
  assert.equal(bodyRanges(marked).qa[0].text, "日本語");
});


test("明确的textarea编辑选区保证重复词删除后不把标记移到别处", () => {
  const html = markBodyRange(blocksToHtml(parseText("名字名字")), 0, 2, "qa-first");
  const deletedFirst = editBodyText(html, "名字", { editStart: 0, editEnd: 2 });
  const deletedSecond = editBodyText(html, "名字", { editStart: 2, editEnd: 4 });
  assert.deepEqual(bodyRanges(deletedFirst).qa, []);
  assert.deepEqual(bodyRanges(deletedSecond).qa.map(({ text }) => text), ["名字"]);
});


test("修改一处文字保留所有段落类型及未删除段落ID", () => {
  const blocks = parseText("題名\n項目\n正文");
  ["heading", "list_item", "paragraph"].forEach((type, i) => { blocks[i].type = type; });
  const html = blocksToHtml(blocks);
  const next = htmlToBlocks(editBodyText(html, "題名\n項目\n新正文", { editStart: 6, editEnd: 6 }));
  assert.deepEqual(next.map(({ id, type }) => ({ id, type })), blocks.map(({ id, type }) => ({ id, type })));
  const removedFirst = htmlToBlocks(editBodyText(html, "項目\n正文", { editStart: 0, editEnd: 3 }));
  assert.deepEqual(removedFirst.map(({ id, type }) => ({ id, type })), blocks.slice(1).map(({ id, type }) => ({ id, type })));
});


test("全文替换中的小幅修改仅改变对应节点，不把全文归给首句", () => {
  let html = applySentenceBoundaries(blocksToHtml(parseText("名字。名字。")), ["名字。", "名字。"]);
  html = markBodyRange(html, 3, 5, "qa-second");
  const changed = editBodyText(html, "名前。名字。", { editStart: 0, editEnd: 6 });
  assert.deepEqual(bodyRanges(changed).sentences.map(({ id }) => id), bodyRanges(html).sentences.map(({ id }) => id));
  assert.deepEqual(bodyRanges(changed).qa, bodyRanges(html).qa);
});

test("追加图片可选择另起新句或接入末句，两者保留来源与问答标记", () => {
  const base = applySentenceBoundaries(blocksToHtml(parseText("最初。途中"), { sourceImageId: "img-1" }), ["最初。", "途中"]);
  const added = markBodyRange(applySentenceBoundaries(blocksToHtml(parseText("の文。次の文。\n続き"), { sourceImageId: "img-2" }), ["の文。", "次の文。\n", "続き"]), 0, 2, "qa-new");
  const separate = appendBodyHtml(base, added), joined = appendBodyHtml(base, added, { continueLastSentence: true });
  assert.equal(bodyText(separate), "最初。途中\nの文。次の文。\n続き");
  assert.equal(bodyText(joined), "最初。途中の文。次の文。\n続き");
  assert.equal(bodyRanges(joined).sentences[1].id, bodyRanges(base).sentences[1].id);
  assert.equal(bodyRanges(joined).sentences[1].text, "途中の文。");
  assert.equal(bodyRanges(joined).sentences[2].id, bodyRanges(added).sentences[1].id);
  assert.deepEqual(bodyRanges(joined).qa.map(({ text }) => text), ["の文"]);
  assert.deepEqual(bodyRanges(joined).sources.map(({ id }) => id), ["img-1", "img-2", "img-2"]);
});


test("段内换行投影为稳定物理行，保持读音来源和手动校对索引", () => {
  const html = '<p data-paragraph-id="p1"><ruby data-origin="source">日本<rt>にほん</rt></ruby><br><ruby data-origin="generated">空<rt>そら</rt></ruby></p>';
  const blocks = htmlToBlocks(html);
  assert.deepEqual(blocks.map(({ id }) => id), ["p1", "p1:line:1"]);
  assert.deepEqual(blocks.map((block) => block.segments[0].origin), ["source", "generated"]);
  assert.equal(serializeBlocks(blocks), "{日本|にほん}\n{空|そら}");
  assert.equal(bodyText(syncBodyReadings(html, blocks)), "日本\n空");
  assert.deepEqual(htmlToBlocks(normalizeBodyHtml(html)), blocks);
  assert.throws(() => normalizeBodyHtml('<p><ruby>一<br>二<rt>いちに</rt></ruby></p>'), /跨行/);
  assert.throws(() => normalizeBodyHtml('<p><ruby>一<rt>いち\n</rt></ruby></p>'), /跨行/);
});


test("跨段落同一句的范围与完整快照包含换行，追加接入时保留整句ID", () => {
  const base = applySentenceBoundaries(blocksToHtml(parseText("途中")), ["途中"]);
  const addition = applySentenceBoundaries(blocksToHtml(parseText("の文\n続き。別。"), { sourceImageId: "img-2" }), ["の文\n続き。", "別。"]);
  assert.deepEqual(bodyRanges(addition).sentences.map(({ text }) => text), ["の文\n続き。", "別。"]);
  const joined = appendBodyHtml(base, addition, { continueLastSentence: true });
  assert.deepEqual(bodyRanges(joined).sentences.map(({ text }) => text), ["途中の文\n続き。", "別。"]);
  assert.equal(bodyRanges(joined).sentences[0].id, bodyRanges(base).sentences[0].id);
  assert.equal(bodyRanges(joined).sentences[0].end, "途中の文\n続き。".length);
});
