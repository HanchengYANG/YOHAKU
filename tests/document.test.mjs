import test from "node:test";
import assert from "node:assert/strict";
import {
  parseText,
  plainText,
  serializeBlocks,
  stats,
  annotateBlocks,
  findTextOccurrences,
  annotateOccurrences,
  editPlainText,
} from "../shared/document.mjs";

test("ruby groups exclude okurigana and preserve lyric lines", () => {
  const content =
    "はーい{口|くち}{開|あ}けてー\n\n{汚|きたな}い{言葉|ことば}の{歯石|しせき}が{取|と}れないね〜\n";
  const blocks = parseText(content);
  assert.equal(blocks.length, 4);
  assert.equal(
    plainText(blocks),
    "はーい口開けてー\n\n汚い言葉の歯石が取れないね〜\n",
  );
  assert.equal(serializeBlocks(blocks), content);
  assert.equal(blocks[2].segments[2].text, "言葉");
  assert.equal(stats(blocks).rubyCount, 6);
});

test("edits preserve stable block identities and unchanged source readings", () => {
  const old = parseText("{背中|せなか}を撫でる\n空を見た");
  old[0].segments[0].origin = "source";
  const same = parseText(serializeBlocks(old), old);
  assert.deepEqual(same, old);
  const changed = parseText("{背中|せなか}を見た\n空を見た", old);
  assert.equal(changed[0].id, old[0].id);
  assert.equal(changed[0].segments[0].origin, "source");
  const inserted = parseText("新しい行\n{背中|せなか}を撫でる\n空を見た", old);
  assert.equal(inserted[1].id, old[0].id);
  assert.equal(inserted[2].id, old[1].id);
  assert.notEqual(inserted[0].id, old[0].id);
  assert.equal(new Set(parseText("空\n空\n空").map((b) => b.id)).size, 3);
});

test("repeated word readings retain each occurrence provenance after line edits", () => {
  const old = parseText("{空|そら}と{空|そら}。");
  old[0].segments[0].origin = "source";
  old[0].segments[2].origin = "generated";
  const changed = parseText("あの{空|そら}と{空|そら}、また{空|そら}。", old);
  assert.deepEqual(
    changed[0].segments.filter((s) => s.reading).map((s) => s.origin),
    ["source", "generated", "manual"],
  );
  assert.equal(changed[0].id, old[0].id);

  const adjacentPlain = parseText("あ{の|の}{空|そら}");
  adjacentPlain[0].segments[2].origin = "source";
  const removed = annotateBlocks(adjacentPlain, 1, 2, "");
  const reopened = parseText(serializeBlocks(removed), removed);
  assert.equal(reopened[0].segments.find((s) => s.reading).origin, "source");
});

test("literal syntax characters round trip without becoming annotations", () => {
  const blocks = [
    {
      id: "literal",
      segments: [{ text: "{言葉|ことば} \\ 空", reading: null, origin: null }],
    },
  ];
  assert.equal(
    plainText(parseText(serializeBlocks(blocks))),
    "{言葉|ことば} \\ 空",
  );
  assert.equal(parseText("{補足}")[0].segments[0].text, "{補足}");
  assert.throws(() => parseText("{空|}"), /注音格式/);
  assert.throws(() => parseText("{空|そら"), /注音格式/);
});

test("plain editing retains unchanged ruby after insertions, drops changed readings with a count", () => {
  const old = parseText("{背中|せなか}を撫でる\n{空|そら}を見た");
  const edited = editPlainText(old, "その背中を撫でる\n空を見た");
  assert.equal(
    serializeBlocks(edited.blocks),
    "その{背中|せなか}を撫でる\n{空|そら}を見た",
  );
  assert.equal(edited.removed, 0);
  const inserted = editPlainText(old, "新しい行\n背中を撫でる\n空を見た");
  assert.equal(inserted.blocks[1].segments[0].reading, "せなか");
  assert.equal(inserted.blocks[2].segments[0].reading, "そら");
  const changed = editPlainText(old, "背を撫でる\n空を見た");
  assert.equal(changed.removed, 1);
  assert.equal(serializeBlocks(changed.blocks), "背を撫でる\n{空|そら}を見た");
});

