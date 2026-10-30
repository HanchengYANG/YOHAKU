import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { ensureSession, sessionHeaders } from "./helpers/session.mjs";
import { serializeBlocks } from "../shared/document.mjs";
import { editBodyText, bodyText, bodyRanges, markBodyRange, applySentenceBoundaries } from "../shared/article-html.mjs";
import { createHash } from "node:crypto";

const input = (title, content = "{日本語|にほんご}を読む。") => ({ title, content, kind: "book", orientation: "horizontal" });

async function fixture(t, beforeStart) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-books-"));
  const databasePath = join(dataDir, "yohaku.sqlite");
  if (beforeStart) {
    const database = new DatabaseSync(databasePath);
    try { beforeStart(database); } finally { database.close(); }
  }
  let server, application, url, user;
  async function start() {
    application = createApp({ dataDir });
    server = application.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
    ({ user } = await ensureSession(url));
  }
  async function stop() {
    if (!server) return;
    const stopped = new Promise((resolve) => server.close(resolve));
    server.closeAllConnections();
    await stopped;
    application.close();
    server = null;
  }
  await start();
  t.after(async () => { await stop(); await rm(dataDir, { recursive: true, force: true }); });
  async function request(path, method = "GET", body, cookie) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(cookie === undefined ? sessionHeaders(url) : cookie ? { Cookie: cookie } : {}),
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(10000),
    });
    return { status: response.status,
      data: response.status === 204 ? null : response.headers.get("content-type")?.includes("application/json") ? await response.json() : await response.text(),
      cookie: response.headers.get("set-cookie")?.split(";", 1)[0] };
  }
  function inspect(work) {
    const database = new DatabaseSync(databasePath);
    try { return work(database); } finally { database.close(); }
  }
  async function imagePage(title, text, bookId) {
    const buffer = await sharp({ create: { width: 20, height: 30, channels: 3, background: "white" } }).png().toBuffer();
    const form = new FormData();
    form.append("image", new Blob([buffer], { type: "image/png" }), `${title}.png`);
    const uploaded = await fetch(`${url}/api/images`, { method: "POST", headers: sessionHeaders(url), body: form });
    assert.equal(uploaded.status, 201);
    const image = await uploaded.json();
    const blocks = [{ id: `${title}-block`, type: "paragraph", sourcePage: "single", confidence: "high",
      segments: [{ text, reading: "にほんご", origin: "source" }] }];
    const recognition = { title, kind: "book", orientation: "horizontal", blocks,
      content: serializeBlocks(blocks), sourceImageId: image.id, sourceImage: image,
      readingPolicy: "legacy-fixture", warnings: [], nonBody: [] };
    inspect((database) => database.prepare("INSERT INTO image_drafts(image_id,user_id,draft_json) VALUES(?,?,?)")
      .run(image.id, user.id, JSON.stringify(recognition)));
    const created = await request("/api/documents", "POST", {
      ...input(title, recognition.content), sourceImageId: image.id, ...(bookId ? { bookId } : {}),
    });
    assert.equal(created.status, 201);
    return { page: created.data, image, recognition };
  }
  return { request, inspect, imagePage, get user() { return user; },
    restart: async () => { await stop(); await start(); } };
}

