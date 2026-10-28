import test from "node:test";
import assert from "node:assert/strict";
import {
  parseText,
  plainText,
  serializeBlocks,
  stats,
  annotateBlocks,
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
