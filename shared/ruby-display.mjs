const graphemes = new Intl.Segmenter("ja", { granularity: "grapheme" });
const isHan = (text) => /[\p{Script=Han}〆]/u.test(text);
const normalizeKana = (text) =>
  text
    .normalize("NFKC")
    .replace(/[\u30a1-\u30f6\u30fd\u30fe]/gu, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60),
    )
    .normalize("NFC");

// Display only: whole-word text, reading, provenance and UTF-16 ranges stay
// unchanged in storage. Kana anchors must admit exactly one non-empty alignment.
export function splitRubyDisplay(text, reading) {
  const plain = [{ text, reading: null }];
  if (typeof reading !== "string" || !reading.trim() || !isHan(text))
    return plain;
  const runs = [];
  for (const { segment } of graphemes.segment(text)) {
    const han = isHan(segment);
    if (runs.length && runs.at(-1).han === han) runs.at(-1).text += segment;
    else runs.push({ text: segment, han });
  }
  if (runs.length === 1) return [{ text, reading }];

  let normalized = "";
  const originalOffsets = new Map([[0, 0]]);
  for (const { segment, index } of graphemes.segment(reading)) {
    normalized += normalizeKana(segment);
    originalOffsets.set(normalized.length, index + segment.length);
  }
  const memo = new Map();
  const align = (index, position) => {
    const key = `${index}:${position}`;
    if (memo.has(key)) return memo.get(key);
    if (index === runs.length)
      return { count: Number(position === normalized.length), parts: [] };
    const run = runs[index];
    let result = { count: 0, parts: [] };
    if (!run.han) {
      const anchor = normalizeKana(run.text);
      const end = position + anchor.length;
      if (normalized.startsWith(anchor, position) && originalOffsets.has(end)) {
        const next = align(index + 1, end);
        result = {
          count: next.count,
          parts: [{ text: run.text, reading: null }, ...next.parts],
        };
      }
    } else {
      const anchor = runs[index + 1]
        ? normalizeKana(runs[index + 1].text)
        : null;
      let end =
        anchor === null
          ? normalized.length
          : normalized.indexOf(anchor, position + 1);
      while (end > position) {
        if (originalOffsets.has(end)) {
          const next = align(index + 1, end);
          if (next.count) {
            if (!result.count)
              result.parts = [
                {
                  text: run.text,
                  reading: reading.slice(
                    originalOffsets.get(position),
                    originalOffsets.get(end),
                  ),
                },
                ...next.parts,
              ];
            result.count = Math.min(2, result.count + next.count);
            if (result.count === 2) break;
          }
        }
        if (anchor === null) break;
        end = normalized.indexOf(anchor, end + 1);
      }
    }
    memo.set(key, result);
    return result;
  };
  const result = align(0, 0);
  return result.count === 1 ? result.parts : plain;
}
