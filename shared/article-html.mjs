import { randomUuid } from "./random-uuid.mjs";

const escapeHtml = (text) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
const decodeHtml = (text) => text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (all, entity) => {
  if (entity[0] === "#") {
    const value = entity[1].toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return value > 0 && value <= 0x10ffff && !(value >= 0xd800 && value <= 0xdfff) ? String.fromCodePoint(value) : "�";
  }
  return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0" })[entity.toLowerCase()];
});
const identifier = (value) => typeof value === "string" && /^[\w.:-]{1,160}$/.test(value);
const tags = new Set(["p", "span", "mark", "ruby", "rt", "rp", "br"]);
const attrs = new Set(["data-paragraph-id", "data-sentence-id", "data-source-image-id", "data-qa-group-ids", "data-origin", "data-block-type"]);
const error = (message) => Object.assign(new Error(message), { status: 400 });

// This is deliberately a closed HTML grammar, rather than a general browser HTML
// parser. Unknown elements and malformed nesting fail before anything is rendered.
function parseBody(html) {
  if (typeof html !== "string" || html.length > 2_000_000) throw error("HTML 正文格式无效或过长。");
  const root = { tag: "root", attrs: {}, children: [] }, stack = [root];
  const tokens = html.match(/<[^>]*>|[^<]+/g) || [];
  if (tokens.join("") !== html) throw error("HTML 正文包含不完整的标签。");
  for (const token of tokens) {
    if (!token.startsWith("<")) {
      const text = decodeHtml(token);
      if (stack.length === 1 && !text.trim()) continue;
      if (stack.length === 1) throw error("正文文字必须放在段落中。");
      stack.at(-1).children.push({ text });
      continue;
    }
    const closing = /^<\/([a-z]+)\s*>$/i.exec(token);
    if (closing) {
      if (stack.length === 1 || stack.at(-1).tag !== closing[1].toLowerCase()) throw error("HTML 正文标签未正确闭合。");
      stack.pop(); continue;
    }
    const opening = /^<([a-z]+)((?:\s+[\w:-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>$/i.exec(token);
    if (!opening || !tags.has(opening[1].toLowerCase())) throw error("正文只允许段落、句子、来源、问答标记和振假名标签。");
    const tag = opening[1].toLowerCase(), parent = stack.at(-1);
    if ((tag === "p") !== (parent.tag === "root") || (tag === "p" && stack.length !== 1)) throw error("HTML 正文段落结构无效。");
    if (["rt", "rp"].includes(tag) && parent.tag !== "ruby") throw error("振假名必须属于 ruby 标签。");
    if (tag === "ruby" && stack.some((node) => ["ruby", "rt", "rp"].includes(node.tag))) throw error("振假名不能嵌套。");
    if (["rt", "rp"].includes(parent.tag)) throw error("注音内容只能包含文字。");
    const node = { tag, attrs: {}, children: [] };
    for (const match of opening[2].matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      const name = match[1].toLowerCase(), value = decodeHtml(match[2] ?? match[3]);
      if (!attrs.has(name)) continue; // Event handlers/styles/URLs never survive.
      if (Object.hasOwn(node.attrs, name)) throw error("HTML 正文包含重复属性。");
      if (name === "data-qa-group-ids") {
        const ids = value.trim().split(/\s+/).filter(Boolean);
        if (!ids.length || ids.length > 100 || ids.some((id) => !identifier(id))) throw error("问答组标记格式无效。");
        node.attrs[name] = [...new Set(ids)].join(" ");
      } else if (name === "data-origin") {
        if (!["source", "generated", "manual"].includes(value)) throw error("读音来源无效。");
        node.attrs[name] = value;
      } else if (name === "data-block-type") {
        if (!["paragraph", "heading", "list_item"].includes(value)) throw error("段落类型无效。");
        node.attrs[name] = value;
      } else {
        if (!identifier(value)) throw error("段落、句子或来源标识无效。");
        node.attrs[name] = value;
      }
    }
    for (const name of Object.keys(node.attrs)) {
      const valid = name === "data-paragraph-id" || name === "data-block-type" ? tag === "p"
        : name === "data-origin" ? tag === "ruby"
        : name === "data-qa-group-ids" ? tag === "mark"
        : tag === "span";
      if (!valid) throw error("正文标记属性不属于对应标签。");
    }
    if (tag === "mark" && !node.attrs["data-qa-group-ids"]) throw error("问答标记缺少组标识。");
    parent.children.push(node);
    if (tag !== "br") {
      if (opening[3]) throw error("正文标签必须明确闭合。");
      if (stack.length >= 32) throw error("正文标签嵌套过深。");
      stack.push(node);
    }
  }
  if (stack.length !== 1 || !root.children.length) throw error("HTML 正文标签未正确闭合或缺少段落。");
  const paragraphIds = new Set();
  return root.children.map((p) => {
    const id = p.attrs["data-paragraph-id"] || randomUuid();
    if (paragraphIds.has(id)) throw error("段落标识不能重复。");
    paragraphIds.add(id);
    const atoms = [];
    function visit(node, metadata = {}) {
      if (Object.hasOwn(node, "text")) { if (node.text) atoms.push({ ...metadata, text: node.text }); return; }
      if (["rt", "rp"].includes(node.tag)) return;
      const next = { ...metadata };
      if (node.attrs["data-sentence-id"]) next.sentenceId = node.attrs["data-sentence-id"];
      if (node.attrs["data-source-image-id"]) next.sourceImageId = node.attrs["data-source-image-id"];
      if (node.attrs["data-qa-group-ids"]) next.qaGroupIds = [...new Set([...(next.qaGroupIds || []), ...node.attrs["data-qa-group-ids"].split(" ")])];
      if (node.tag === "ruby") {
        const readings = node.children.filter((child) => child.tag === "rt");
        if (readings.length !== 1) throw error("每个振假名必须包含一条读音。");
        next.reading = readings[0].children.map((child) => child.text || "").join("");
        if (!next.reading.trim() || next.reading.length > 1000 || /[\r\n\u2028\u2029]/.test(next.reading)) throw error("振假名读音不能为空、过长或跨行。");
        next.origin = node.attrs["data-origin"] || "manual";
        next.rubyId = randomUuid();
      }
      const before = atoms.length;
      if (node.tag === "br") atoms.push({ ...next, text: "\n" });
      else node.children.forEach((child) => visit(child, next));
      if (node.tag === "ruby" && atoms.slice(before).some((atom) => /[\r\n\u2028\u2029]/.test(atom.text))) throw error("一条振假名不能跨行。");
    }
    p.children.forEach((child) => visit(child));
    return { id, ...(p.attrs["data-block-type"] ? { type: p.attrs["data-block-type"] } : {}), atoms };
  });
}

const metadataKey = (atom) => JSON.stringify([atom.sentenceId, atom.sourceImageId, atom.qaGroupIds]);
function inline(atom) {
  let text = escapeHtml(atom.text).replaceAll("\n", "<br>");
  if (atom.qaGroupIds?.length) text = `<mark data-qa-group-ids="${atom.qaGroupIds.join(" ")}">${text}</mark>`;
  if (atom.sourceImageId) text = `<span data-source-image-id="${atom.sourceImageId}">${text}</span>`;
  if (atom.sentenceId) text = `<span data-sentence-id="${atom.sentenceId}">${text}</span>`;
  return text;
}
function renderBody(paragraphs) {
  return paragraphs.map((p) => {
    const groups = [];
    for (const atom of p.atoms) {
      if (!atom.text) continue;
      const last = groups.at(-1);
      if (last && last.rubyId === atom.rubyId && metadataKey(last) === metadataKey(atom) && last.reading === atom.reading && last.origin === atom.origin) last.text += atom.text;
      else groups.push({ ...atom });
    }
    let html = "";
    for (let i = 0; i < groups.length; i++) {
      const atom = groups[i];
      if (!atom.reading) { html += inline(atom); continue; }
      const ruby = [atom];
      while (i + 1 < groups.length && groups[i + 1].rubyId === atom.rubyId) ruby.push(groups[++i]);
      const origin = ` data-origin="${atom.origin || "manual"}"`;
      html += `<ruby${origin}>${ruby.map(inline).join("")}<rp>（</rp><rt>${escapeHtml(atom.reading)}</rt><rp>）</rp></ruby>`;
    }
    return `<p data-paragraph-id="${p.id}"${p.type ? ` data-block-type="${p.type}"` : ""}>${html}</p>`;
  }).join("");
}

export const normalizeBodyHtml = (html) => renderBody(parseBody(html));
export const bodyText = (html) => parseBody(html).map((p) => p.atoms.map((atom) => atom.text).join("")).join("\n");
export function blocksToHtml(blocks, { sourceImageId = null } = {}) {
  if (sourceImageId && !identifier(sourceImageId)) throw error("图片来源标识无效。");
  return renderBody(blocks.map((block) => ({ id: identifier(block.id) ? block.id : randomUuid(),
    ...(block.type ? { type: block.type } : {}),
    atoms: block.segments.map((segment) => ({ text: segment.text,
      ...(segment.reading ? { reading: segment.reading, origin: segment.origin || "manual", rubyId: randomUuid() } : {}),
      ...(sourceImageId ? { sourceImageId } : {}),
    })),
  })));
}
export function htmlToBlocks(html) {
  // Legacy annotation tools work with physical lines. A canonical paragraph may
  // also contain <br>; derive stable line IDs without changing that paragraph.
  return parseBody(html).flatMap((p) => {
    const lines = [[]];
    for (const atom of p.atoms) {
      atom.text.split("\n").forEach((text, index) => {
        if (index) lines.push([]);
        if (!text) return;
        const segments = lines.at(-1), last = segments.at(-1);
        if (last && (atom.reading ? last._rubyId === atom.rubyId : !last.reading)) last.text += text;
        else segments.push({ text, reading: atom.reading || null, origin: atom.reading ? atom.origin : null, _rubyId: atom.rubyId });
      });
    }
    return lines.map((segments, index) => ({ id: index ? `${p.id}:line:${index}` : p.id, ...(p.type ? { type: p.type } : {}), segments: segments.map(({ _rubyId, ...segment }) => segment) }));
  });
}

export function bodyRanges(html) {
  const result = { sentences: [], sources: [], qa: [] };
  const latest = { sentences: new Map(), sources: new Map(), qa: new Map() };
  const paragraphs = parseBody(html), documentText = paragraphs.map((p) => p.atoms.map((atom) => atom.text).join("")).join("\n");
  let offset = 0;
  for (const p of paragraphs) {
    for (const atom of p.atoms) {
      for (const [key, ids] of [["sentences", atom.sentenceId ? [atom.sentenceId] : []], ["sources", atom.sourceImageId ? [atom.sourceImageId] : []], ["qa", atom.qaGroupIds || []]]) {
        for (const id of ids) {
          const previous = latest[key].get(id);
          const newlineGap = previous && key === "sentences" && previous.end < offset && /^\n+$/.test(documentText.slice(previous.end, offset)) ? documentText.slice(previous.end, offset) : "";
          if (previous?.end === offset || newlineGap) { previous.end = offset + atom.text.length; previous.text += newlineGap + atom.text; }
          else {
            const range = { id, start: offset, end: offset + atom.text.length, text: atom.text };
            result[key].push(range); latest[key].set(id, range);
          }
        }
      }
      offset += atom.text.length;
    }
    offset++;
  }
  return result;
}

function mapRanges(html, boundaries, transform) {
  let offset = 0, boundaryIndex = 0;
  const sorted = [...new Set(boundaries)].sort((a, b) => a - b);
  const paragraphs = parseBody(html);
  for (const p of paragraphs) {
    p.atoms = p.atoms.flatMap((atom) => {
      const start = offset, end = start + atom.text.length;
      while (boundaryIndex < sorted.length && sorted[boundaryIndex] <= start) boundaryIndex++;
      const points = [start];
      while (boundaryIndex < sorted.length && sorted[boundaryIndex] < end) points.push(sorted[boundaryIndex++]);
      points.push(end);
      offset = end;
      return points.slice(0, -1).map((point, index) => transform({ ...atom, text: atom.text.slice(point - start, points[index + 1] - start) }, point, points[index + 1]));
    });
    offset++;
  }
  return renderBody(paragraphs);
}
function sentenceBoundaries(html, fragments, preserveExisting) {
  if (!Array.isArray(fragments) || fragments.some((fragment) => typeof fragment !== "string" || !fragment.length) || fragments.join("") !== bodyText(html)) throw error("分句结果改写了原文，请重试。");
  let offset = 0;
  const ranges = fragments.map((fragment) => { const start = offset; offset += fragment.length; return { start, end: offset, id: randomUuid() }; });
  let rangeIndex = 0;
  return mapRanges(html, ranges.map((range) => range.end), (atom, start) => {
    while (rangeIndex < ranges.length - 1 && start >= ranges[rangeIndex].end) rangeIndex++;
    return { ...atom, sentenceId: preserveExisting && atom.sentenceId ? atom.sentenceId : ranges[rangeIndex].id };
  });
}
export const applySentenceBoundaries = (html, fragments) => sentenceBoundaries(html, fragments, false);
export const initializeSentenceBoundaries = (html, fragments) => sentenceBoundaries(html, fragments, true);
export function markBodyRange(html, start, end, groupId) {
  const text = bodyText(html);
  if (!identifier(groupId) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= end || end > text.length) throw error("问答选区无效。");
  return mapRanges(html, [start, end], (atom, from, to) => from >= start && to <= end ? { ...atom, qaGroupIds: [...new Set([...(atom.qaGroupIds || []), groupId])] } : atom);
}
export function removeQaMarks(html, groupIds) {
  const ids = groupIds === undefined ? null : new Set(Array.isArray(groupIds) ? groupIds : [groupIds]);
  return mapRanges(html, [], (atom) => ({ ...atom, qaGroupIds: ids ? (atom.qaGroupIds || []).filter((id) => !ids.has(id)) : [] }));
}

// Keep the original metadata on a corrected span, and never search for matching
// words elsewhere in the article. A single textarea change is one replacement.
export function editBodyText(html, text, options = {}) {
  const { boundarySide = "previous" } = options;
  if (Object.hasOwn(options, "sourceImageId") && options.sourceImageId !== null && !identifier(options.sourceImageId)) throw error("图片来源标识无效。");
  const normalized = text.replace(/\r\n?/g, "\n"), old = bodyText(html);
  if (normalized === old) return normalizeBodyHtml(html);
  let start = 0, suffix = 0;
  while (start < old.length && start < normalized.length && old[start] === normalized[start]) start++;
  while (suffix < old.length - start && suffix < normalized.length - start && old[old.length - 1 - suffix] === normalized[normalized.length - 1 - suffix]) suffix++;
  const { editStart, editEnd } = options;
  if (Number.isSafeInteger(editStart) && Number.isSafeInteger(editEnd) && editStart >= 0 && editEnd >= editStart && editEnd <= old.length) {
    const insertionLength = normalized.length - old.length + editEnd - editStart;
    if (insertionLength >= 0 && old.slice(0, editStart) === normalized.slice(0, editStart) && old.slice(editEnd) === normalized.slice(editStart + insertionLength)) {
      start = editStart;
      suffix = old.length - editEnd;
      const oldPart = old.slice(editStart, editEnd), newPart = normalized.slice(editStart, editStart + insertionLength);
      let prefixTrim = 0, suffixTrim = 0;
      while (prefixTrim < oldPart.length && prefixTrim < newPart.length && oldPart[prefixTrim] === newPart[prefixTrim]) prefixTrim++;
      while (suffixTrim < oldPart.length - prefixTrim && suffixTrim < newPart.length - prefixTrim && oldPart[oldPart.length - 1 - suffixTrim] === newPart[newPart.length - 1 - suffixTrim]) suffixTrim++;
      start += prefixTrim;
      suffix += suffixTrim;
    }
  }
  const end = old.length - suffix, inserted = normalized.slice(start, normalized.length - suffix), paragraphs = parseBody(html);
  const flat = [];
  paragraphs.forEach((p, index) => {
    p.atoms.forEach((atom) => flat.push({ ...atom, paragraphId: p.id, paragraphType: p.type }));
    if (index < paragraphs.length - 1) flat.push({ text: "\n", paragraphBreak: true, paragraphId: p.id, paragraphType: p.type, nextParagraphId: paragraphs[index + 1].id, nextParagraphType: paragraphs[index + 1].type });
  });
  let at = 0;
  const sliced = [];
  for (const atom of flat) {
    const from = at, to = at + atom.text.length; at = to;
    if (from < start) sliced.push({ ...atom, text: atom.text.slice(0, Math.min(start, to) - from) });
    if (to > end) sliced.push({ ...atom, text: atom.text.slice(Math.max(end, from) - from), _after: true });
  }
  let position = 0;
  const located = flat.map((atom) => { const from = position; position += atom.text.length; return { atom, from, to: position }; });
  let owner = located.find((range) => range.from <= start && range.to > start)?.atom;
  if (start === end && boundarySide === "previous") owner = located.findLast((range) => range.from < start && range.to >= start && !range.atom.paragraphBreak)?.atom || owner;
  const metadata = owner ? { ...owner } : { paragraphId: paragraphs[0].id };
  delete metadata.reading; delete metadata.origin; delete metadata.rubyId; delete metadata.paragraphBreak;
  if (Object.hasOwn(options, "sourceImageId")) {
    if (options.sourceImageId) metadata.sourceImageId = options.sourceImageId;
    else delete metadata.sourceImageId;
  }
  const before = sliced.filter((atom) => !atom._after), after = sliced.filter((atom) => atom._after).map(({ _after, ...atom }) => atom);
  const additions = inserted.split("\n").flatMap((part, index) => [
    ...(index ? [{ ...metadata, text: "\n", paragraphBreak: true, nextParagraphId: randomUuid() }] : []),
    ...(part ? [{ ...metadata, text: part }] : []),
  ]);
  const sequence = [...before, ...additions, ...after];
  const first = sequence[0];
  const next = [{ id: first?.paragraphId || paragraphs[0].id, ...((first?.paragraphType || paragraphs[0].type) ? { type: first?.paragraphType || paragraphs[0].type } : {}), atoms: [] }];
  for (const atom of sequence) {
    if (atom.paragraphBreak) { next.push({ id: atom.nextParagraphId || randomUuid(), ...(atom.nextParagraphType ? { type: atom.nextParagraphType } : {}), atoms: [] }); continue; }
    const { paragraphId, paragraphType, nextParagraphId, nextParagraphType, ...clean } = atom;
    next.at(-1).atoms.push(clean);
  }
  const seen = new Set();
  next.forEach((p) => { if (seen.has(p.id)) p.id = randomUuid(); seen.add(p.id); });
  // Any edited ruby loses its reading as a whole; unchanged ruby remains intact.
  const beforeRuby = new Map();
  flat.forEach((atom) => { if (atom.rubyId) beforeRuby.set(atom.rubyId, (beforeRuby.get(atom.rubyId) || "") + atom.text); });
  const afterRuby = new Map();
  next.forEach((p) => p.atoms.forEach((atom) => { if (atom.rubyId) afterRuby.set(atom.rubyId, (afterRuby.get(atom.rubyId) || "") + atom.text); }));
  next.forEach((p) => p.atoms.forEach((atom) => { if (atom.rubyId && beforeRuby.get(atom.rubyId) !== afterRuby.get(atom.rubyId)) { delete atom.reading; delete atom.origin; delete atom.rubyId; } }));
  return renderBody(next);
}

export function syncBodyReadings(html, blocks) {
  const expected = blocks.map((b) => b.segments.map((s) => s.text).join("")).join("\n");
  if (bodyText(html) !== expected) throw error("读音与正文不一致，请重新校对。");
  const readings = []; let offset = 0;
  for (const block of blocks) {
    for (const segment of block.segments) {
      if (segment.reading) readings.push({ start: offset, end: offset + segment.text.length, reading: segment.reading, origin: segment.origin || "manual", rubyId: randomUuid() });
      offset += segment.text.length;
    }
    offset++;
  }
  let readingIndex = 0;
  return mapRanges(html, readings.flatMap((r) => [r.start, r.end]), (atom, start, end) => {
    const next = { ...atom }; delete next.reading; delete next.origin; delete next.rubyId;
    while (readingIndex < readings.length && start >= readings[readingIndex].end) readingIndex++;
    const candidate = readings[readingIndex];
    const reading = candidate && start >= candidate.start && end <= candidate.end ? candidate : null;
    return reading ? { ...next, reading: reading.reading, origin: reading.origin, rubyId: reading.rubyId } : next;
  });
}


// Append photos as one continuous article. Only an explicit user choice joins
// the first new sentence to the final existing sentence; no text is inferred.
export function appendBodyHtml(base, addition, { continueLastSentence = false } = {}) {
  const previous = parseBody(base), added = parseBody(addition);
  const known = new Set(previous.map((p) => p.id));
  added.forEach((p) => { if (known.has(p.id)) p.id = randomUuid(); known.add(p.id); });
  if (continueLastSentence && previous.length && added.length) {
    const last = previous.at(-1), first = added.shift();
    const endingId = last.atoms.findLast((atom) => atom.sentenceId)?.sentenceId;
    const firstId = first.atoms.find((atom) => atom.sentenceId)?.sentenceId;
    if (endingId && firstId) [first, ...added].forEach((p) => p.atoms.forEach((atom) => { if (atom.sentenceId === firstId) atom.sentenceId = endingId; }));
    last.atoms.push(...first.atoms);
  }
  return renderBody([...previous, ...added]);
}
