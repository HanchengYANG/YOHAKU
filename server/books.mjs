import { randomUUID } from "node:crypto";

const fail = (status, message) => Object.assign(new Error(message), { status });

function titleInput(value) {
  if (typeof value !== "string" || !value.trim() || value.trim().length > 160)
    throw fail(400, "书名需要填写，最多 160 个字符。");
  return value.trim();
}

function revisionInput(value) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw fail(400, "缺少有效的书籍版本，请重新打开后重试。");
  return value;
}

export function attachBookRoutes({ app, database, summary, requireDocument }) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      owner_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const columns = database.prepare("PRAGMA table_info(documents)").all().map((column) => column.name);
  if (!columns.includes("book_id")) database.exec("ALTER TABLE documents ADD COLUMN book_id TEXT");
  if (!columns.includes("page_position")) database.exec("ALTER TABLE documents ADD COLUMN page_position INTEGER");
  database.exec("CREATE INDEX IF NOT EXISTS documents_book_pages ON documents(book_id,page_position)");

  function transaction(work) {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      database.exec("COMMIT");
      return result;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  function requireBook(userId, id) {
    const book = database.prepare("SELECT * FROM books WHERE id=? AND owner_id=?").get(id, userId);
    if (!book) throw fail(404, "找不到你账号下的这本书。");
    return book;
  }

  const pages = (book) => database.prepare(
    "SELECT * FROM documents WHERE book_id=? AND owner_id=? ORDER BY page_position ASC,id ASC",
  ).all(book.id, book.owner_id);

  function present(book, includePages = false) {
    const summaries = pages(book).map(summary);
    return {
      id: book.id, title: book.title, revision: book.revision,
      createdAt: book.created_at, updatedAt: book.updated_at,
      pageCount: summaries.length,
      charCount: summaries.reduce((count, page) => count + page.charCount, 0),
      rubyCount: summaries.reduce((count, page) => count + page.rubyCount, 0),
      preview: summaries.find((page) => page.preview)?.preview || "",
      ...(includePages ? { pages: summaries } : {}),
    };
  }

  function touch(userId, id, now = new Date().toISOString()) {
    const changed = database.prepare(
      "UPDATE books SET revision=revision+1,updated_at=? WHERE id=? AND owner_id=?",
    ).run(now, id, userId);
    if (changed.changes !== 1) throw fail(404, "找不到你账号下的这本书。");
  }

  function reindex(userId, id) {
    const current = pages(requireBook(userId, id));
    const update = database.prepare("UPDATE documents SET page_position=? WHERE id=? AND book_id=? AND owner_id=?");
    current.forEach((page, index) => update.run(index + 1, page.id, id, userId));
  }

  app.get("/api/books", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length > 200) throw fail(400, "搜索词最多 200 个字符。");
    const pattern = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
    const books = query ? database.prepare(`
      SELECT * FROM books WHERE owner_id=? AND (title LIKE ? ESCAPE '!' OR EXISTS (
        SELECT 1 FROM documents WHERE book_id=books.id AND owner_id=books.owner_id
        AND (title LIKE ? ESCAPE '!' OR plain_text LIKE ? ESCAPE '!')
      )) ORDER BY updated_at DESC,id ASC
    `).all(req.user.id, pattern, pattern, pattern) : database.prepare(
      "SELECT * FROM books WHERE owner_id=? ORDER BY updated_at DESC,id ASC",
    ).all(req.user.id);
    res.json({ books: books.map((book) => present(book)) });
  });

  app.get("/api/books/:id", (req, res) => res.json(present(requireBook(req.user.id, req.params.id), true)));

  app.post("/api/books", (req, res) => {
    const title = titleInput(req.body?.title);
    const documentId = req.body?.documentId;
    if (documentId !== undefined && (typeof documentId !== "string" || !documentId))
      throw fail(400, "请选择有效的材料。");
    const id = randomUUID(), now = new Date().toISOString();
    transaction(() => {
      const document = documentId === undefined ? null : requireDocument(req.user.id, documentId);
      if (document?.book_id) throw fail(409, "这篇材料已经属于一本书。");
      database.prepare("INSERT INTO books(id,title,owner_id,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)")
        .run(id, title, req.user.id, now, now);
      if (document) database.prepare("UPDATE documents SET book_id=?,page_position=1 WHERE id=? AND owner_id=?")
        .run(id, document.id, req.user.id);
    });
    res.status(201).json(present(requireBook(req.user.id, id), true));
  });

  app.put("/api/books/:id", (req, res) => {
    const book = requireBook(req.user.id, req.params.id);
    const title = titleInput(req.body?.title), revision = revisionInput(req.body?.revision);
    if (revision !== book.revision) throw fail(409, "这本书已在其他页面修改，请重新打开最新版本后重试。");
    const pageIds = req.body?.pageIds;
    transaction(() => {
      if (pageIds !== undefined) {
        const current = pages(book);
        if (!Array.isArray(pageIds) || pageIds.length !== current.length ||
            pageIds.some((id) => typeof id !== "string") || new Set(pageIds).size !== pageIds.length ||
            current.some((page) => !pageIds.includes(page.id)))
          throw fail(400, "页面顺序必须包含这本书当前的全部页面，且不能重复。");
        const update = database.prepare("UPDATE documents SET page_position=? WHERE id=? AND book_id=? AND owner_id=?");
        pageIds.forEach((id, index) => update.run(index + 1, id, book.id, req.user.id));
      }
      const changed = database.prepare("UPDATE books SET title=?,revision=revision+1,updated_at=? WHERE id=? AND owner_id=? AND revision=?")
        .run(title, new Date().toISOString(), book.id, req.user.id, revision);
      if (changed.changes !== 1) throw fail(409, "书籍版本已更新，请重新打开后重试。");
    });
    res.json(present(requireBook(req.user.id, book.id), true));
  });

  app.delete("/api/books/:id", (req, res) => {
    const book = requireBook(req.user.id, req.params.id);
    const revision = revisionInput(req.body?.revision);
    if (revision !== book.revision) throw fail(409, "这本书已在其他页面修改，请重新打开最新版本后再决定是否删除。");
    transaction(() => {
      database.prepare("DELETE FROM conversations WHERE user_id=? AND document_id IN (SELECT id FROM documents WHERE book_id=? AND owner_id=?)")
        .run(req.user.id, book.id, req.user.id);
      database.prepare("DELETE FROM documents WHERE book_id=? AND owner_id=?").run(book.id, req.user.id);
      const changed = database.prepare("DELETE FROM books WHERE id=? AND owner_id=? AND revision=?")
        .run(book.id, req.user.id, revision);
      if (changed.changes !== 1) throw fail(409, "书籍版本已更新，请重新打开后重试。");
    });
    res.status(204).end();
  });

  return { requireBook, transaction, touch, reindex };
}
