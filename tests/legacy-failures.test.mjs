import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { migrateLegacyFailures } from "../server/legacy-failures.mjs";
import { failureText } from "../shared/error-codes.mjs";

const coded = failureText("7K2QD9");

function fixture() {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE article_sources(scope_id TEXT PRIMARY KEY, error TEXT);
    CREATE TABLE source_steps(scope_id TEXT, step TEXT, error TEXT);
    CREATE TABLE conversations(id TEXT PRIMARY KEY, last_error TEXT);
    CREATE TABLE image_tasks(id TEXT PRIMARY KEY, blocked_reason TEXT, segmentation_json TEXT);
    CREATE TABLE image_task_items(id TEXT PRIMARY KEY, steps_json TEXT);
    CREATE TABLE import_drafts(id TEXT PRIMARY KEY, draft_json TEXT);
  `);
  database.prepare("INSERT INTO article_sources VALUES('a','HTTP 503 upstream'),('b',?),('c',NULL)").run(coded);
  database.prepare("INSERT INTO source_steps VALUES('a','correct','JSON 解析失败')").run();
  database.prepare("INSERT INTO conversations VALUES('c1','ChatGPT 授权已失效或被拒绝')").run();
  database.prepare("INSERT INTO image_tasks VALUES('t1','网站 AI 授权需要恢复',?)").run(JSON.stringify({ state: "failed", error: "分句失败：raw" }));
  database.prepare("INSERT INTO image_task_items VALUES('i1',?)").run(JSON.stringify({ recognize: { error: "model gpt-x 400" }, annotate: { error: coded } }));
  database.prepare("INSERT INTO import_drafts VALUES('d1',?)").run(JSON.stringify({
    chapterError: "AI 分章未完成", chapterProcessing: { error: "AI 分章未完成" }, inspectionProcessing: { error: coded },
    files: [{ info: { error: "pdfium crashed" }, inspection: { error: "pdfium crashed", httpStatus: 502 } }],
  }));
  return database;
}

test("旧失败文字改为处理失败，带代码的保留，只执行一次", () => {
  const database = fixture();
  assert.equal(migrateLegacyFailures(database), true);
  const value = (sql) => database.prepare(sql).get().value;
  assert.equal(value("SELECT error AS value FROM article_sources WHERE scope_id='a'"), "处理失败");
  assert.equal(value("SELECT error AS value FROM article_sources WHERE scope_id='b'"), coded);
  assert.equal(value("SELECT error AS value FROM article_sources WHERE scope_id='c'"), null);
  assert.equal(value("SELECT error AS value FROM source_steps"), "处理失败");
  assert.equal(value("SELECT last_error AS value FROM conversations"), "处理失败");
  assert.equal(value("SELECT blocked_reason AS value FROM image_tasks"), "处理失败");
  assert.equal(JSON.parse(value("SELECT segmentation_json AS value FROM image_tasks")).error, "处理失败");
  const steps = JSON.parse(value("SELECT steps_json AS value FROM image_task_items"));
  assert.equal(steps.recognize.error, "处理失败");
  assert.equal(steps.annotate.error, coded);
  const draft = JSON.parse(value("SELECT draft_json AS value FROM import_drafts"));
  assert.equal(draft.chapterError, "处理失败");
  assert.equal(draft.chapterProcessing.error, "处理失败");
  assert.equal(draft.inspectionProcessing.error, coded);
  assert.equal(draft.files[0].info.error, "处理失败");
  assert.equal(draft.files[0].inspection.error, "处理失败");
  assert.equal(draft.files[0].inspection.httpStatus, 502);
  database.prepare("UPDATE article_sources SET error='新的原始错误' WHERE scope_id='a'").run();
  assert.equal(migrateLegacyFailures(database), false);
  assert.equal(value("SELECT error AS value FROM article_sources WHERE scope_id='a'"), "新的原始错误");
});

test("缺少的表直接跳过", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE app_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  assert.equal(migrateLegacyFailures(database), true);
});
