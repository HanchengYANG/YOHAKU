// client/library-model.mjs
// Pure helpers for the home page and the book page. Inputs are the summaries
// from /api/documents, /api/books and /api/books/:id; readingPosition is
// { pageIndex, pageCount, updatedAt } (see server/reading-positions.mjs).
import { taskAttention } from "../shared/task-attention.mjs";

// ISO timestamps sort correctly as strings.
const newestFirst = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
const openedAt = (item) => item?.readingPosition?.updatedAt || null;
const characters = (count) => `${(count || 0).toLocaleString("zh-CN")} 字`;

// Articles outside the source workflow have no reading pages (pageCount 0).
export function pageProgress(position) {
  if (!position || !(position.pageCount > 0)) return null;
  // While the article is still being prepared, pageCount only counts the pages
  // ready so far; a fraction would claim the end too early.
  if (position.pagesFinal === false)
    return { page: position.pageIndex + 1, total: null, label: `第 ${position.pageIndex + 1} 页`, percent: null };
  const page = Math.min(position.pageIndex + 1, position.pageCount);
  return { page, total: position.pageCount, label: `第 ${page} / ${position.pageCount} 页`,
    percent: Math.round((page / position.pageCount) * 100) };
}

// The most recently opened article; the newest one when nothing was read yet.
export function continueReading(documents = [], books = []) {
  const opened = documents.filter(openedAt).sort((a, b) => newestFirst(openedAt(a), openedAt(b)));
  const document = opened[0] || [...documents].sort((a, b) => newestFirst(a.createdAt, b.createdAt))[0];
  if (!document) return null;
  const resumed = opened.length > 0;
  return {
    document,
    book: document.bookId ? books.find((book) => book.id === document.bookId) || null : null,
    resumed,
    progress: resumed ? pageProgress(document.readingPosition) : null,
  };
}

// Books and standalone articles by last opened; never opened ones follow by update time.
export function recentEntries(books = [], documents = [], limit = 6) {
  return [
    ...books.map((item) => ({ ...item, entryType: "book", openedAt: item.lastOpenedAt || null })),
    ...documents.map((item) => ({ ...item, entryType: "document", openedAt: openedAt(item) })),
  ]
    .sort((a, b) => Number(!a.openedAt) - Number(!b.openedAt)
      || newestFirst(a.openedAt, b.openedAt)
      || newestFirst(a.updatedAt, b.updatedAt))
    .slice(0, limit);
}

export function bookFacts(book) {
  const pages = book.pages || [];
  const count = book.pages ? pages.length : book.pageCount || 0;
  const total = book.charCount ?? pages.reduce((sum, page) => sum + (page.charCount || 0), 0);
  return `${count} 篇 · ${characters(total)}`;
}

export function bookResume(book) {
  const pages = book.pages || [];
  const opened = pages.filter(openedAt).sort((a, b) => newestFirst(openedAt(a), openedAt(b)))[0];
  if (opened) return { page: opened, label: `继续阅读 · ${opened.title}`, resumed: true };
  return pages[0] ? { page: pages[0], label: "开始阅读", resumed: false } : null;
}

// documentId -> "attention" | "working"; a task that needs the reader wins.
export function documentTaskStates(tasks = []) {
  const states = new Map();
  for (const task of tasks || []) {
    const state = taskAttention(task);
    if (!state || !task.documentId) continue;
    if (state === "attention" || !states.has(task.documentId)) states.set(task.documentId, state);
  }
  return states;
}

export function articleRowState(page, taskState = null) {
  if (taskState === "attention") return { kind: "attention", label: "需要处理" };
  if (taskState === "working") return { kind: "working", label: "准备中" };
  const progress = pageProgress(page.readingPosition);
  if (progress) return { kind: "position", label: `读到第 ${progress.page} 页` };
  return { kind: "length", label: characters(page.charCount) };
}
