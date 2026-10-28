import test from "node:test";
import assert from "node:assert/strict";
import { splitRubyDisplay } from "../shared/ruby-display.mjs";

const cases = [
  [
    "お父さん",
    "おとうさん",
    [
      { text: "お", reading: null },
      { text: "父", reading: "とう" },
      { text: "さん", reading: null },
    ],
  ],
  [
    "食べる",
    "たべる",
    [
      { text: "食", reading: "た" },
      { text: "べる", reading: null },
    ],
  ],
  [
    "取り戻す",
    "とりもどす",
    [
      { text: "取", reading: "と" },
      { text: "り", reading: null },
      { text: "戻", reading: "もど" },
      { text: "す", reading: null },
    ],
  ],
  [
    "青サギ",
    "あおサギ",
    [
      { text: "青", reading: "あお" },
      { text: "サギ", reading: null },
    ],
  ],
  [
    "青さぎ",
    "アオサギ",
    [
      { text: "青", reading: "アオ" },
      { text: "さぎ", reading: null },
    ],
  ],
  [
    "言い合い",
    "いいあい",
    [
      { text: "言", reading: "い" },
      { text: "い", reading: null },
      { text: "合", reading: "あ" },
      { text: "い", reading: null },
    ],
  ],
  [
    "おばあさんたち",
    "おばあさんたち",
    [{ text: "おばあさんたち", reading: null }],
  ],
  ["キリコ", "きりこ", [{ text: "キリコ", reading: null }]],
  ["𠮷野家", "よしのや", [{ text: "𠮷野家", reading: "よしのや" }]],
  ["時々", "ときどき", [{ text: "時々", reading: "ときどき" }]],
  ["〆切", "しめきり", [{ text: "〆切", reading: "しめきり" }]],
  [
    "何ヶ所",
    "なんヶしょ",
    [
      { text: "何", reading: "なん" },
      { text: "ヶ", reading: null },
      { text: "所", reading: "しょ" },
    ],
  ],
];
for (const [text, reading, expected] of cases) {
  test(`display ${text} / ${reading} preserves the original word`, () => {
    const parts = splitRubyDisplay(text, reading);
    assert.deepEqual(parts, expected);
    assert.equal(parts.map((part) => part.text).join(""), text);
  });
}

test("ambiguous internal kana anchors do not guess a split", () => {
  assert.deepEqual(splitRubyDisplay("漢か字", "あかいかう"), [
    { text: "漢か字", reading: null },
  ]);
});
test("unmatched kana, empty Han readings and ヶ sound changes fall back to intact text", () => {
  for (const [text, reading] of [
    ["お父さん", "とうさん"],
    ["食べる", "べる"],
    ["一ヶ月", "いっかげつ"],
    ["漢字", ""],
    ["漢字", null],
  ])
    assert.deepEqual(splitRubyDisplay(text, reading), [
      { text, reading: null },
    ]);
});
test("kana normalization preserves original reading characters and grapheme boundaries", () => {
  assert.deepEqual(splitRubyDisplay("食べる", "タベル"), [
    { text: "食", reading: "タ" },
    { text: "べる", reading: null },
  ]);
  assert.deepEqual(splitRubyDisplay("食べる", "ﾀﾍﾞﾙ"), [
    { text: "食", reading: "ﾀ" },
    { text: "べる", reading: null },
  ]);
});
