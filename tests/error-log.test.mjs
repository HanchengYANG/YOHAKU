import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createErrorLog } from "../server/errors.mjs";
import { AI_SETTINGS_ACTION, failureText } from "../shared/error-codes.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });
const at = (iso) => () => Date.parse(iso);

function fixture({ now = at("2026-11-06T10:00:00.000Z"), codes } = {}) {
  const database = new DatabaseSync(":memory:");
  const queue = codes ? [...codes] : null;
  return { database, log: createErrorLog(database, { now, ...(queue ? { generateCode: () => queue.shift() } : {}) }) };
}

test("记录完整信息，可按代码（不区分大小写）取回", () => {
  const { log } = fixture({ codes: ["AAAAAA"] });
  const error = fail(502, "上游返回 500 token=abc123", {
    diagnostic: { code: "AI_INVALID_RESPONSE", category: "invalid_response", httpStatus: 500 },
    execution: { providerId: "api_base", model: "m" },
  });
  const code = log.record(error, { userId: "u1", scope: "source", location: "source:segment", context: { documentId: "d1" } });
  assert.equal(code, "AAAAAA");
  const entry = log.get("aaaaaa");
  assert.equal(entry.message, "上游返回 500 token=[已隐藏]");
  assert.equal(entry.scope, "source");
  assert.equal(entry.location, "source:segment");
  assert.equal(entry.kind, "AI_INVALID_RESPONSE");
  assert.equal(entry.status, 502);
  assert.equal(entry.userId, "u1");
  assert.equal(entry.username, null);
  assert.equal(entry.createdAt, "2026-11-06T10:00:00.000Z");
  assert.equal(entry.context.documentId, "d1");
  assert.equal(entry.context.execution.model, "m");
  assert.deepEqual(entry.context.diagnostic, { code: "AI_INVALID_RESPONSE", category: "invalid_response", httpStatus: 500 });
  assert.match(entry.stack, /上游返回 500/);
  assert.equal(log.get("ZZZZZZ"), null);
});

test("代码冲突时换一个", () => {
  const { log } = fixture({ codes: ["AAAAAA", "AAAAAA", "BBBBBB"] });
  assert.equal(log.record(new Error("一")), "AAAAAA");
  assert.equal(log.record(new Error("二")), "BBBBBB");
});

test("capture 对同一个错误对象只记录一次，并返回带代码的文案", () => {
  const { log } = fixture({ codes: ["AAAAAA", "BBBBBB"] });
  const error = fail(503, "网站 AI 尚未连接", { code: "AI_AUTH_REQUIRED" });
  assert.equal(log.capture(error, { scope: "task" }), failureText("AAAAAA", AI_SETTINGS_ACTION));
  assert.equal(log.capture(error, { scope: "task" }), failureText("AAAAAA", AI_SETTINGS_ACTION));
  assert.equal(error.errorCode, "AAAAAA");
  assert.equal(error.errorAction, AI_SETTINGS_ACTION);
  assert.equal(log.list().items.length, 1);
  // Background failures are always recorded, even 4xx ones.
  assert.equal(log.capture(fail(400, "识别结果缺少正文")), failureText("BBBBBB"));
});

test("列表倒序、可按代码过滤、可分页，并能关联网站账号", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE users(id TEXT PRIMARY KEY, username TEXT)");
  database.prepare("INSERT INTO users VALUES('u1','test')").run();
  let clock = Date.parse("2026-11-06T10:00:00.000Z");
  const codes = ["AAAAAA", "BBBBBB", "CCCCCC"];
  const log = createErrorLog(database, { now: () => clock, generateCode: () => codes.shift() });
  for (const message of ["第一行\n第二行", "二", "三"]) { log.record(new Error(message), { userId: "u1" }); clock += 1000; }
  const page = log.list({ limit: 2 });
  assert.deepEqual(page.items.map((item) => item.code), ["CCCCCC", "BBBBBB"]);
  assert.equal(page.items[0].username, "test");
  assert.equal(page.nextBefore, "2026-11-06T10:00:01.000Z");
  assert.deepEqual(log.list({ before: page.nextBefore }).items.map((item) => item.code), ["AAAAAA"]);
  assert.equal(log.list({ before: page.nextBefore }).items[0].summary, "第一行");
  assert.deepEqual(log.list({ query: " bbbbbb " }).items.map((item) => item.code), ["BBBBBB"]);
});

test("清理 90 天前的记录", () => {
  let clock = Date.parse("2026-01-01T00:00:00.000Z");
  const database = new DatabaseSync(":memory:");
  const codes = ["AAAAAA", "BBBBBB"];
  const log = createErrorLog(database, { now: () => clock, generateCode: () => codes.shift() });
  log.record(new Error("旧"));
  clock = Date.parse("2026-04-02T00:00:00.000Z");
  log.record(new Error("新"));
  assert.equal(log.prune(), 1);
  assert.deepEqual(log.list().items.map((item) => item.code), ["BBBBBB"]);
});
