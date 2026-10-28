// Braces that introduce ruby syntax are escaped with a backslash in literal text.
// A block is one physical line, including empty lines in lyrics.
const origins = new Set(["manual", "source", "generated"]);
const blockTypes = new Set(["paragraph", "heading", "list_item"]);
const escapePart = (text) => text.replace(/[\\{}|]/g, "\\$&");

function retainBlockType(block, previous) {
  return blockTypes.has(previous?.type)
    ? { ...block, type: previous.type }
    : block;
}

function readPart(line, start, separators) {
  let value = "";
  for (let i = start; i < line.length; i++) {
    if (line[i] === "\\" && /[\\{}|]/.test(line[i + 1] ?? "")) {
      value += line[++i];
    } else if (separators.includes(line[i])) {
      return { value, end: i, separator: line[i] };
    } else {
      value += line[i];
    }
  }
  return { value, end: line.length, separator: null };
}

function parseLine(line) {
  const segments = [];
  let text = "";
  const flush = () => {
    if (text) segments.push({ text, reading: null, origin: null });
    text = "";
  };
  for (let i = 0; i < line.length; i++) {
    if (line[i] === "\\" && /[\\{}|]/.test(line[i + 1] ?? "")) {
      text += line[++i];
      continue;
    }
    if (line[i] !== "{") {
      text += line[i];
      continue;
    }
    const base = readPart(line, i + 1, "|{}");
    // Ordinary braces remain literal unless they introduce {base|reading}.
    if (base.separator !== "|") {
      text += line[i];
      continue;
    }
    const reading = readPart(line, base.end + 1, "{}|");
    if (
      !base.value.trim() ||
      !reading.value.trim() ||
      reading.separator !== "}"
    ) {
      throw new Error("注音格式不完整，请使用 {汉字|假名}，或先清除这条注音。");
    }
    flush();
    segments.push({
      text: base.value,
      reading: reading.value,
      origin: "manual",
    });
    i = reading.end;
  }
  flush();
  return segments;
}

function retainOrigins(segments, previousSegments) {
  const readings = new Map();
  for (const segment of previousSegments) {
    if (!segment.reading) continue;
    const key = `${segment.text}\u0000${segment.reading}`;
    if (!readings.has(key)) readings.set(key, []);
    readings.get(key).push(segment.origin);
  }
  return segments.map((segment) => {
    if (!segment.reading) return segment;
    const origin = readings
      .get(`${segment.text}\u0000${segment.reading}`)
      ?.shift();
    return origins.has(origin) ? { ...segment, origin } : segment;
  });
}

export function plainText(blocks) {
  return blocks
    .map((block) => block.segments.map((s) => s.text).join(""))
    .join("\n");
}

export function serializeBlocks(blocks) {
  return blocks
    .map((block) =>
      block.segments
        .map((s) =>
          s.reading
            ? `{${escapePart(s.text)}|${escapePart(s.reading)}}`
            : escapePart(s.text),
        )
        .join(""),
    )
    .join("\n");
}

export function parseText(content, previousBlocks = []) {
  if (typeof content !== "string") throw new Error("正文必须是文字。");
  const lines = content.replace(/\r\n?/g, "\n").split("\n");
  const oldByLine = new Map();
  for (const block of previousBlocks) {
    const key = serializeBlocks([block]);
    if (!oldByLine.has(key)) oldByLine.set(key, []);
    oldByLine.get(key).push(block);
  }
  const used = new Set();
  const blocks = lines.map((line) => {
    const segments = parseLine(line);
    const key = serializeBlocks([{ segments }]);
    const old = oldByLine.get(key)?.shift();
    if (old) {
      used.add(old.id);
      return retainBlockType(
        { id: old.id, segments: retainOrigins(segments, old.segments) },
        old,
      );
    }
    return { id: null, segments };
  });
  // A modified line at the same position keeps its identity when unambiguous.
  blocks.forEach((block, i) => {
    if (block.id) return;
    const old =
      lines.length === previousBlocks.length && !used.has(previousBlocks[i]?.id)
        ? previousBlocks[i]
        : null;
    block.id = old?.id ?? crypto.randomUUID();
    if (old) {
      used.add(old.id);
      // Repeated words consume provenance in their original occurrence order.
      block.segments = retainOrigins(block.segments, old.segments);
      if (blockTypes.has(old.type)) block.type = old.type;
    }
  });
  return blocks;
}

