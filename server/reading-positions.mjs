// server/reading-positions.mjs
// The last reading page of each article, per website account. The
// reading-session heartbeat (server/sources.mjs) and
// PUT /api/documents/:id/reading-position write here; document and book
// summaries read it for 继续阅读, 最近阅读 and 读到第 N 页.
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const EPOCH = "1970-01-01T00:00:00.000Z";

export function createReadingPositions(database, { now = () => new Date().toISOString() } = {}) {
  database.exec(`CREATE TABLE IF NOT EXISTS reading_positions(
    user_id TEXT NOT NULL,document_id TEXT NOT NULL,page_id TEXT,
    page_index INTEGER NOT NULL DEFAULT 0,updated_at TEXT,
    PRIMARY KEY(user_id,document_id))`);
  const columns = database.prepare("PRAGMA table_info(reading_positions)").all().map((column) => column.name);
  if (!columns.includes("updated_at")) database.exec("ALTER TABLE reading_positions ADD COLUMN updated_at TEXT");
  // Rows saved before updated_at existed take the article's last change time.
  const documents = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='documents'").get();
  database.prepare(documents
    ? "UPDATE reading_positions SET updated_at=COALESCE((SELECT updated_at FROM documents WHERE documents.id=reading_positions.document_id),?) WHERE updated_at IS NULL"
    : "UPDATE reading_positions SET updated_at=? WHERE updated_at IS NULL").run(EPOCH);
  const upsert = database.prepare(`INSERT INTO reading_positions(user_id,document_id,page_id,page_index,updated_at) VALUES(?,?,?,?,?)
    ON CONFLICT(user_id,document_id) DO UPDATE SET page_id=excluded.page_id,page_index=excluded.page_index,updated_at=excluded.updated_at`);
  const list = database.prepare("SELECT document_id,page_index,updated_at FROM reading_positions WHERE user_id=?");
  const removal = database.prepare("DELETE FROM reading_positions WHERE user_id=? AND document_id=?");
  return {
    save(userId, documentId, { pageIndex, pageId = null }) {
      const updatedAt = now();
      upsert.run(userId, documentId, pageId, pageIndex, updatedAt);
      return { pageIndex, updatedAt };
    },
    forUser(userId) {
      return new Map(list.all(userId).map((row) => [row.document_id, { pageIndex: row.page_index, updatedAt: row.updated_at }]));
    },
    remove(userId, documentId) {
      removal.run(userId, documentId);
    },
  };
}

// Articles outside the source workflow have no reading-session heartbeat; the
// client records that they were opened with this route. Paged articles belong
// to the heartbeat, which drops delayed writes, so this route must not touch
// them. Unpaged articles have no reading pages: page 0 is the only position.
export function attachReadingPositionRoutes({ app, readingPositions, requireDocument, isPaged }) {
  app.put("/api/documents/:id/reading-position", (req, res) => {
    requireDocument(req.user.id, req.params.id);
    if (isPaged(req.user.id, req.params.id)) throw fail(409, "阅读位置已更新，请刷新。");
    const pageIndex = req.body?.pageIndex;
    if (pageIndex !== 0) throw fail(400, "阅读页位置无效。");
    res.json({ ...readingPositions.save(req.user.id, req.params.id, { pageIndex }), pageCount: 0, pagesFinal: false });
  });
}
