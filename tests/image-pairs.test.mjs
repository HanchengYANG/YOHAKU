import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { parseText, serializeBlocks } from "../shared/document.mjs";
import {
  appendImageBodyHtml, applySentenceBoundaries, blocksToHtml, bodyRanges, bodyText, editBodyText,
  htmlToBlocks, normalizeBodyHtml, removeSourceBodyHtml, reorderSourceBodyHtml, replaceSourceBodyHtml,
  sourceBodyHtml, sourceBodySelection,
} from "../shared/article-html.mjs";

const photo = (id, text) => blocksToHtml(parseText(text), { sourceImageId: id });
const joined = (...parts) => parts.reduce(appendImageBodyHtml);
const sourceTexts = (html) => bodyRanges(html).sources.map(({ id, text }) => ({ id, text }));

test("图片间直接拼接，图片内段落、读音与来源保留", () => {
  const first = photo("image-1", "{日本|にほん}。\n次の行");
  const second = photo("image-2", "続く文。\n\n{空|そら}");
  const html = appendImageBodyHtml(first, second);
  assert.equal(bodyText(html), bodyText(first) + bodyText(second));
  assert.equal(serializeBlocks(htmlToBlocks(html)), "{日本|にほん}。\n次の行続く文。\n\n{空|そら}");
  assert.equal(bodyText(sourceBodyHtml(html, "image-1")), "日本。\n次の行");
  assert.equal(bodyText(sourceBodyHtml(html, "image-2")), "続く文。\n\n空");
});