export function stats(blocks) {
  return {
    charCount: [...plainText(blocks).replace(/\s/g, "")].length,
    rubyCount: blocks.reduce(
      (sum, b) => sum + b.segments.filter((s) => s.reading).length,
      0,
    ),
  };
}

// Offsets count JavaScript UTF-16 units, matching textarea.selectionStart/End.
export function annotateBlocks(blocks, start, end, reading) {
  const text = plainText(blocks);
  if (start >= end || !text.slice(start, end).trim())
    throw new Error("先在正文中选中要标注的字词。");
  if (text.slice(start, end).includes("\n"))
    throw new Error("一次请选择同一行中的一个字词。");
  const next = structuredClone(blocks);
  let offset = 0;
  for (const block of next) {
    const length = block.segments.map((s) => s.text).join("").length;
    if (start >= offset && end <= offset + length) {
      const from = start - offset,
        to = end - offset;
      const before = [],
        after = [];
      let pos = 0;
      for (const s of block.segments) {
        const segEnd = pos + s.text.length;
        if (
          s.reading &&
          ((from > pos && from < segEnd) || (to > pos && to < segEnd))
        ) {
          throw new Error(
            "选区包含部分已有注音，请选择完整词组，或在注音列表中修改。",
          );
        }
        if (segEnd <= from) before.push(s);
        else if (pos >= to) after.push(s);
        else {
          if (pos < from)
            before.push({
              text: s.text.slice(0, from - pos),
              reading: null,
              origin: null,
            });
          if (segEnd > to)
            after.push({
              text: s.text.slice(to - pos),
              reading: null,
              origin: null,
            });
        }
        pos = segEnd;
      }
      const selected = text.slice(start, end);
      block.segments = [
        ...before,
        {
          text: selected,
          reading: reading.trim() || null,
          origin: reading.trim() ? "manual" : null,
        },
        ...after,
      ];
      return next;
    }
    offset += length + 1;
  }
  throw new Error("选区已变化，请重新选择字词。");
}

export function findTextOccurrences(blocks, query) {
  if (typeof query !== "string" || !query.trim())
    throw new Error("请填写要查找的字词，不能只含空白。");
  if (/[\r\n\u2028\u2029]/.test(query))
    throw new Error("查找字词不能跨行，请一次填写同一行的文字。");
  if ([...query].length > 100)
    throw new Error("查找字词最多100个字符。");
  const matches = [];
  let offset = 0;
  blocks.forEach((block, blockIndex) => {
    const text = block.segments.map((segment) => segment.text).join("");
    let position = 0;
    const ranges = block.segments
      .map((segment) => {
        const start = position;
        position += segment.text.length;
        return { start, end: position, reading: segment.reading };
      })
      .filter((range) => range.end > range.start);
    let cursor = 0,
      rangeIndex = 0,
      from;
    while ((from = text.indexOf(query, cursor)) !== -1) {
      const to = from + query.length;
      while (ranges[rangeIndex].end <= from) rangeIndex++;
      let lastIndex = rangeIndex;
      while (ranges[lastIndex].end < to) lastIndex++;
      const first = ranges[rangeIndex],
        last = ranges[lastIndex];
      const canAnnotate = !(
        (first.reading && from > first.start) ||
        (last.reading && to < last.end)
      );
      const currentReading =
        rangeIndex === lastIndex && from === first.start && to === first.end
          ? first.reading
          : null;
      const start = offset + from,
        end = offset + to;
      matches.push({
        key: JSON.stringify([
          query, block.id, blockIndex, start, end, currentReading,
        ]),
        blockId: block.id,
        blockIndex,
        start,
        end,
        before: [...text.slice(Math.max(0, from - 24), from)].slice(-12).join(""),
        after: [...text.slice(to, to + 24)].slice(0, 12).join(""),
        currentReading,
        canAnnotate,
        reason: canAnnotate
          ? ""
          : "选区包含部分已有注音，请选择完整词组，或在注音列表中修改。",
      });
      cursor = to;
    }
    offset += text.length + 1;
  });
  return matches;
}

