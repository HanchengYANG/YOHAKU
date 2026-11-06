// tests/reading-positions-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { ensureSession, sessionHeaders } from "./helpers/session.mjs";
import { applySentenceBoundaries, blocksToHtml } from "../shared/article-html.mjs";
import { parseText } from "../shared/document.mjs";

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-reading-positions-"));
  const application = createApp({ dataDir });
  const server = application.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${server.address().port}`;
  const { user } = await ensureSession(url);
  t.after(async () => {
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await stopped;
    application.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  async function request(path, method = "GET", body) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: { ...sessionHeaders(url), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    const json = response.headers.get("content-type")?.includes("application/json");
    return { status: response.status, data: response.status === 204 ? null : json ? await response.json() : await response.text() };
  }
  function savedRows(documentId) {
    const database = new DatabaseSync(join(dataDir, "yohaku.sqlite"), { readOnly: true });
    try { return database.prepare("SELECT COUNT(*) AS n FROM reading_positions WHERE document_id=?").get(documentId).n; }
    finally { database.close(); }
  }
  return { application, user, request, savedRows };
}

const article = (title, extra = {}) => ({ title, kind: "article", orientation: "horizontal", content: "{日本語|にほんご}を読む。", ...extra });

test("翻页心跳写入进度，文章与书籍摘要带出页码、页数和最近打开时间", async (t) => {
  const f = await fixture(t);
  const book = (await f.request("/api/books", "POST", { title: "进度书" })).data;
  const created = await f.request("/api/documents", "POST", article("分页文章", { kind: "book", bookId: book.id }));
  assert.equal(created.status, 201);
  const id = created.data.id;
  const text = ["甲", "乙", "丙"].map((char) => (char.repeat(99) + "。").repeat(10)).join("");
  const bodyHtml = applySentenceBoundaries(blocksToHtml(parseText(text)), text.match(/[^。]*。/gu));
  f.application.sources.createArticleSources(f.user.id, id, [{ id: "pages-source", type: "text", bodyHtml, status: "ready", needsCorrection: false }]);
  const before = new Date().toISOString();
  const beat = await f.request(`/api/documents/${id}/reading-session`, "POST", { sessionId: "progress-session", sequence: 1, index: 1 });
  assert.equal(beat.status, 200);
  assert.equal(beat.data.index, 1);

  const listed = (await f.request("/api/documents?all=1")).data.documents.find((item) => item.id === id);
  assert.equal(listed.readingPosition.pageIndex, 1);
  assert.equal(listed.readingPosition.pageCount, beat.data.pages.length);
  assert.ok(listed.readingPosition.pageCount >= 2);
  assert.ok(listed.readingPosition.updatedAt >= before);

  const detail = (await f.request(`/api/books/${book.id}`)).data;
  assert.deepEqual(detail.pages[0].readingPosition, listed.readingPosition);
  assert.equal(detail.lastOpenedAt, listed.readingPosition.updatedAt);
  const shelf = (await f.request("/api/books")).data.books.find((item) => item.id === book.id);
  assert.equal(shelf.lastOpenedAt, listed.readingPosition.updatedAt);

  const reopened = (await f.request(`/api/documents/${id}`)).data;
  assert.equal(reopened.reading.index, 1, "打开文章时从记录的页开始");
});

test("未分页文章用 PUT 记录打开，参数无效时拒绝", async (t) => {
  const f = await fixture(t);
  const { id } = (await f.request("/api/documents", "POST", article("单页文章"))).data;
  assert.equal((await f.request("/api/documents")).data.documents.find((item) => item.id === id).readingPosition, null);
  const saved = await f.request(`/api/documents/${id}/reading-position`, "PUT", { pageIndex: 0 });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.pageIndex, 0);
  assert.match(saved.data.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
  const listed = (await f.request("/api/documents")).data.documents.find((item) => item.id === id);
  assert.deepEqual(listed.readingPosition, { pageIndex: 0, pageCount: 0, updatedAt: saved.data.updatedAt });
  for (const pageIndex of [-1, 1.5, "2", undefined])
    assert.equal((await f.request(`/api/documents/${id}/reading-position`, "PUT", { pageIndex })).status, 400, String(pageIndex));
  assert.equal((await f.request("/api/documents/missing/reading-position", "PUT", { pageIndex: 0 })).status, 404);
});

test("删除文章或书籍时一并删除阅读进度", async (t) => {
  const f = await fixture(t);
  const single = (await f.request("/api/documents", "POST", article("待删文章"))).data;
  assert.equal((await f.request(`/api/documents/${single.id}/reading-position`, "PUT", { pageIndex: 0 })).status, 200);
  assert.equal(f.savedRows(single.id), 1);
  assert.equal((await f.request(`/api/documents/${single.id}`, "DELETE", { revision: single.revision })).status, 204);
  assert.equal(f.savedRows(single.id), 0);

  const book = (await f.request("/api/books", "POST", { title: "待删书" })).data;
  const page = (await f.request("/api/documents", "POST", article("书中文章", { kind: "book", bookId: book.id }))).data;
  assert.equal((await f.request(`/api/documents/${page.id}/reading-position`, "PUT", { pageIndex: 0 })).status, 200);
  assert.equal(f.savedRows(page.id), 1);
  const current = (await f.request(`/api/books/${book.id}`)).data;
  assert.equal((await f.request(`/api/books/${book.id}`, "DELETE", { revision: current.revision })).status, 204);
  assert.equal(f.savedRows(page.id), 0);
});
