import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkImage, selectVerificationUser } from "../scripts/verify-ai.mjs";
import { validateOcr, normalizeNewOcrDraft } from "../shared/ocr.mjs";

const owner = "11111111-1111-4111-8111-111111111111";
const friend = "22222222-2222-4222-8222-222222222222";

test("新读音验收允许印刷source和补全generated，不把无注音或非法来源当通过", () => {
  const segments = [
    { text: "今日", reading: "きょう", origin: "generated" },
    { text: "は", reading: null, origin: null },
    { text: "図書館", reading: "としょかん", origin: "generated" },
    { text: "で", reading: null, origin: null },
    { text: "日本語", reading: "にほんご", origin: "generated" },
    { text: "を", reading: null, origin: null },
    { text: "勉強", reading: "べんきょう", origin: "generated" },
    { text: "します。", reading: null, origin: null },
  ];
  const draft = { blocks: [{ segments }] };
  assert.ok(checkImage("04-unseen", draft).every(Boolean));
  const mixed = structuredClone(draft);
  mixed.blocks[0].segments[0].origin = "source";
  assert.ok(checkImage("04-unseen", mixed).every(Boolean));
  const printed = structuredClone(draft);
  for (const segment of printed.blocks[0].segments)
    if (segment.reading) segment.origin = "source";
  assert.ok(checkImage("04-unseen", printed).every(Boolean));
  const invalid = structuredClone(draft);
  invalid.blocks[0].segments[0].origin = "manual";
  assert.equal(checkImage("04-unseen", invalid).every(Boolean), false);
  invalid.blocks[0].segments[0].origin = null;
  assert.equal(checkImage("04-unseen", invalid).every(Boolean), false);
  const unannotated = structuredClone(draft);
  for (const segment of unannotated.blocks[0].segments) {
    segment.reading = null;
    segment.origin = null;
  }
  assert.equal(checkImage("04-unseen", unannotated).every(Boolean), false);
});

test("验证新草稿去掉纯假名冗余reading，保留source/generated/null及原始输入", () => {
  const raw = {
    title: "验证替身草稿",
    kind: "article",
    orientation: "horizontal",
    readingOrder: "从左到右。",
    blocks: [{
      confidence: "high", sourcePage: "single",
      segments: [
        { text: "今日", reading: "きょう", origin: "source" },
        { text: "は", reading: "は", origin: "source" },
        { text: "図書館", reading: "としょかん", origin: "generated" },
        { text: "で", reading: "で", origin: "generated" },
        { text: "日本語", reading: "にほんご", origin: "source" },
        { text: "を", reading: null, origin: null },
        { text: "勉強", reading: "べんきょう", origin: "generated" },
        { text: "します。", reading: null, origin: null },
      ],
    }],
    warnings: [], nonBody: [],
  };
  const validated = validateOcr(raw);
  const snapshot = structuredClone(validated);
  const normalized = normalizeNewOcrDraft(validated);
  assert.ok(checkImage("04-unseen", normalized).every(Boolean));
  assert.deepEqual(normalized.blocks[0].segments.map((segment) => segment.origin),
    ["source", null, "generated", null, "source", null, "generated", null]);
  assert.equal(normalized.blocks[0].segments[1].reading, null);
  assert.equal(normalized.blocks[0].segments[3].reading, null);
  assert.deepEqual(validated, snapshot);
});

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-verify-"));
  const db = new DatabaseSync(join(directory, "yohaku.sqlite"));
  t.after(async () => {
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  db.exec(
    "CREATE TABLE users(id TEXT, username TEXT, username_key TEXT); CREATE TABLE app_settings(key TEXT,value TEXT); CREATE TABLE provider_bindings(user_id TEXT,provider_id TEXT,subject TEXT); CREATE TABLE user_providers(user_id TEXT,provider_id TEXT);",
  );
  db.prepare("INSERT INTO users VALUES(?,?,?)").run(owner, "Owner", "owner");
  db.prepare("INSERT INTO users VALUES(?,?,?)").run(friend, "Friend", "friend");
  db.prepare("INSERT INTO app_settings VALUES(?,?)").run("legacy_owner", owner);
  return { directory, db };
}

test("真实验证脚本使用所选网站用户的持久绑定，不误报已绑定用户或借用其他人的绑定", async (t) => {
  const { directory, db } = await fixture(t);
  db.prepare("INSERT INTO provider_bindings VALUES(?,?,?)").run(
    owner,
    "openai",
    "owner-subject",
  );
  assert.equal(selectVerificationUser(directory).id, owner);
  assert.deepEqual(selectVerificationUser(directory).subjects, [
    "owner-subject",
  ]);
  assert.equal(selectVerificationUser(directory, ["--user=OWNER"]).id, owner);
  assert.throws(
    () => selectVerificationUser(directory, ["--user=Friend"]),
    /自己的订阅授权或显式认领/,
  );
  db.prepare("INSERT INTO provider_bindings VALUES(?,?,?)").run(
    friend,
    "openai",
    "friend-subject",
  );
  assert.deepEqual(
    selectVerificationUser(directory, ["--user=Friend"]).subjects,
    ["friend-subject"],
  );
  assert.deepEqual((await readdir(directory)).sort(), ["yohaku.sqlite"]);
});

test("未实现provider和不存在的网站账号不会构造运行时或创建授权目录", async (t) => {
  const { directory, db } = await fixture(t);
  db.prepare("INSERT INTO provider_bindings VALUES(?,?,?)").run(
    owner,
    "openai",
    "owner-subject",
  );
  db.prepare("INSERT INTO user_providers VALUES(?,?)").run(owner, "claude");
  assert.throws(
    () => selectVerificationUser(directory),
    /仅支持已实现的 OpenAI/,
  );
  assert.throws(
    () => selectVerificationUser(directory, ["--user=missing"]),
    /未找到已完成设置/,
  );
  assert.deepEqual((await readdir(directory)).sort(), ["yohaku.sqlite"]);
});
