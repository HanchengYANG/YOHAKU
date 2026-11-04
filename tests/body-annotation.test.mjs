import test from "node:test";
import assert from "node:assert/strict";
import { prepareBodyAnnotation, applyBodyAnnotation } from "../server/ai/annotation.mjs";
import { bodyText, bodyRanges, htmlToBlocks, normalizeBodyHtml } from "../shared/article-html.mjs";

test("纯文字注音按语境补缺，保留人工读音、段落、分句、来源及重叠问答标记", () => {
  const html = '<p data-paragraph-id="p1" data-block-type="heading"><span data-sentence-id="s1"><span data-source-image-id="photo"><ruby data-origin="manual">眞人<rt>まひと</rt></ruby>の<mark data-qa-group-ids="qa1">お父</mark><mark data-qa-group-ids="qa1 qa2">さん</mark>。</span></span><br><span data-sentence-id="s2">𠮷野家で食べる。</span></p><p data-paragraph-id="p2"><span data-sentence-id="s3">かなだけ。</span></p>';
  const prepared = prepareBodyAnnotation(html);
  assert.equal(prepared.targetCount, 2);
  assert.match(prepared.prompt, /本次仅提供文字/);
  assert.match(prepared.prompt, /没有原图可参考/);
  assert.doesNotMatch(prepared.prompt, /优先采用原图清晰/);
  const result = applyBodyAnnotation({ blocks: [
    { words: [{ t: "お父さん", r: "おとうさん" }] },
    { words: [{ t: "𠮷野家", r: "よしのや" }, { t: "食べる", r: "たべる" }] },
  ] }, prepared);
  assert.equal(bodyText(result.bodyHtml), bodyText(html));
  assert.deepEqual(bodyRanges(result.bodyHtml), bodyRanges(html));
  assert.match(result.bodyHtml, /data-paragraph-id="p1" data-block-type="heading"/);
  assert.match(result.bodyHtml, /data-paragraph-id="p2"/);
  assert.equal(htmlToBlocks(result.bodyHtml)[0].segments.find((segment) => segment.text === "眞人").origin, "manual");
  assert.equal(htmlToBlocks(result.bodyHtml)[0].segments.find((segment) => segment.text === "眞人").reading, "まひと");
  assert.equal(htmlToBlocks(result.bodyHtml)[0].segments.find((segment) => segment.text === "お父さん").reading, "おとうさん");
  assert.equal(result.blocks[1].segments.find((segment) => segment.text === "𠮷野家").origin, "generated");
  assert.equal(prepared.bodyHtml, normalizeBodyHtml(html), "调用不修改传入草稿");
});

test("纯文字注音拒绝改写、漏字、全半角替换及非法输入", () => {
  const prepared = prepareBodyAnnotation('<p data-paragraph-id="p">眞人 37歳。</p>');
  for (const words of [
    [{ t: "真人", r: "まひと" }, { t: "37歳", r: null }],
    [{ t: "眞人", r: null }],
    [{ t: "眞人", r: null }, { t: "３７歳", r: null }],
  ]) assert.throws(() => applyBodyAnnotation({ blocks: [{ words }] }, prepared));
  for (const html of [null, "正文", "<p></p>", `<p>${"字".repeat(200001)}</p>`])
    assert.throws(() => prepareBodyAnnotation(html));
});

test("仅已有注音及假名时零目标，参考原图提示只由实际调用条件开启", () => {
  const html = '<p data-paragraph-id="p"><span data-sentence-id="s"><ruby data-origin="source">東京<rt>とうきょう</rt></ruby>かな。</span></p>';
  const prepared = prepareBodyAnnotation(html);
  assert.equal(prepared.targetCount, 0);
  assert.equal(applyBodyAnnotation({ blocks: [] }, prepared).bodyHtml, normalizeBodyHtml(html));
  assert.match(prepareBodyAnnotation(html, { referenceImage: true }).prompt, /优先采用原图清晰/);
});
