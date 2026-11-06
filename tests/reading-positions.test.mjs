// tests/reading-positions.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createReadingPositions } from "../server/reading-positions.mjs";

test("旧表补上 updated_at，按文章最后修改时间回填，重复初始化不改数据", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE documents(id TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
    INSERT INTO documents VALUES('doc','2026-10-01T08:00:00.000Z');
    CREATE TABLE reading_positions(user_id TEXT NOT NULL,document_id TEXT NOT NULL,page_id TEXT,page_index INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,document_id));
    INSERT INTO reading_positions VALUES('u','doc','p3',3);
    INSERT INTO reading_positions VALUES('u','gone',NULL,1);
  `);
  const positions = createReadingPositions(database);
  assert.deepEqual(Object.fromEntries(positions.forUser("u")), {
    doc: { pageIndex: 3, updatedAt: "2026-10-01T08:00:00.000Z" },
    gone: { pageIndex: 1, updatedAt: "1970-01-01T00:00:00.000Z" },
  });
  createReadingPositions(database);
  assert.equal(positions.forUser("u").get("doc").updatedAt, "2026-10-01T08:00:00.000Z");
});

test("保存、按账号读取与删除", () => {
  const database = new DatabaseSync(":memory:");
  let clock = "2026-11-06T09:00:00.000Z";
  const positions = createReadingPositions(database, { now: () => clock });
  assert.deepEqual(positions.save("u", "a", { pageIndex: 2, pageId: "p2" }), { pageIndex: 2, updatedAt: clock });
  clock = "2026-11-06T09:05:00.000Z";
  positions.save("u", "a", { pageIndex: 4 });
  positions.save("other", "a", { pageIndex: 7 });
  assert.deepEqual(positions.forUser("u").get("a"), { pageIndex: 4, updatedAt: "2026-11-06T09:05:00.000Z" });
  assert.equal(positions.forUser("u").size, 1);
  assert.equal(database.prepare("SELECT page_id FROM reading_positions WHERE user_id='u'").get().page_id, null);
  positions.remove("u", "a");
  assert.equal(positions.forUser("u").size, 0);
  assert.equal(positions.forUser("other").size, 1);
});
