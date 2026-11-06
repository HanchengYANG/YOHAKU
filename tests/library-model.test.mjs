// tests/library-model.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import {
  articleRowState, bookFacts, bookResume, continueReading, documentTaskStates, pageProgress, recentEntries,
} from "../client/library-model.mjs";

const at = (minute) => `2026-11-06T09:${String(minute).padStart(2, "0")}:00.000Z`;
const position = (pageIndex, pageCount, minute) => ({ pageIndex, pageCount, updatedAt: at(minute) });

test("阅读页进度：第 N / M 页，未分页的文章没有进度", () => {
  assert.deepEqual(pageProgress(position(2, 5, 0)), { page: 3, total: 5, label: "第 3 / 5 页", percent: 60 });
  assert.deepEqual(pageProgress(position(9, 5, 0)), { page: 5, total: 5, label: "第 5 / 5 页", percent: 100 });
  assert.equal(pageProgress(position(0, 0, 0)), null);
  assert.equal(pageProgress(null), null);
});

test("继续阅读取最近打开的文章，从未读过时取最近添加的一篇", () => {
  const books = [{ id: "b", title: "书" }];
  const documents = [
    { id: "old", title: "旧文", createdAt: at(1), readingPosition: position(0, 3, 5) },
    { id: "new", title: "新文", bookId: "b", createdAt: at(2), readingPosition: position(1, 4, 9) },
    { id: "fresh", title: "刚加", createdAt: at(30), readingPosition: null },
  ];
  const current = continueReading(documents, books);
  assert.equal(current.document.id, "new");
  assert.equal(current.book.title, "书");
  assert.equal(current.resumed, true);
  assert.equal(current.progress.label, "第 2 / 4 页");
  const unread = continueReading(documents.map((item) => ({ ...item, readingPosition: null })), books);
  assert.equal(unread.document.id, "fresh");
  assert.equal(unread.resumed, false);
  assert.equal(unread.progress, null);
  assert.equal(continueReading([], books), null);
});

test("最近阅读按最近打开排序，没打开过的按更新时间排在后面", () => {
  const books = [
    { id: "b1", title: "读过的书", lastOpenedAt: at(20), updatedAt: at(1) },
    { id: "b2", title: "没读的书", lastOpenedAt: null, updatedAt: at(40) },
  ];
  const documents = [
    { id: "d1", title: "读过的文", readingPosition: position(0, 1, 30), updatedAt: at(2) },
    { id: "d2", title: "没读的文", readingPosition: null, updatedAt: at(10) },
  ];
  assert.deepEqual(recentEntries(books, documents).map((item) => `${item.entryType}:${item.id}`),
    ["document:d1", "book:b1", "book:b2", "document:d2"]);
  assert.equal(recentEntries(books, documents, 2).length, 2);
});

test("书籍概况与主按钮", () => {
  const book = { title: "书", charCount: 12345, pages: [
    { id: "p1", title: "第一篇", charCount: 10, readingPosition: position(0, 2, 3) },
    { id: "p2", title: "第二篇", charCount: 20, readingPosition: position(1, 3, 8) },
    { id: "p3", title: "第三篇", charCount: 30, readingPosition: null },
  ] };
  assert.equal(bookFacts(book), "3 篇 · 12,345 字");
  assert.equal(bookFacts({ pages: [{ charCount: 1 }, { charCount: 2 }] }), "2 篇 · 3 字");
  assert.deepEqual(bookResume(book), { page: book.pages[1], label: "继续阅读 · 第二篇", resumed: true });
  const unread = { pages: book.pages.map((page) => ({ ...page, readingPosition: null })) };
  assert.deepEqual(bookResume(unread), { page: unread.pages[0], label: "开始阅读", resumed: false });
  assert.equal(bookResume({ pages: [] }), null);
});

test("文章行只显示一种状态：需要处理 > 准备中 > 读到第 N 页 > 字数", () => {
  const states = documentTaskStates([
    { id: "t1", documentId: "a", status: "running" },
    { id: "t2", documentId: "a", status: "failed" },
    { id: "t3", documentId: "b", status: "queued" },
    { id: "t4", documentId: "c", status: "completed", archived: true },
    { id: "t5", status: "draft" },
  ]);
  assert.deepEqual(Object.fromEntries(states), { a: "attention", b: "working" });
  const page = { charCount: 1234, readingPosition: position(2, 5, 1) };
  assert.deepEqual(articleRowState(page, "attention"), { kind: "attention", label: "需要处理" });
  assert.deepEqual(articleRowState(page, "working"), { kind: "working", label: "准备中" });
  assert.deepEqual(articleRowState(page), { kind: "position", label: "读到第 3 页" });
  assert.deepEqual(articleRowState({ charCount: 1234, readingPosition: position(0, 0, 1) }), { kind: "length", label: "1,234 字" });
  assert.deepEqual(articleRowState({ charCount: 1234, readingPosition: null }), { kind: "length", label: "1,234 字" });
});
