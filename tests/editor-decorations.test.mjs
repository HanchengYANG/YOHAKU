import test from "node:test";
import assert from "node:assert/strict";
import { editorDecorations, reconcileEditorQaMarks } from "../client/editor-decorations.mjs";
import { bodyRanges, bodyText, editBodyText, markBodyRange } from "../shared/article-html.mjs";

test("editor decorations preserve UTF-16 positions, repeated words and overlapping groups", () => {
  const text = "🌸背中。\n背中を読む。";
  const parts = editorDecorations(text, {
    sentences: [{id:"s1",start:0,end:5},{id:"s2",start:6,end:text.length}],
    qa: [{id:"a",start:2,end:4},{id:"b",start:3,end:4},{id:"c",start:6,end:8}],
    sources: [{id:"photo",start:0,end:text.length}],
  });
  assert.equal(parts.map(part => part.text).join(""), text);
  assert.deepEqual(parts.find(part => part.start === 3).groupIds, ["a", "b"]);
  assert.deepEqual(parts.find(part => part.start === 6).groupIds, ["c"]);
  assert.deepEqual(parts.find(part => part.start === 5).sentenceIds, []);
  assert.deepEqual(parts.find(part => part.start === 6).sentenceIds, ["s2"]);
  assert.ok(parts.every(part => part.sourceIds.includes("photo")));
});

test("a saved sentence ID decorates all fragments across paragraph and source boundaries", () => {
  const parts = editorDecorations("前句\n後句", {
    sentences: [{id:"sentence",start:0,end:5}],
    sources: [{id:"one",start:0,end:2},{id:"two",start:3,end:5}], qa: [],
  });
  assert.ok(parts.every(part => part.sentenceIds[0] === "sentence"));
  assert.equal(parts.map(part => part.text).join(""), "前句\n後句");
});

test("new question markers never jump to a repeated word in a different undo snapshot", () => {
  const original = '<p data-paragraph-id="p"><span data-sentence-id="s">猫猫。</span></p>';
  const withPreviousGroup = markBodyRange(original, 1, 2, "previous");
  // Precisely deleting the first cat leaves the second, already marked cat.
  const redo = editBodyText(withPreviousGroup, "猫。", {editStart:0,editEnd:1});
  const saved = markBodyRange(withPreviousGroup, 0, 1, "new");
  const reconciled = reconcileEditorQaMarks(redo, saved, {newIds:["new"]});
  assert.equal(bodyText(reconciled), "猫。");
  assert.deepEqual(bodyRanges(reconciled).qa.map(({id,start,end})=>({id,start,end})), [{id:"previous",start:0,end:1}]);
  // Equal-text snapshots can still receive the unambiguous new association.
  const unchanged = reconcileEditorQaMarks(withPreviousGroup, saved, {newIds:["new"]});
  assert.deepEqual(bodyRanges(unchanged).qa.find(range=>range.id==="new"), {id:"new",start:0,end:1,text:"猫"});
  const deleted = reconcileEditorQaMarks(reconciled, saved, {newIds:["new"],deletedIds:["previous"]});
  assert.deepEqual(bodyRanges(deleted).qa, []);
});