test("多页书籍保留每页原图、识别与注音，既有材料原地归书且讨论经重启保持", async (t) => {
  const f = await fixture(t);
  const first = await f.imagePage("第一页", "日本語");
  const conversation = { id: "preserved-chat", document_id: first.page.id, account_id: "fixture-account", thread_id: "fixture-thread",
    quote: "日本語", document_revision: first.page.revision,
    messages_json: JSON.stringify([{ role: "user", content: "解释这个词" }]), last_error: null,
    created_at: first.page.createdAt, updated_at: first.page.updatedAt, user_id: f.user.id, provider_id: "openai" };
  f.inspect((database) => database.prepare(`INSERT INTO conversations
    (id,document_id,account_id,thread_id,quote,document_revision,messages_json,last_error,created_at,updated_at,user_id,provider_id)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(...Object.values(conversation)));
  const promoted = await f.request("/api/books", "POST", { title: "一本书", documentId: first.page.id });
  assert.equal(promoted.status, 201);
  assert.equal(promoted.data.pageCount, 1);
  assert.equal(promoted.data.revision, 1);
  const bookId = promoted.data.id;
  const member = (await f.request(`/api/documents/${first.page.id}`)).data;
  assert.deepEqual(member, { ...first.page, bookId, position: 1 });
  assert.deepEqual((await f.request("/api/documents")).data.documents, []);
  const second = await f.imagePage("第二页", "読書", bookId);
  assert.equal(second.page.bookId, bookId);
  assert.equal(second.page.position, 2);
  const book = (await f.request(`/api/books/${bookId}`)).data;
  assert.equal(book.revision, 2);
  assert.equal(book.pageCount, 2);
  assert.equal(book.charCount, 5);
  assert.equal(book.rubyCount, 2);
  assert.deepEqual(book.pages.map((page) => [page.id, page.position, page.sourceImageId]), [
    [first.page.id, 1, first.image.id], [second.page.id, 2, second.image.id],
  ]);
  await f.restart();
  assert.deepEqual((await f.request(`/api/books/${bookId}`)).data, book);
  for (const expected of [member, second.page]) assert.deepEqual((await f.request(`/api/documents/${expected.id}`)).data, expected);
  assert.deepEqual(f.inspect((database) => ({ ...database.prepare("SELECT * FROM conversations WHERE id=?").get(conversation.id) })), conversation);
  const exported = await f.request(`/api/documents/${second.page.id}/export?format=json`);
  assert.deepEqual(exported.data.document.recognition, second.recognition);
  assert.deepEqual(exported.data.document.blocks[0].segments, second.page.blocks[0].segments);
});

test("编辑既有独立材料可原地追加到指定书籍，过期版本及越权归书不产生副作用", async (t) => {
  const f = await fixture(t);
  const first = await f.imagePage("已校对的独立材料", "日本語");
  const book = (await f.request("/api/books", "POST", { title: "指定书籍" })).data;
  const otherBook = (await f.request("/api/books", "POST", { title: "另一本书" })).data;
  const initialPage = (await f.request("/api/documents", "POST", { ...input("原有第一页"), bookId: book.id })).data;
  f.inspect((database) => database.prepare(`INSERT INTO conversations
    (id,document_id,account_id,quote,document_revision,messages_json,created_at,updated_at,user_id)
    VALUES(?,?,?,?,?,?,?,?,?)`).run("attach-chat", first.page.id, "fixture-account", "日本語", 1,
      '[{"role":"user","content":"保留讨论"}]', first.page.createdAt, first.page.updatedAt, f.user.id));
  const updated = await f.request(`/api/documents/${first.page.id}`, "PUT", { ...first.page, title: "校对后标题", bookId: null });
  assert.equal(updated.status, 200);
  assert.equal(Object.hasOwn(updated.data, "bookId"), false);
  const beforeAttach = (await f.request(`/api/books/${book.id}`)).data;
  assert.equal((await f.request(`/api/documents/${first.page.id}`, "PUT", { ...first.page, bookId: book.id })).status, 409);
  assert.equal((await f.request(`/api/documents/${first.page.id}`, "PUT", { ...updated.data, bookId: "missing-book" })).status, 404);
  const invite = await f.request("/api/invitations", "POST");
  const friend = await f.request("/api/accounts/register", "POST", {
    username: "attach_friend", password: "fixture-friend-password", inviteToken: invite.data.token,
  }, null);
  const friendBook = (await f.request("/api/books", "POST", { title: "朋友的书" }, friend.cookie)).data;
  assert.equal((await f.request(`/api/documents/${first.page.id}`, "PUT", { ...updated.data, bookId: friendBook.id })).status, 404);
  assert.deepEqual((await f.request(`/api/documents/${first.page.id}`)).data, updated.data);
  assert.deepEqual((await f.request(`/api/books/${book.id}`)).data, beforeAttach);
  const attached = await f.request(`/api/documents/${first.page.id}`, "PUT", { ...updated.data, bookId: book.id });
  assert.equal(attached.status, 200);
  assert.deepEqual(attached.data, { ...updated.data, bookId: book.id, position: 2,
    revision: updated.data.revision + 1, updatedAt: attached.data.updatedAt });
  assert.equal(attached.data.sourceImageId, first.image.id);
  assert.deepEqual(attached.data.recognition, first.recognition);
  const afterAttach = (await f.request(`/api/books/${book.id}`)).data;
  assert.equal(afterAttach.revision, beforeAttach.revision + 1);
  assert.deepEqual(afterAttach.pages.map((page) => page.id), [initialPage.id, first.page.id]);
  assert.deepEqual((await f.request("/api/documents")).data.documents, []);
  assert.equal(f.inspect((database) => database.prepare("SELECT count(*) AS n FROM conversations WHERE id=? AND document_id=?")
    .get("attach-chat", first.page.id).n), 1);
  for (const bookId of [null, otherBook.id]) {
    assert.equal((await f.request(`/api/documents/${first.page.id}`, "PUT", { ...attached.data, bookId })).status, 409);
    assert.deepEqual((await f.request(`/api/documents/${first.page.id}`)).data, attached.data);
    assert.deepEqual((await f.request(`/api/books/${book.id}`)).data, afterAttach);
  }
  const withoutBookId = { ...attached.data };
  delete withoutBookId.bookId;
  const kept = await f.request(`/api/documents/${first.page.id}`, "PUT", withoutBookId);
  assert.equal(kept.status, 200);
  assert.equal(kept.data.bookId, book.id);
  assert.equal(kept.data.position, 2);
});

test("书籍支持空书、追加、全文搜索、完整重排与单页删除；页面编辑让旧书版本失效", async (t) => {
  const f = await fixture(t);
  const created = await f.request("/api/books", "POST", { title: "顺序与搜索" });
  assert.equal(created.status, 201);
  assert.deepEqual(created.data.pages, []);
  assert.equal(created.data.pageCount, 0);
  const bookId = created.data.id;
  const standalone = (await f.request("/api/documents", "POST", input("独立材料", "不会混入书籍"))).data;
  const appended = await Promise.all(["第一页", "第二页", "第三页"].map((title, index) =>
    f.request("/api/documents", "POST", { ...input(title, index === 1 ? "特殊检索%_!" : "正文"), bookId })));
  assert.ok(appended.every((result) => result.status === 201));
  let book = (await f.request(`/api/books/${bookId}`)).data;
  assert.equal(book.revision, 4);
  assert.deepEqual(book.pages.map((page) => page.position), [1, 2, 3]);
  assert.deepEqual((await f.request("/api/documents")).data.documents.map((page) => page.id), [standalone.id]);
  for (const query of ["顺序", "第二页", "特殊检索%_!"])
    assert.deepEqual((await f.request(`/api/books?q=${encodeURIComponent(query)}`)).data.books.map((item) => item.id), [bookId]);
  assert.deepEqual((await f.request("/api/books?q=不存在")).data.books, []);
  const originalIds = book.pages.map((page) => page.id);
  for (const pageIds of [originalIds.slice(1), [originalIds[0], originalIds[0], originalIds[2]], [...originalIds.slice(0, 2), standalone.id]]) {
    assert.equal((await f.request(`/api/books/${bookId}`, "PUT", { title: "不应写入", revision: book.revision, pageIds })).status, 400);
    assert.deepEqual((await f.request(`/api/books/${bookId}`)).data, book);
  }
  const reverse = [...originalIds].reverse();
  const reordered = await f.request(`/api/books/${bookId}`, "PUT", { title: "已重排", revision: book.revision, pageIds: reverse });
  assert.equal(reordered.status, 200);
  assert.deepEqual(reordered.data.pages.map((page) => page.id), reverse);
  assert.deepEqual(reordered.data.pages.map((page) => page.position), [1, 2, 3]);
  assert.equal((await f.request(`/api/books/${bookId}`, "PUT", { title: "过期", revision: book.revision })).status, 409);
  book = reordered.data;
  const page = (await f.request(`/api/documents/${reverse[0]}`)).data;
  const edited = await f.request(`/api/documents/${page.id}`, "PUT", { ...page, title: "新页面标题", content: "新检索正文", bodyHtml: editBodyText(page.bodyHtml, "新检索正文") });
  assert.equal(edited.status, 200);
  assert.equal(edited.data.bookId, bookId);
  assert.equal(edited.data.position, 1);
  assert.equal((await f.request(`/api/books/${bookId}`, "DELETE", { revision: book.revision })).status, 409);
  assert.equal((await f.request(`/api/books/${bookId}`, "PUT", { title: book.title, revision: book.revision, pageIds: reverse })).status, 409);
  assert.deepEqual((await f.request("/api/books?q=新检索正文")).data.books.map((item) => item.id), [bookId]);
  assert.equal((await f.request(`/api/documents/${page.id}`, "DELETE", { revision: page.revision })).status, 409);
  assert.equal((await f.request(`/api/documents/${page.id}`, "DELETE", { revision: edited.data.revision })).status, 204);
  book = (await f.request(`/api/books/${bookId}`)).data;
  assert.equal(book.revision, 7);
  assert.deepEqual(book.pages.map((item) => [item.id, item.position]), [[reverse[1], 1], [reverse[2], 2]]);
  assert.equal((await f.request("/api/documents", "POST", { ...input("补充页"), bookId })).data.position, 3);
  book = (await f.request(`/api/books/${bookId}`)).data;
  assert.equal((await f.request(`/api/books/${bookId}`, "DELETE", { revision: book.revision })).status, 204);
  assert.equal((await f.request(`/api/books/${bookId}`)).status, 404);
  for (const id of originalIds) assert.equal((await f.request(`/api/documents/${id}`)).status, 404);
  assert.equal((await f.request(`/api/documents/${standalone.id}`)).status, 200);
  assert.equal((await f.request("/api/books")).data.books.length, 0);
});

test("书籍与页面按账号隔离，非法归书或转换失败不留下任何材料或书籍", async (t) => {
  const f = await fixture(t);
  const book = (await f.request("/api/books", "POST", { title: "本人书籍" })).data;
  const page = (await f.request("/api/documents", "POST", { ...input("本人页面"), bookId: book.id })).data;
  const standalone = (await f.request("/api/documents", "POST", input("本人独立资料"))).data;
  const invite = await f.request("/api/invitations", "POST");
  const friend = await f.request("/api/accounts/register", "POST", {
    username: "book_friend", password: "fixture-friend-password", inviteToken: invite.data.token,
  }, null);
  assert.equal(friend.status, 201);
  const cookie = friend.cookie;
  for (const method of ["GET", "PUT", "DELETE"])
    assert.equal((await f.request(`/api/books/${book.id}`, method, method === "GET" ? undefined : { title: "别人的书", revision: 2 }, cookie)).status, 404);
  assert.deepEqual((await f.request("/api/books?q=本人", "GET", undefined, cookie)).data.books, []);
  assert.equal((await f.request(`/api/documents/${page.id}`, "GET", undefined, cookie)).status, 404);
  assert.equal((await f.request("/api/documents", "POST", { ...input("越权页面"), bookId: book.id, sourceImageId: "invalid-image" }, cookie)).status, 404);
  assert.equal((await f.request("/api/books", "POST", { title: "越权转换", documentId: standalone.id }, cookie)).status, 404);
  assert.equal((await f.request("/api/books", "POST", { title: "重复归书", documentId: page.id })).status, 409);
  assert.equal((await f.request("/api/books", "POST", { title: "缺失材料", documentId: "missing" })).status, 404);
  assert.deepEqual(f.inspect((database) => ({
    books: database.prepare("SELECT count(*) AS n FROM books").get().n,
    documents: database.prepare("SELECT count(*) AS n FROM documents").get().n,
  })), { books: 1, documents: 2 });
  assert.equal((await f.request(`/api/books/${book.id}`, "GET", undefined, null)).status, 401);
});

test("旧数据库只增加归书字段，原独立材料不改写；迁移和重启可重复执行", async (t) => {
  const blocks = [{ id: "legacy-block", segments: [{ text: "原文", reading: "げんぶん", origin: "manual" }] }];
  const f = await fixture(t, (database) => {
    database.exec(`CREATE TABLE documents (
      id TEXT PRIMARY KEY,title TEXT NOT NULL,kind TEXT NOT NULL,orientation TEXT NOT NULL,
      blocks_json TEXT NOT NULL,plain_text TEXT NOT NULL,revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,updated_at TEXT NOT NULL
    )`);
    database.prepare("INSERT INTO documents VALUES(?,?,?,?,?,?,?,?,?)")
      .run("legacy-document", "旧独立材料", "book", "vertical", JSON.stringify(blocks), "原文", 4,
        "2026-10-28T10:00:00.000Z", "2026-10-28T11:00:00.000Z");
  });
  const document = (await f.request("/api/documents/legacy-document")).data;
  assert.equal(Object.hasOwn(document, "bookId"), false);
  assert.equal(Object.hasOwn(document, "position"), false);
  assert.equal(document.revision, 4);
  assert.deepEqual(document.blocks, blocks);
  assert.equal((await f.request("/api/documents")).data.documents.length, 1);
  assert.deepEqual((await f.request("/api/books")).data.books, []);
  await f.restart();
  await f.restart();
  assert.deepEqual((await f.request("/api/documents/legacy-document")).data, document);
  const row = f.inspect((database) => ({ ...database.prepare("SELECT * FROM documents WHERE id=?").get(document.id) }));
  assert.equal(row.book_id, null);
  assert.equal(row.page_position, null);
  assert.equal(row.blocks_json, JSON.stringify(blocks));
});

test("书籍标题、版本与页面顺序输入有明确校验，删完页面保留空书", async (t) => {
  const f = await fixture(t);
  for (const title of [null, "", "  ", "书".repeat(161)])
    assert.equal((await f.request("/api/books", "POST", { title })).status, 400);
  assert.equal((await f.request("/api/books", "POST", { title: "书", documentId: null })).status, 400);
  const book = (await f.request("/api/books", "POST", { title: " 空书 " })).data;
  assert.equal(book.title, "空书");
  const standalone = await f.request("/api/documents", "POST", { ...input("独立材料"), bookId: null });
  assert.equal(standalone.status, 201);
  assert.equal(Object.hasOwn(standalone.data, "bookId"), false);
  assert.equal(Object.hasOwn(standalone.data, "position"), false);
  for (const bookId of ["", false, {}, 1])
    assert.equal((await f.request("/api/documents", "POST", { ...input("无效归书"), bookId })).status, 400);
  for (const revision of [undefined, 0, -1, 1.5, "1"])
    assert.equal((await f.request(`/api/books/${book.id}`, "DELETE", { revision })).status, 400);
  assert.equal((await f.request(`/api/books/${book.id}`, "PUT", { title: "书", revision: 1, pageIds: {} })).status, 400);
  assert.equal((await f.request(`/api/books?q=${"a".repeat(201)}`)).status, 400);
  const page = (await f.request("/api/documents", "POST", { ...input("唯一一页"), bookId: book.id })).data;
  assert.equal((await f.request(`/api/documents/${page.id}`, "DELETE", { revision: page.revision })).status, 204);
  const empty = (await f.request(`/api/books/${book.id}`)).data;
  assert.equal(empty.pageCount, 0);
  assert.deepEqual(empty.pages, []);
  assert.equal(empty.revision, 3);
});


test("同篇文章可追加多图，来源、识别、句子和问答标记保存重启导出不丢，书籍计数按文章", async (t) => {
  const f = await fixture(t);
  const first = await f.imagePage("本文", "日本語");
  const second = await f.imagePage("続き", "読書");
  const promoted = await f.request("/api/books", "POST", { title: "文章集", documentId: first.page.id });
  let article = (await f.request(`/api/documents/${first.page.id}`)).data;
  const html = applySentenceBoundaries(article.bodyHtml + second.page.bodyHtml, ["日本語\n", "読書"]);
  f.inspect((database) => database.prepare("INSERT INTO qa_groups VALUES(?,?,?,?,?,?)")
    .run("qa-current", f.user.id, article.id, "conversation-current", JSON.stringify({ quote: "語\n読" }), article.updatedAt));
  const bodyHtml = markBodyRange(html, 2, 5, "qa-current");
  const saved = await f.request(`/api/documents/${article.id}`, "PUT", {
    title: article.title, kind: article.kind, orientation: "horizontal", revision: article.revision,
    bodyHtml, sourceImages: [{ id: first.image.id }, { id: second.image.id }],
  });
  assert.equal(saved.status, 200);
  article = saved.data;
  assert.equal(article.id, first.page.id);
  assert.equal(article.content, "{日本語|にほんご}\n{読書|にほんご}");
  assert.deepEqual(article.sourceImages, [{ id: first.image.id, recognition: first.recognition }, { id: second.image.id, recognition: second.recognition }]);
  assert.equal(article.bodyHash, createHash("sha256").update("日本語\n読書").digest("hex"));
  assert.deepEqual(bodyRanges(article.bodyHtml).qa.map(({ text }) => text), ["語", "読"]);
  const book = (await f.request(`/api/books/${promoted.data.id}`)).data;
  assert.equal(book.articleCount, 1);
  assert.deepEqual(book.articles, book.pages);
  assert.equal(book.charCount, 5);
  assert.equal((await f.request(`/api/documents?all=1&q=${encodeURIComponent("読書")}`)).data.documents.length, 2);
  const exported = await f.request(`/api/documents/${article.id}/export?format=markdown`);
  assert.match(exported.data, /data-qa-group-ids="qa-current"/);
  assert.match(exported.data, new RegExp(`data-source-image-id="${second.image.id}"`));
  await f.restart();
  assert.deepEqual((await f.request(`/api/documents/${article.id}`)).data, article);
  const json = await f.request(`/api/documents/${article.id}/export?format=json`);
  assert.deepEqual(json.data.document, article);
  const erased = await f.request(`/api/documents/${article.id}`, "DELETE", { revision: article.revision });
  assert.equal(erased.status, 204);
  assert.equal(f.inspect((db) => db.prepare("SELECT count(*) AS n FROM qa_groups WHERE document_id=?").get(article.id).n), 0);
});

test("HTML保存拒绝文章外图片与问答组；伪造sourceImages识别记录不覆盖服务器快照", async (t) => {
  const f = await fixture(t);
  const first = await f.imagePage("第一篇", "日本語");
  const second = await f.imagePage("第二篇", "読書");
  const article = first.page;
  const save = (changes) => f.request(`/api/documents/${article.id}`, "PUT", { ...article, ...changes });
  assert.equal((await save({ bodyHtml: second.page.bodyHtml, content: second.page.content })).status, 400);
  f.inspect((database) => database.prepare("INSERT INTO qa_groups VALUES(?,?,?,?,?,?)")
    .run("qa-other-article", f.user.id, second.page.id, "conversation-other", "{}", article.updatedAt));
  assert.equal((await save({ bodyHtml: markBodyRange(article.bodyHtml, 0, 1, "qa-other-article") })).status, 400);
  assert.equal((await save({ bodyHtml: markBodyRange(article.bodyHtml, 0, 1, "qa-missing") })).status, 400);
  assert.deepEqual((await f.request(`/api/documents/${article.id}`)).data, article);
  const sourceSnapshot = await save({ sourceImages: [{ id: first.image.id, recognition: { title: "伪造记录" } }] });
  assert.equal(sourceSnapshot.status, 200);
  assert.deepEqual(sourceSnapshot.data.sourceImages[0].recognition, first.recognition);
  const invite = await f.request("/api/invitations", "POST");
  const friend = await f.request("/api/accounts/register", "POST", { username: "article_friend", password: "fixture-friend-password", inviteToken: invite.data.token });
  const other = await f.request("/api/documents", "POST", input("朋友文章", "朋友正文"), friend.cookie);
  assert.equal(other.status, 201);
  const foreign = await f.request(`/api/documents/${other.data.id}`, "PUT", { ...other.data, sourceImages: [{ id: first.image.id }], bodyHtml: article.bodyHtml, content: article.content }, friend.cookie);
  assert.equal(foreign.status, 404);
  const all = await f.request("/api/documents?all=1", "GET", undefined, friend.cookie);
  assert.deepEqual(all.data.documents.map(({ id }) => id), [other.data.id]);
});