test("ambiguous repeated text edits remove readings instead of silently choosing an occurrence", () => {
  const old = parseText("{右|みぎ}の{上|うえ}{上|かみ}へ{行|い}く");
  const deleted = editPlainText(old, "右の上へ行く");
  assert.equal(serializeBlocks(deleted.blocks), "{右|みぎ}の上へ{行|い}く");
  assert.equal(deleted.removed, 2);
  const inserted = editPlainText(
    parseText("{右|みぎ}の{上|うえ}へ{行|い}く"),
    "右の上上へ行く",
  );
  assert.equal(serializeBlocks(inserted.blocks), "{右|みぎ}の上上へ{行|い}く");
  assert.equal(inserted.removed, 1);

  const lines = parseText("{上|うえ}\n{上|かみ}\n{空|そら}");
  const deletedLine = editPlainText(lines, "上\n空");
  assert.equal(serializeBlocks(deletedLine.blocks), "上\n{空|そら}");
  assert.equal(deletedLine.removed, 2);
});

test("annotating plain selections changes only that span and rejects splitting a ruby group", () => {
  const old = parseText("あの背中を{見|み}た");
  const next = annotateBlocks(old, 2, 4, "せなか");
  assert.equal(serializeBlocks(next), "あの{背中|せなか}を{見|み}た");
  assert.equal(plainText(next), plainText(old));
  assert.throws(() => annotateBlocks(next, 2, 3, "せ"), /完整词组/);
  assert.throws(
    () => annotateBlocks(parseText("あ\n空"), 0, 3, "そら"),
    /同一行/,
  );
  assert.equal(
    serializeBlocks(annotateBlocks(next, 2, 4, "")),
    "あの背中を{見|み}た",
  );
});

test("batch annotations find literal non-overlapping occurrences by line and preserve text and IDs", () => {
  const blocks = parseText("名字名字\n名字.*名字\nあああ");
  const snapshot = structuredClone(blocks);
  const matches = findTextOccurrences(blocks, "名字");
  assert.deepEqual(matches.map(({ start, end, blockIndex }) => [start, end, blockIndex]), [
    [0, 2, 0], [2, 4, 0], [5, 7, 1], [9, 11, 1],
  ]);
  assert.equal(new Set(matches.map((match) => match.key)).size, 4);
  assert.equal(matches.every((match) => match.canAnnotate), true);
  assert.deepEqual(matches.map((match) => match.currentReading), [null, null, null, null]);
  assert.equal(findTextOccurrences(blocks, ".*").length, 1);
  assert.equal(findTextOccurrences(blocks, "ああ").length, 1);
  assert.deepEqual(findTextOccurrences(blocks, "不存在"), []);
  const changed = annotateOccurrences(blocks, "名字", matches.map((match) => match.key), "みょうじ");
  assert.equal(plainText(changed), plainText(blocks));
  assert.deepEqual(changed.map((block) => block.id), blocks.map((block) => block.id));
  assert.deepEqual(findTextOccurrences(changed, "名字").map((match) => match.currentReading),
    ["みょうじ", "みょうじ", "みょうじ", "みょうじ"]);
  assert.equal(changed.flatMap((block) => block.segments).filter((segment) => segment.reading)
    .every((segment) => segment.origin === "manual"), true);
  assert.deepEqual(blocks, snapshot);
});

test("batch annotations apply two readings to explicit subsets without replacing other occurrences", () => {
  const blocks = parseText("{名字|ミンツー}と{名字|みょうじ}\n{名字|ミンツー}と{名字|みょうじ}と{空|そら}");
  for (const segment of blocks.flatMap((block) => block.segments))
    if (segment.reading) segment.origin = "generated";
  blocks[1].segments.at(-1).origin = "source";
  const matches = findTextOccurrences(blocks, "名字");
  const first = annotateOccurrences(blocks, "名字", [matches[0].key, matches[2].key], "みょうじ");
  assert.equal(first[0].segments[2].reading, "みょうじ");
  assert.equal(first[0].segments[2].origin, "generated");
  const remaining = findTextOccurrences(first, "名字");
  const second = annotateOccurrences(first, "名字", [remaining[1].key, remaining[3].key], "ミンツー");
  assert.deepEqual(findTextOccurrences(second, "名字").map((match) => match.currentReading),
    ["みょうじ", "ミンツー", "みょうじ", "ミンツー"]);
  assert.deepEqual(second[1].segments.at(-1), blocks[1].segments.at(-1));
  assert.equal(plainText(second), plainText(blocks));
  assert.deepEqual(second.map((block) => block.id), blocks.map((block) => block.id));
});