export function annotateOccurrences(blocks, query, selectedKeys, reading) {
  const matches = new Map(
    findTextOccurrences(blocks, query).map((match) => [match.key, match]),
  );
  if (!Array.isArray(selectedKeys) || !selectedKeys.length)
    throw new Error("请先勾选要修改的位置。");
  if (typeof reading !== "string" || !reading.trim())
    throw new Error("请填写要应用的假名读音。");
  if (/[\r\n\u2028\u2029]/.test(reading) || [...reading.trim()].length > 200)
    throw new Error("读音不能换行，最多200个字符。");
  const selected = selectedKeys.map((key) => matches.get(key));
  if (
    new Set(selectedKeys).size !== selectedKeys.length ||
    selected.some((match) => !match)
  )
    throw new Error("选择的位置已变化，请重新查找并勾选。");
  const blocked = selected.find((match) => !match.canAnnotate);
  if (blocked) throw new Error(blocked.reason);
  let offset = 0;
  const offsets = blocks.map((block) => {
    const start = offset;
    offset += plainText([block]).length + 1;
    return start;
  });
  const next = blocks.slice();
  for (const match of selected) {
    next[match.blockIndex] = annotateBlocks(
      [next[match.blockIndex]],
      match.start - offsets[match.blockIndex],
      match.end - offsets[match.blockIndex],
      reading.trim(),
    )[0];
  }
  return next;
}

// Keep readings in unchanged regions. Ambiguous or edited words lose their
// reading explicitly, so a pronunciation cannot drift onto a different word.
export function editPlainText(blocks, text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  const raw = normalized
    .split("\n")
    .map((line) => escapePart(line))
    .join("\n");
  const oldPlain = blocks.map((b) => ({
    id: b.id,
    ...(blockTypes.has(b.type) ? { type: b.type } : {}),
    segments: [{ text: plainText([b]), reading: null, origin: null }],
  }));
  const next = parseText(raw, oldPlain);
  const byId = new Map(blocks.map((block) => [block.id, block]));
  const oldCounts = new Map(),
    newCounts = new Map();
  for (const [source, counts] of [
    [blocks, oldCounts],
    [next, newCounts],
  ]) {
    for (const block of source) {
      const line = plainText([block]);
      counts.set(line, (counts.get(line) || 0) + 1);
    }
  }
  let removed = 0;
  const retained = new Set();
  for (const block of next) {
    const old = byId.get(block.id);
    if (!old) continue;
    const oldText = plainText([old]),
      newText = plainText([block]);
    // Inserting/deleting identical lines does not identify which copy survived.
    if (
      oldCounts.get(newText) !== newCounts.get(newText) &&
      Math.max(oldCounts.get(newText) || 0, newCounts.get(newText) || 0) > 1
    ) {
      delete block.type;
      continue;
    }
    if (oldText === newText) {
      block.segments = structuredClone(old.segments);
      old.segments.forEach((s, i) => {
        if (s.reading) retained.add(`${old.id}:${i}`);
      });
      continue;
    }
    let prefix = 0,
      suffix = 0;
    const shorter = Math.min(oldText.length, newText.length);
    while (prefix < shorter && oldText[prefix] === newText[prefix]) prefix++;
    while (
      suffix < shorter &&
      oldText[oldText.length - suffix - 1] ===
        newText[newText.length - suffix - 1]
    )
      suffix++;
    // Overlap means a repeated substring admits several edit positions. Keep
    // only the outer regions that every possible position leaves unchanged.
    const safePrefix = Math.min(prefix, shorter - suffix);
    suffix = Math.min(suffix, shorter - prefix);
    prefix = safePrefix;
    const annotations = [];
    let offset = 0;
    old.segments.forEach((s, i) => {
      const end = offset + s.text.length;
      if (s.reading) {
        let at = -1;
        if (end <= prefix) at = offset;
        else if (offset >= oldText.length - suffix)
          at = offset + newText.length - oldText.length;
        if (at >= 0) {
          annotations.push({ ...s, start: at, end: at + s.text.length });
          retained.add(`${old.id}:${i}`);
        }
      }
      offset = end;
    });
    const segments = [];
    let pos = 0;
    for (const s of annotations) {
      if (s.start > pos)
        segments.push({
          text: newText.slice(pos, s.start),
          reading: null,
          origin: null,
        });
      segments.push({ text: s.text, reading: s.reading, origin: s.origin });
      pos = s.end;
    }
    if (pos < newText.length)
      segments.push({ text: newText.slice(pos), reading: null, origin: null });
    block.segments = segments;
  }
  for (const b of blocks)
    b.segments.forEach((s, i) => {
      if (s.reading && !retained.has(`${b.id}:${i}`)) removed++;
    });
  return { blocks: next, removed };
}