test("独立图片的重复段落和句子ID不会意外连接，QA仍引用原组", () => {
  const first = '<p data-paragraph-id="one"><span data-sentence-id="same"><span data-source-image-id="image-1">一</span></span></p><p data-paragraph-id="two">末</p>';
  const second = '<p data-paragraph-id="two"><span data-sentence-id="same"><span data-source-image-id="image-2"><mark data-qa-group-ids="qa-2">二</mark></span></span></p><p data-paragraph-id="one">後</p>';
  const html = appendImageBodyHtml(first, second);
  assert.equal(bodyText(html), "一\n末二\n後");
  assert.equal(new Set(htmlToBlocks(html).map(({ id }) => id)).size, 3);
  assert.equal(new Set(bodyRanges(html).sentences.map(({ id }) => id)).size, 2);
  assert.deepEqual(bodyRanges(html).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-2", text: "二" }]);
});

test("逐图抽取跨标记、段内混合来源的正文，局部偏移从零开始", () => {
  const html = '<p data-paragraph-id="one"><span data-source-image-id="a"><ruby data-origin="source"><mark data-qa-group-ids="qa-a">日本語</mark><rt>にほんご</rt></ruby></span><span data-source-image-id="b">別</span><span data-source-image-id="a">。</span></p><p data-paragraph-id="two"><span data-source-image-id="a">空</span></p>';
  const source = sourceBodyHtml(html, "a");
  assert.equal(bodyText(source), "日本語。\n空");
  assert.equal(serializeBlocks(htmlToBlocks(source)), "{日本語|にほんご}。\n空");
  assert.deepEqual(bodyRanges(source).qa.map(({ start, end }) => ({ start, end })), [{ start: 0, end: 3 }]);
  assert.deepEqual(sourceBodySelection(html, "a", 0, 3), { start: 0, end: 3, text: "日本語" });
  assert.deepEqual(sourceBodySelection(html, "a", 3, 6), { start: 4, end: 7, text: "。\n空" });
  assert.equal(sourceBodySelection(html, "a", 0, 4), null, "不能把被跳过的其他图片文字纳入选区");
});

test("重复字词与非BMP字符的选区按原节点定位，不搜索相同文字", () => {
  const html = '<p><span data-source-image-id="a">😀名字</span><span data-source-image-id="b">名字</span><span data-source-image-id="a">名字</span></p>';
  assert.equal(bodyText(sourceBodyHtml(html, "a")), "😀名字名字");
  assert.deepEqual(sourceBodySelection(html, "a", 4, 6), { start: 6, end: 8, text: "名字" });
  assert.deepEqual(sourceBodySelection(html, "a", 0, 2), { start: 0, end: 2, text: "😀" });
  assert.equal(sourceBodySelection(html, "a", 2, 6), null);
  assert.equal(sourceBodySelection(html, "a", 0, 0), null);
  assert.equal(sourceBodySelection(html, "a", -1, 1), null);
});

test("只替换当前图片，另一图片的读音、QA与句子ID保持", () => {
  const first = '<p><span data-sentence-id="sentence-a"><span data-source-image-id="a"><mark data-qa-group-ids="qa-a">名字</mark>。</span></span></p>';
  const second = '<p><span data-sentence-id="sentence-b"><span data-source-image-id="b"><mark data-qa-group-ids="qa-b"><ruby data-origin="manual">空<rt>そら</rt></ruby></mark>。</span></span></p>';
  const html = joined(first, second), originalSecond = serializeBlocks(htmlToBlocks(sourceBodyHtml(html, "b")));
  const corrected = editBodyText(sourceBodyHtml(html, "a"), "名前。", { sourceImageId: "a" });
  const next = replaceSourceBodyHtml(html, "a", corrected);
  assert.equal(bodyText(next), "名前。空。");
  assert.equal(serializeBlocks(htmlToBlocks(sourceBodyHtml(next, "b"))), originalSecond);
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-a", text: "名前" }, { id: "qa-b", text: "空" }]);
  assert.deepEqual(bodyRanges(next).sentences.map(({ id }) => id), ["sentence-a", "sentence-b"]);
});

test("清空后仍可在原图片位置重新输入，不产生额外分隔或错归来源", () => {
  const html = joined(photo("a", "一"), photo("b", "二"));
  const empty = replaceSourceBodyHtml(html, "a", sourceBodyHtml(photo("a", ""), "a"));
  assert.equal(bodyText(empty), "二");
  assert.equal(bodyText(sourceBodyHtml(empty, "a")), "");
  assert.equal(bodyText(reorderSourceBodyHtml(empty, ["a", "b"])), "二");
  const restored = reorderSourceBodyHtml(replaceSourceBodyHtml(empty, "a", photo("elsewhere", "新")), ["a", "b"]);
  assert.equal(bodyText(restored), "新二");
  assert.deepEqual(sourceTexts(restored), [{ id: "a", text: "新" }, { id: "b", text: "二" }]);
});

test("图片内容只有换行时来源仍可抽取，不会变成邻图正文", () => {
  const html = joined(photo("a", "一"), photo("b", "二"));
  const replacement = '<p data-paragraph-id="empty-one"></p><p data-paragraph-id="empty-two"></p>';
  const next = replaceSourceBodyHtml(html, "a", replacement);
  assert.equal(bodyText(sourceBodyHtml(next, "a")), "\n");
  assert.equal(bodyText(next), "\n二");
});

test("图片排序整体移动文字、读音和QA，失效跨图句子可重新分句", () => {
  const html = '<p data-paragraph-id="one"><span data-sentence-id="cross"><span data-source-image-id="a"><ruby data-origin="source">日本<rt>にほん</rt></ruby></span><span data-source-image-id="b"><mark data-qa-group-ids="qa-b">語。</mark></span></span><span data-sentence-id="independent"><span data-source-image-id="c">次。</span></span></p>';
  const next = reorderSourceBodyHtml(html, ["c", "b", "a"]);
  assert.equal(bodyText(next), "次。語。日本");
  assert.equal(serializeBlocks(htmlToBlocks(next)), "次。語。{日本|にほん}");
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-b", text: "語。" }]);
  assert.deepEqual(bodyRanges(next).sentences.map(({ id, text }) => ({ id, text })), [{ id: "independent", text: "次。" }]);
  assert.deepEqual(sourceTexts(next), [{ id: "c", text: "次。" }, { id: "b", text: "語。" }, { id: "a", text: "日本" }]);
});

test("同序不会清除跨图片既有句子ID", () => {
  const html = '<p><span data-sentence-id="cross"><span data-source-image-id="a">同</span><span data-source-image-id="b">句。</span></span></p>';
  assert.deepEqual(bodyRanges(reorderSourceBodyHtml(html, ["a", "b"])).sentences.map(({ id, text }) => ({ id, text })), [{ id: "cross", text: "同句。" }]);
});

test("排序不为拆开或反转的跨图片词保留旧读音，其余图片读音不受影响", () => {
  const html = '<p><ruby data-origin="manual"><span data-source-image-id="a">日</span><span data-source-image-id="b"><mark data-qa-group-ids="qa-cross">本</mark></span><rt>にほん</rt></ruby><span data-source-image-id="c"><ruby data-origin="source">空<rt>そら</rt></ruby></span></p>';
  assert.equal(serializeBlocks(htmlToBlocks(reorderSourceBodyHtml(html, ["a", "b", "c"]))), "{日本|にほん}{空|そら}");
  const next = reorderSourceBodyHtml(html, ["c", "b", "a"]);
  assert.equal(serializeBlocks(htmlToBlocks(next)), "{空|そら}本日");
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-cross", text: "本" }]);
});

test("排序保留图片内部空行，但不把图片边界变成换行", () => {
  const html = photo("a", "甲\n\n乙") + photo("b", "丙");
  assert.equal(bodyText(sourceBodyHtml(html, "a")), "甲\n\n乙");
  const next = reorderSourceBodyHtml(html, ["b", "a"]);
  assert.equal(bodyText(next), "丙甲\n\n乙");
  assert.equal(normalizeBodyHtml(next), next);
});

test("遗留无来源文字作为前缀或跟随前图保留，不创建或丢失文字", () => {
  const html = '<p>題：</p><p><span data-source-image-id="a">甲</span><mark data-qa-group-ids="legacy-note">注</mark><span data-source-image-id="b">乙</span>尾</p>';
  assert.equal(bodyText(reorderSourceBodyHtml(html, ["a", "b"])), bodyText(html));
  const next = reorderSourceBodyHtml(html, ["b", "a"]);
  assert.equal(bodyText(next), "題：\n乙尾甲注");
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "legacy-note", text: "注" }]);
  const corrected = replaceSourceBodyHtml(html, "a", photo("a", "新甲"));
  assert.equal(bodyText(corrected), "題：\n新甲注乙尾");
});