test("batch annotations atomically reject partial ruby boundaries and can merge complete words", () => {
  const blocks = parseText("食と{食べる|たべる}\n{生|う}まれた");
  const snapshot = structuredClone(blocks);
  const matches = findTextOccurrences(blocks, "食");
  assert.deepEqual(matches.map((match) => match.canAnnotate), [true, false]);
  assert.match(matches[1].reason, /完整词组/);
  assert.throws(() => annotateOccurrences(blocks, "食", matches.map((match) => match.key), "しょく"), /完整词组/);
  assert.deepEqual(blocks, snapshot);
  const whole = findTextOccurrences(blocks, "食べる");
  assert.equal(whole[0].currentReading, "たべる");
  const changed = annotateOccurrences(blocks, "食べる", [whole[0].key], "たべる");
  assert.equal(changed[0].segments.at(-1).text, "食べる");
  const merged = findTextOccurrences(changed, "生まれた");
  assert.equal(merged[0].canAnnotate, true);
  const final = annotateOccurrences(changed, "生まれた", [merged[0].key], "うまれた");
  assert.deepEqual(final[1].segments, [{ text: "生まれた", reading: "うまれた", origin: "manual" }]);
  assert.equal(plainText(final), plainText(blocks));
});

test("batch annotations reject stale, foreign-query, duplicate and invalid selections before applying", () => {
  const blocks = parseText("名字と名字");
  const matches = findTextOccurrences(blocks, "名字");
  const snapshot = structuredClone(blocks);
  for (const keys of [[matches[0].key, "unknown"], [matches[0].key, matches[0].key]]) {
    assert.throws(() => annotateOccurrences(blocks, "名字", keys, "みょうじ"), /重新查找/);
    assert.deepEqual(blocks, snapshot);
  }
  assert.throws(() => annotateOccurrences(blocks, "と", [matches[0].key], "と"), /重新查找/);
  const edited = editPlainText(blocks, "あの名字と名字").blocks;
  assert.throws(() => annotateOccurrences(edited, "名字", [matches[0].key], "みょうじ"), /重新查找/);
  assert.throws(() => annotateOccurrences(blocks, "名字", [], "みょうじ"), /勾选/);
  for (const reading of ["", "  ", null, "みょ\nうじ", "あ".repeat(201)])
    assert.throws(() => annotateOccurrences(blocks, "名字", [matches[0].key], reading), /读音/);
  for (const query of ["", "  ", null, "名字\n食", "名字\r食", "あ".repeat(101)])
    assert.throws(() => findTextOccurrences(blocks, query), /查找/);
  assert.deepEqual(blocks, snapshot);
});

test("batch annotations use UTF-16 offsets with intact Unicode context", () => {
  const blocks = parseText("😀名字.*名字\n𠮷野と😀名字");
  const matches = findTextOccurrences(blocks, "名字");
  assert.deepEqual(matches.map((match) => [match.start, match.end]), [[2, 4], [6, 8], [15, 17]]);
  assert.equal(matches[0].before, "😀");
  assert.equal(matches[2].before, "𠮷野と😀");
  assert.equal(matches.every((match) => plainText(blocks).slice(match.start, match.end) === "名字"), true);
  const emoji = findTextOccurrences(blocks, "😀");
  const changed = annotateOccurrences(blocks, "😀", [emoji[1].key], "えがお");
  assert.equal(serializeBlocks(changed), "😀名字.*名字\n𠮷野と{😀|えがお}名字");
  const longContext = findTextOccurrences(parseText("😀".repeat(20) + "名字" + "𠮷".repeat(20)), "名字")[0];
  assert.equal(longContext.before, "😀".repeat(12));
  assert.equal(longContext.after, "𠮷".repeat(12));
});

test("structured layout survives text correction and batch ruby edits without changing original words", () => {
  const original = parseText("{登場人物|とうじょうじんぶつ}\n{名字|みょうじ}は田中です。\n「まだ？」……「はい。」");
  original[0].type = "heading";
  original[1].type = "list_item";
  original[2].type = "paragraph";
  const reopened = parseText(serializeBlocks(original), original);
  assert.deepEqual(reopened, original);
  const corrected = editPlainText(original, plainText(original).replace("田中", "山田")).blocks;
  assert.deepEqual(corrected.map((block) => block.type), ["heading", "list_item", "paragraph"]);
  assert.equal(corrected[1].id, original[1].id);
  const matches = findTextOccurrences(corrected, "名字");
  const annotated = annotateOccurrences(corrected, "名字", matches.map((match) => match.key), "ミンツー");
  assert.equal(plainText(annotated), plainText(corrected));
  assert.deepEqual(annotated.map((block) => block.type), ["heading", "list_item", "paragraph"]);
  assert.equal(annotated[1].segments[0].reading, "ミンツー");
  assert.equal(annotated[2].segments[0].text, "「まだ？」……「はい。」");
  const inserted = editPlainText(original, `新しい行\n${plainText(original)}`).blocks;
  assert.equal(inserted[0].type, undefined);
  assert.equal(inserted[1].type, "heading");
});
