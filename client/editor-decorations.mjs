import { bodyRanges, bodyText, markBodyRange, removeQaMarks } from "../shared/article-html.mjs";

// A saved marker can be projected without ambiguity only when the text is
// identical. Older snapshots already carry their own precise edit mapping;
// preserve those associations instead of guessing which repeated word survived.
export function reconcileEditorQaMarks(html, savedHtml, { newIds = [], deletedIds = [] } = {}) {
  let next = removeQaMarks(html, deletedIds);
  if (!newIds.length || bodyText(next) !== bodyText(savedHtml)) return next;
  const added = new Set(newIds);
  for (const range of bodyRanges(savedHtml).qa.filter((range) => added.has(range.id)))
    next = markBodyRange(next, range.start, range.end, range.id);
  return next;
}

// All offsets use the same UTF-16 positions as the native textarea.
export function editorDecorations(text, ranges) {
  const events = new Map();
  const eventAt = (at) => {
    if (!events.has(at)) events.set(at, []);
    return events.get(at);
  };
  eventAt(0); eventAt(text.length);
  for (const key of ["sentences", "qa", "sources"]) {
    for (const range of ranges[key] || []) {
      const start = Math.max(0, Math.min(text.length, range.start));
      const end = Math.max(start, Math.min(text.length, range.end));
      if (end === start) continue;
      eventAt(start).push({ key, id: range.id, delta: 1 });
      eventAt(end).push({ key, id: range.id, delta: -1 });
    }
  }
  const points = [...events.keys()].sort((a, b) => a - b);
  const active = { sentences: new Map(), qa: new Map(), sources: new Map() };
  return points.slice(0, -1).map((start, index) => {
    for (const { key, id, delta } of events.get(start)) {
      const count = (active[key].get(id) || 0) + delta;
      if (count > 0) active[key].set(id, count);
      else active[key].delete(id);
    }
    const end = points[index + 1];
    return { start, end, text: text.slice(start, end),
      sentenceIds: [...active.sentences.keys()], groupIds: [...active.qa.keys()], sourceIds: [...active.sources.keys()] };
  });
}