test("散落的同源片段作为一个图片pair收集，其他来源不丢失", () => {
  const html = '<p><span data-source-image-id="a">甲</span><span data-source-image-id="b">乙</span></p><p><span data-source-image-id="a">丙</span></p>';
  assert.equal(bodyText(sourceBodyHtml(html, "a")), "甲\n丙");
  assert.equal(bodyText(reorderSourceBodyHtml(html, ["b", "a"])), "乙甲\n丙");
});

test("拒绝无效、重复或会丢失正文的排序，允许没有文字的图片", () => {
  const html = joined(photo("a", "甲"), photo("b", "乙"));
  for (const ids of [["a"], ["a", "a", "b"], ["a b", "b"], null]) assert.throws(() => reorderSourceBodyHtml(html, ids));
  assert.equal(bodyText(reorderSourceBodyHtml(html, ["empty", "a", "b"])), "甲乙");
  assert.throws(() => sourceBodyHtml(html, ""));
  assert.throws(() => replaceSourceBodyHtml(html, "not an id", photo("a", "甲")));
});

test("删除图片只移除对应atoms，重复文字、旧无来源文字和其他QA读音保留", () => {
  const html = '<p data-paragraph-id="mixed">前<span data-source-image-id="a"><mark data-qa-group-ids="qa-deleted">名字</mark></span>注<span data-sentence-id="sentence-b"><span data-source-image-id="b"><mark data-qa-group-ids="qa-remaining"><ruby data-origin="manual">名字<rt>みょうじ</rt></ruby></mark>。</span></span>尾</p>';
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(bodyText(next), "前注名字。尾");
  assert.deepEqual(sourceTexts(next), [{ id: "b", text: "名字。" }]);
  assert.equal(serializeBlocks(htmlToBlocks(next)), "前注{名字|みょうじ}。尾");
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-remaining", text: "名字" }]);
  assert.deepEqual(bodyRanges(next).sentences.map(({ id, text }) => ({ id, text })), [{ id: "sentence-b", text: "名字。" }]);
  assert.equal(htmlToBlocks(next)[0].id, "mixed");
});

test("删除整张图片的物理行，同时保留相邻图片的内部空行和读音", () => {
  const html = joined(photo("a", "削除一\n\n削除二"), photo("b", "残る一\n\n{空|そら}"));
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(bodyText(next), "残る一\n\n空");
  assert.equal(serializeBlocks(htmlToBlocks(next)), "残る一\n\n{空|そら}");
  assert.equal(bodyText(sourceBodyHtml(next, "b")), "残る一\n\n空");
});

test("删除段内图片的换行atom，不改另一图片的换行和旧段落", () => {
  const html = '<p data-paragraph-id="intro">題</p><p data-paragraph-id="blank"></p><p data-paragraph-id="body"><span data-source-image-id="a">削<br>除</span>注<span data-source-image-id="b">残<br>文</span></p><p data-paragraph-id="after">後</p><p data-paragraph-id="trailing"></p>';
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(bodyText(next), "題\n\n注残\n文\n後\n");
  assert.deepEqual(htmlToBlocks(next).map(({ id }) => id), ["intro", "blank", "body", "body:line:1", "after", "trailing"]);
  assert.equal(bodyText(sourceBodyHtml(next, "b")), "残\n文");
});

test("删除部分跨图ruby清掉整词旧读音，并使受影响的跨图句子失效", () => {
  const html = '<p><span data-sentence-id="cross"><ruby data-origin="manual"><span data-source-image-id="a"><mark data-qa-group-ids="qa-all qa-a">日</mark></span><span data-source-image-id="b"><mark data-qa-group-ids="qa-all">本</mark></span><rt>にほん</rt></ruby>。</span><span data-sentence-id="independent"><span data-source-image-id="c"><ruby data-origin="source">空<rt>そら</rt></ruby>。</span></span></p>';
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(serializeBlocks(htmlToBlocks(next)), "本。{空|そら}。");
  assert.deepEqual(bodyRanges(next).sentences.map(({ id, text }) => ({ id, text })), [{ id: "independent", text: "空。" }]);
  assert.deepEqual(bodyRanges(next).qa.map(({ id, text }) => ({ id, text })), [{ id: "qa-all", text: "本" }]);
  assert.deepEqual(sourceTexts(next), [{ id: "b", text: "本" }, { id: "c", text: "空。" }]);
});

test("删除散落来源不会把相同文字当成同一张图片，也不吞掉剩余段落", () => {
  const html = '<p data-paragraph-id="one"><span data-source-image-id="a">同</span><span data-source-image-id="b">同</span></p><p data-paragraph-id="remove"><span data-source-image-id="a">同</span></p><p data-paragraph-id="legacy">同</p><p data-paragraph-id="last"><span data-source-image-id="b">末</span></p>';
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(bodyText(next), "同\n同\n末");
  assert.deepEqual(htmlToBlocks(next).map(({ id }) => id), ["one", "legacy", "last"]);
  assert.deepEqual(sourceTexts(next), [{ id: "b", text: "同" }, { id: "b", text: "末" }]);
});

test("删除仅换行的图片无额外空段；不存在的来源保持正文且校验标识", () => {
  const html = '<p data-paragraph-id="body"><span data-source-image-id="a"><br></span><span data-source-image-id="b">後</span></p>';
  assert.equal(bodyText(removeSourceBodyHtml(html, "a")), "後");
  assert.equal(removeSourceBodyHtml(html, "missing"), normalizeBodyHtml(html));
  const legacy = '<p data-paragraph-id="one">旧文</p><p data-paragraph-id="blank"></p>';
  assert.equal(removeSourceBodyHtml(legacy, "a"), normalizeBodyHtml(legacy));
  assert.throws(() => removeSourceBodyHtml(html, ""), /标识无效/);
  assert.throws(() => removeSourceBodyHtml(html, "a b"), /标识无效/);
});

test("删除唯一有字来源可返回可解析空正文", () => {
  const html = photo("a", "唯一\n来源");
  const next = removeSourceBodyHtml(html, "a");
  assert.equal(bodyText(next), "");
  assert.deepEqual(bodyRanges(next), { sources: [], sentences: [], qa: [] });
  assert.equal(htmlToBlocks(next).length, 1);
});

test("保存删除图片的文章后原图仍在，完整讨论保留且失去正文的组成为游离记录", async (context) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-image-remove-"));
  const services = {
    auth: {
      async status() { return { connected: true, activeAccountId: "remove-test", subject: "remove-test-subject" }; },
      async accounts() { return { activeId: "remove-test", accounts: [] }; },
    },
    runtime: {
      status() { return { model: "IMAGE-REMOVE-TEST-DOUBLE", ready: true, busy: false }; },
      stop() {},
      async run({ schema }) { return { completed: true, text: schema ? JSON.stringify({ text: "日本。空。" }) : "图片删除测试回答。", threadId: "remove-test-thread", model: "IMAGE-REMOVE-TEST-DOUBLE", sources: [] }; },
    },
  };
  const application = createApp({ dataDir, aiServices: services });
  const server = application.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  context.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    application.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  let cookie = "";
  const request = async (path, data, method = data === undefined ? "GET" : "POST") => {
    const response = await fetch(`${origin}/api${path}`, {
      method, headers: { ...(cookie ? { Cookie: cookie } : {}), ...(data === undefined || data instanceof FormData ? {} : { "Content-Type": "application/json" }) },
      ...(data === undefined ? {} : { body: data instanceof FormData ? data : JSON.stringify(data) }),
    });
    const session = response.headers.getSetCookie().find(value => value.startsWith("yohaku_session="));
    if (session) cookie = session.split(";")[0];
    const result = await response.json();
    assert.equal(response.ok, true, `${path}: ${JSON.stringify(result)}`);
    return result;
  };
  await request("/accounts/setup", { username: "remove_fixture", password: "fixture-only-password" });
  const imageIds = [];
  for (const width of [2, 3]) {
    const pixels = await sharp({ create: { width, height: 3, channels: 3, background: { r: 100, g: 160, b: 180 } } }).png().toBuffer();
    const form = new FormData();form.append("image", new Blob([pixels], { type: "image/png" }), `photo-${width}.png`);
    const uploaded = await request("/images", form);imageIds.push(uploaded.id);
    await request(`/images/${uploaded.id}/recognize`, { engine: "llm" });
  }
  const originalHtml = joined(photo(imageIds[0], "{日本|にほん}。"), photo(imageIds[1], "{空|そら}。"));
  const bodyHtml = applySentenceBoundaries(originalHtml, ["日本。", "空。"]);
  let document = await request("/documents", { title: "删除图片持久化测试", kind: "article", orientation: "horizontal", bodyHtml, sourceImages: imageIds.map(id => ({ id })) });
  let conversation;
  for (const [start, end] of [[0, 2], [3, 4]]) {
    document = await request(`/documents/${document.id}`);
    conversation = await request(`/documents/${document.id}/conversations`, { operation: "translation", selection: { start, end, text: bodyText(document.bodyHtml).slice(start, end), bodyHash: document.bodyHash, sentenceIds: bodyRanges(document.bodyHtml).sentences.filter(item => item.end > start && item.start < end).map(item => item.id) } });
  }
  document = await request(`/documents/${document.id}`);
  const removed = removeSourceBodyHtml(document.bodyHtml, imageIds[0]);
  const updated = await request(`/documents/${document.id}`, { ...document, bodyHtml: removed, content: serializeBlocks(htmlToBlocks(removed)), sourceImages: [{ id: imageIds[1] }] }, "PUT");
  assert.equal(bodyText(updated.bodyHtml), "空。");
  assert.equal(serializeBlocks(updated.blocks), "{空|そら}。");
  assert.deepEqual(updated.sourceImages.map(item => item.id), [imageIds[1]]);
  assert.equal((await fetch(`${origin}/api/images/${imageIds[0]}/raw`, { headers: { Cookie: cookie } })).status, 200);
  const records = await request(`/documents/${document.id}/conversations`);
  assert.equal(records.conversations[0].id, conversation.id);
  assert.equal(records.conversations[0].messages.length, 4);
  assert.equal(records.conversations[0].groups.find(group => group.quote === "日本").orphaned, true);
  assert.equal(records.conversations[0].groups.find(group => group.quote === "空").orphaned, false);
});
