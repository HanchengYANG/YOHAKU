# UI／UX 改版第 1 步：错误代码地基 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 系统错误在界面上只显示「一句话 + 6 位错误代码」，完整信息写入服务器 `error_log`，管理员在「错误记录」页按代码查找。

**Architecture:** `shared/error-codes.mjs` 定义失败文案格式（服务端生成、客户端解析）。`server/errors.mjs` 负责分类、生成代码、写入／查询 `error_log`、组装 HTTP 与流式对话的错误响应；各后台任务在失败时调用 `errorLog.capture()`，把带代码的失败文案存进原有的错误字段，因此现有界面无需逐个改动就会显示代码。客户端 `api.mjs` 统一处理断网，`ErrorNotice` 组件负责复制代码和管理员的「去 AI 设置」操作。

**Tech Stack:** Node 24 内置 `node:sqlite`、Express 5、React 19、`node --test`、Playwright。

**设计文档：** `docs/superpowers/specs/2026-11-06-ui-ux-overhaul-design.md` 第 1 节。

---

## 开始前

- 基线（提交 `2307a9a`，Node 24）：`npm test` 共 770 项，742 通过、26 失败、1 取消。失败全部是 PDF／EPUB 用例，原因是本机缺少 `fixtures/epub/*` 与文档运行环境，与本计划无关。失败名单在 `artifacts/baseline-failing-tests.txt`（已被 `.gitignore` 忽略）。
- 判定标准：每次跑 `npm test` 后，失败名单不得超出基线。对比命令（本计划多处使用）：

```bash
npm test > /tmp/yohaku-test.log 2>&1; awk '/^✖ failing tests:/{exit} /^✖ /{sub(/ \([0-9.]+ms\)$/,""); print}' /tmp/yohaku-test.log | sort -u | comm -23 - artifacts/baseline-failing-tests.txt
```

  输出为空表示没有新增失败。
- **行号约定**：文中所有行号都是提交 `2307a9a` 时的原始行号。在顶部加 import 或插入新行会让下面的行号整体后移，所以同一文件内请从行号大的地方往上改，或按文中引用的原文定位。
- 本步刻意不做的事（后续步骤处理）：
  - 各页面逐个改用 `ErrorNotice`：第 2–5 步重做页面时顺带完成。本步依靠“失败文案自带代码”，现有显示位置已经能看到代码。
  - AI 设置与角色配置页里的 `status.lastError`：第 5 步合并 AI 页时处理。
  - 「错误记录」入口本步先放在侧栏底部管理员按钮行；第 2 步整理侧栏时移进账号菜单。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `shared/error-codes.mjs`（新） | 代码字母表、失败文案格式化与解析，前后端共用 |
| `server/errors.mjs`（新） | 生成代码、敏感信息隐藏、错误分类、`error_log` 读写、HTTP／流式错误响应 |
| `server/legacy-failures.mjs`（新） | 一次性把改版前存下的原始错误文字改成「处理失败」 |
| `server/error-routes.mjs`（新） | 管理员错误记录接口 |
| `server/accounts.mjs` | 导出 `requireAdmin` |
| `server/app.mjs` | 创建 `errorLog`、换用新错误中间件、挂接口、定期清理 |
| `server/ai/chat-stream.mjs` | 流式对话错误带代码 |
| `server/ai/routes.mjs`、`server/image-tasks.mjs`、`server/sources.mjs`、`server/imports.mjs` | 后台失败写入 `error_log`，原错误字段改存带代码的文案 |
| `client/api.mjs` | 断网白话提示、错误对象带 `errorCode`／`action`、`apiFetch` |
| `client/chat-stream.mjs`、`client/components/Editor.jsx`、`client/components/UnifiedImport.jsx` | 直接 `fetch` 的地方改用 `apiFetch` |
| `client/error-presentation.mjs`（新） | 把错误对象或文案转成界面模型 |
| `client/user-context.mjs`（新） | 当前网站账号的 React context |
| `client/components/ErrorNotice.mjs`（新） | 错误提示组件（`createElement` 写法，便于 `node --test` 渲染） |
| `client/components/ErrorLog.jsx`（新） | 管理员错误记录页 |
| `client/App.jsx` | 提供 `UserContext`、错误记录面板与入口、响应「去 AI 设置」 |
| `client/stage2.css` | `ErrorNotice` 与错误记录页样式 |
| `client/components/PagedReader.jsx`、`DocumentChat.jsx`、`ImageTasks.jsx` | 删除执行详情与诊断明细的界面 |
| `client/components/ExecutionDetails.mjs`、`tests/execution-details.test.mjs` | 删除 |

---

### Task 1: 失败文案格式（shared）

**Files:**
- Create: `shared/error-codes.mjs`
- Test: `tests/error-codes.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/error-codes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { AI_SETTINGS_ACTION, failureText, isErrorCode, parseFailure } from "../shared/error-codes.mjs";

test("错误代码只使用 Crockford Base32 的 6 个大写字符", () => {
  assert.equal(isErrorCode("7K2QD9"), true);
  for (const value of ["7K2QD", "7K2QD9X", "7K2QDI", "7K2QDO", "7k2qd9", "", null, undefined])
    assert.equal(isErrorCode(value), false, String(value));
});

test("失败文案可以往返解析", () => {
  assert.equal(failureText("7K2QD9"), "出错了，请重试 · 错误代码 7K2QD9");
  assert.deepEqual(parseFailure("出错了，请重试 · 错误代码 7K2QD9"), { code: "7K2QD9", action: null });
  assert.equal(failureText("7K2QD9", AI_SETTINGS_ACTION), "AI 暂时不可用 · 错误代码 7K2QD9");
  assert.deepEqual(parseFailure("AI 暂时不可用 · 错误代码 7K2QD9"), { code: "7K2QD9", action: AI_SETTINGS_ACTION });
  assert.equal(parseFailure("API key 无效"), null);
  assert.equal(parseFailure(undefined), null);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/error-codes.test.mjs`
Expected: FAIL，`Cannot find module '.../shared/error-codes.mjs'`

- [ ] **Step 3: 实现**

```js
// shared/error-codes.mjs
// Users see a short failure sentence plus a code. The server writes the text
// with failureText(); the client reads the code back with parseFailure().
export const ERROR_CODE_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const AI_SETTINGS_ACTION = "ai-settings";
export const GENERIC_FAILURE = "出错了，请重试";
export const AI_UNAVAILABLE = "AI 暂时不可用";
export const LEGACY_FAILURE = "处理失败";

const codePattern = /^[0-9A-HJKMNP-TV-Z]{6}$/;
const failurePattern = /^(出错了，请重试|AI 暂时不可用) · 错误代码 ([0-9A-HJKMNP-TV-Z]{6})$/;

export function isErrorCode(value) {
  return typeof value === "string" && codePattern.test(value);
}

export function failureText(code, action = null) {
  return `${action === AI_SETTINGS_ACTION ? AI_UNAVAILABLE : GENERIC_FAILURE} · 错误代码 ${code}`;
}

export function parseFailure(text) {
  const match = typeof text === "string" ? failurePattern.exec(text) : null;
  return match ? { code: match[2], action: match[1] === AI_UNAVAILABLE ? AI_SETTINGS_ACTION : null } : null;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/error-codes.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add shared/error-codes.mjs tests/error-codes.test.mjs
git commit -m "feat: define user-facing failure text with error codes"
```

---

### Task 2: 代码生成、敏感信息隐藏与错误分类

**Files:**
- Create: `server/errors.mjs`
- Test: `tests/errors.test.mjs`

分类规则（设计文档 1.2）：

- AI 授权失效（`code === "AI_AUTH_REQUIRED"`，或带 `diagnostic` 的 401／403）→ 记录，带 `ai-settings` 操作。
- 其余 4xx，且不是 AI／上游错误（没有 `diagnostic`，`code` 不以 `AI_` 开头）→ 用户能自己解决，不记录。`AI_BUSY`（409「AI 正在处理请求」）也归这一类。
- 其他一律记录。

注意：现有中间件对 4xx 无论有没有 `expose` 都直接返回 `error.message`（`server/app.mjs` 的 `HttpError` 和 `AccountError` 都不设 `expose`），所以这里按状态码判断，不看 `expose`。

- [ ] **Step 1: 写失败测试**

```js
// tests/errors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { classifyError, newErrorCode, redact } from "../server/errors.mjs";
import { AI_SETTINGS_ACTION, isErrorCode } from "../shared/error-codes.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

test("错误代码由随机字节均匀映射到 32 个字符", () => {
  assert.equal(newErrorCode(Buffer.from([0, 1, 31, 32, 255, 100])), "01Z0Z4");
  assert.equal(isErrorCode(newErrorCode()), true);
});

test("隐藏密钥、令牌与授权头", () => {
  assert.equal(redact("Authorization: Bearer abc.def.ghi1234 failed"), "Authorization: [已隐藏] failed");
  assert.equal(redact("key sk-abcdefgh12345 rejected"), "key [已隐藏] rejected");
  assert.equal(redact('{"apiKey":"xyz123"}'), '{"apiKey":"[已隐藏]"}');
  assert.equal(redact("普通错误"), "普通错误");
});

test("用户能自己解决的错误不记录", () => {
  assert.deepEqual(classifyError(fail(400, "书名需要填写")), { record: false, kind: null, action: null });
  assert.equal(classifyError(Object.assign(new Error("找不到这篇材料"), { status: 404 })).record, false);
  assert.deepEqual(classifyError(fail(409, "AI 正在处理请求", { code: "AI_BUSY" })), { record: false, kind: "AI_BUSY", action: null });
});

test("服务端、AI 与上游错误都记录", () => {
  assert.deepEqual(classifyError(new Error("SQLITE_FULL")), { record: true, kind: null, action: null });
  assert.deepEqual(classifyError(fail(502, "AI 调用失败", { diagnostic: { code: "AI_INVALID_RESPONSE" } })),
    { record: true, kind: "AI_INVALID_RESPONSE", action: null });
  assert.equal(classifyError(fail(429, "达到频率限制", { diagnostic: { code: "AI_RATE_LIMIT" } })).record, true);
});

test("AI 授权失效带上去 AI 设置的操作", () => {
  for (const error of [
    fail(503, "网站 AI 尚未连接", { code: "AI_AUTH_REQUIRED" }),
    fail(401, "API key 无效", { diagnostic: { code: "AI_AUTH_ERROR" } }),
  ]) assert.deepEqual(classifyError(error), { record: true, kind: "AI_AUTH_REQUIRED", action: AI_SETTINGS_ACTION });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/errors.test.mjs`
Expected: FAIL，`Cannot find module '.../server/errors.mjs'`

- [ ] **Step 3: 实现**

```js
// server/errors.mjs
import { randomBytes } from "node:crypto";
import { AI_SETTINGS_ACTION, ERROR_CODE_ALPHABET } from "../shared/error-codes.mjs";

export function newErrorCode(bytes = randomBytes(6)) {
  // 256 is a multiple of 32, so every character is equally likely.
  return Array.from(bytes.subarray(0, 6), (byte) => ERROR_CODE_ALPHABET[byte % 32]).join("");
}

// SDK errors can carry credentials; hide the common shapes before storing.
export function redact(text) {
  return String(text ?? "")
    .replace(/(authorization\s*[:=]\s*)(?:bearer\s+)?[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已隐藏]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[已隐藏]");
}

const userFixableAICodes = new Set(["AI_BUSY"]);

export function classifyError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === "string" ? error.code : null;
  const fromAI = Boolean(error?.diagnostic) || Boolean(code?.startsWith("AI_"));
  if (code === "AI_AUTH_REQUIRED" || (fromAI && [401, 403].includes(status)))
    return { record: true, kind: "AI_AUTH_REQUIRED", action: AI_SETTINGS_ACTION };
  if (status < 500 && (!fromAI || userFixableAICodes.has(code)))
    return { record: false, kind: code, action: null };
  return { record: true, kind: code || error?.diagnostic?.code || null, action: null };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/errors.test.mjs`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add server/errors.mjs tests/errors.test.mjs
git commit -m "feat: classify server errors and generate error codes"
```

---

### Task 3: `error_log` 读写

**Files:**
- Modify: `server/errors.mjs`（追加）
- Test: `tests/error-log.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/error-log.test.mjs
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/error-log.test.mjs`
Expected: FAIL，`createErrorLog` 不是导出的函数（SyntaxError: does not provide an export named 'createErrorLog'）

- [ ] **Step 3: 实现**

在 `server/errors.mjs` 顶部把 import 改为：

```js
import { randomBytes } from "node:crypto";
import { AI_SETTINGS_ACTION, ERROR_CODE_ALPHABET, failureText, isErrorCode } from "../shared/error-codes.mjs";
import { sanitizeDiagnostic } from "./ai/diagnostics.mjs";
```

在文件末尾追加：

```js
const DAY_MS = 24 * 60 * 60 * 1000;

export function createErrorLog(database, { now = () => Date.now(), generateCode = newErrorCode, retentionMs = 90 * DAY_MS } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS error_log (
      code TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      user_id TEXT,
      scope TEXT NOT NULL,
      location TEXT,
      kind TEXT,
      status INTEGER,
      message TEXT NOT NULL,
      stack TEXT,
      context_json TEXT
    );
    CREATE INDEX IF NOT EXISTS error_log_created ON error_log(created_at);
  `);
  const insert = database.prepare(`INSERT OR IGNORE INTO error_log
    (code,created_at,user_id,scope,location,kind,status,message,stack,context_json) VALUES(?,?,?,?,?,?,?,?,?,?)`);
  const hasUsers = () => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='users'").get());
  const select = (where) => hasUsers()
    ? `SELECT e.*, u.username FROM error_log e LEFT JOIN users u ON u.id=e.user_id${where}`
    : `SELECT e.*, NULL AS username FROM error_log e${where}`;
  const normalize = (value) => String(value ?? "").trim().toUpperCase();

  function record(error, { userId = null, scope = "http", location = null, context = {} } = {}) {
    const { kind } = classifyError(error);
    const details = { ...context };
    const diagnostic = sanitizeDiagnostic(error?.diagnostic);
    if (diagnostic) details.diagnostic = diagnostic;
    if (error?.execution) details.execution = error.execution;
    const message = redact(error?.message || error || "未知错误").slice(0, 4000);
    const stack = typeof error?.stack === "string" ? redact(error.stack).slice(0, 8000) : null;
    const status = Number.isInteger(error?.status) ? error.status : null;
    const createdAt = new Date(now()).toISOString();
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateCode();
      if (insert.run(code, createdAt, userId, scope, location, kind, status, message, stack, redact(JSON.stringify(details))).changes) return code;
    }
    throw new Error("无法生成唯一的错误代码。");
  }

  // Background failures: record once per error object and return the text
  // that is stored in the existing error fields.
  function capture(error, meta) {
    const target = error && typeof error === "object" ? error : new Error(String(error));
    if (!isErrorCode(target.errorCode)) {
      target.errorAction = classifyError(target).action;
      target.errorCode = record(target, meta);
    }
    return failureText(target.errorCode, target.errorAction);
  }

  const present = (row) => row ? {
    code: row.code, createdAt: row.created_at, userId: row.user_id, username: row.username ?? null,
    scope: row.scope, location: row.location, kind: row.kind, status: row.status,
    message: row.message, stack: row.stack, context: row.context_json ? JSON.parse(row.context_json) : {},
  } : null;

  function get(code) {
    return present(database.prepare(select(" WHERE e.code=?")).get(normalize(code)));
  }

  function list({ query = "", before = null, limit = 50 } = {}) {
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const where = [], params = [];
    const code = normalize(query);
    if (code) { where.push("e.code=?"); params.push(code); }
    if (before) { where.push("e.created_at<?"); params.push(String(before)); }
    const rows = database.prepare(`${select(where.length ? ` WHERE ${where.join(" AND ")}` : "")} ORDER BY e.created_at DESC, e.code DESC LIMIT ?`)
      .all(...params, size + 1);
    return {
      items: rows.slice(0, size).map((row) => ({
        code: row.code, createdAt: row.created_at, username: row.username ?? null,
        scope: row.scope, location: row.location, kind: row.kind,
        summary: row.message.split("\n", 1)[0].slice(0, 120),
      })),
      nextBefore: rows.length > size ? rows[size - 1].created_at : null,
    };
  }

  function prune() {
    return Number(database.prepare("DELETE FROM error_log WHERE created_at<?").run(new Date(now() - retentionMs).toISOString()).changes);
  }

  return { record, capture, get, list, prune };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/error-log.test.mjs tests/errors.test.mjs`
Expected: PASS（10 项）

- [ ] **Step 5: 提交**

```bash
git add server/errors.mjs tests/error-log.test.mjs
git commit -m "feat: store server errors in an error log keyed by code"
```

---

### Task 4: HTTP 错误响应

**Files:**
- Modify: `server/errors.mjs`（追加）
- Test: `tests/error-responses.test.mjs`

响应形状（设计文档 1.4）：`{ error, errorCode?, action?, code? }`。`code` 仍只对现有五个前端依赖的值下发。

- [ ] **Step 1: 写失败测试**

```js
// tests/error-responses.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { createErrorLog, errorResponder } from "../server/errors.mjs";
import { AI_SETTINGS_ACTION, failureText, isErrorCode } from "../shared/error-codes.mjs";

const fail = (status, message, extra = {}) => Object.assign(new Error(message), { status, expose: true, ...extra });

async function serve(t, makeError) {
  const errorLog = createErrorLog(new DatabaseSync(":memory:"));
  const app = express();
  app.use((req, _res, next) => { req.user = { id: "u1" }; next(); });
  app.get("/api/boom", () => { throw makeError(errorLog); });
  app.use(errorResponder({ errorLog, log: () => {} }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/boom?x=1`);
  return { errorLog, status: response.status, body: await response.json() };
}

test("用户能自己解决的错误原样返回白话，不记录", async (t) => {
  const { errorLog, status, body } = await serve(t, () => fail(400, "书名需要填写，最多 160 个字符。"));
  assert.equal(status, 400);
  assert.deepEqual(body, { error: "书名需要填写，最多 160 个字符。" });
  assert.equal(errorLog.list().items.length, 0);
});

test("服务端错误返回代码，详情只在记录里", async (t) => {
  const { errorLog, status, body } = await serve(t, () => new Error("SQLITE_FULL: database or disk is full"));
  assert.equal(status, 500);
  assert.ok(isErrorCode(body.errorCode));
  assert.deepEqual(body, { error: failureText(body.errorCode), errorCode: body.errorCode });
  const entry = errorLog.get(body.errorCode);
  assert.equal(entry.message, "SQLITE_FULL: database or disk is full");
  assert.equal(entry.location, "GET /api/boom");
  assert.equal(entry.userId, "u1");
});

test("AI 授权失效带上操作", async (t) => {
  const { status, body } = await serve(t, () => fail(503, "网站 AI 尚未连接，请联系网站拥有者完成授权。", { code: "AI_AUTH_REQUIRED" }));
  assert.equal(status, 503);
  assert.equal(body.action, AI_SETTINGS_ACTION);
  assert.equal(body.error, failureText(body.errorCode, AI_SETTINGS_ACTION));
});

test("网站登录失效仍下发 code", async (t) => {
  const { body } = await serve(t, () => Object.assign(new Error("请先登录你的网站账户。"), { status: 401, code: "WEBSITE_AUTH_REQUIRED" }));
  assert.deepEqual(body, { code: "WEBSITE_AUTH_REQUIRED", error: "请先登录你的网站账户。" });
});

test("已经记录过的错误沿用原代码", async (t) => {
  const { errorLog, body } = await serve(t, (log) => {
    const error = fail(502, "AI 识别未完成", { diagnostic: { code: "AI_INCOMPLETE_OUTPUT", category: "incomplete_output" } });
    log.capture(error, { scope: "task" });
    return error;
  });
  assert.equal(errorLog.list().items.length, 1);
  assert.equal(errorLog.list().items[0].code, body.errorCode);
});

test("上传与请求体错误保持原有白话", async (t) => {
  const { body } = await serve(t, () => Object.assign(new Error("too large"), { type: "entity.too.large", status: 413 }));
  assert.deepEqual(body, { error: "提交内容过大，请减少正文长度。" });
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/error-responses.test.mjs`
Expected: FAIL，does not provide an export named 'errorResponder'

- [ ] **Step 3: 实现**

在 `server/errors.mjs` 末尾追加：

```js
// Codes the client already relies on (session expiry, task and edit conflicts).
const PUBLIC_CODES = new Set(["WEBSITE_AUTH_REQUIRED", "TASK_VERSION_CONFLICT", "TASK_RESULT_STALE", "TASK_UNAVAILABLE", "SOURCE_EDIT_REVISION_CONFLICT"]);
const UNAVAILABLE = "服务暂时遇到问题，请稍后再试。";

export function publicErrorBody(error, { errorLog, userId = null, scope = "http", location = null, log = console.error } = {}) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const publicCode = PUBLIC_CODES.has(error?.code) ? { code: error.code } : {};
  const { record, action } = classifyError(error);
  let errorCode = isErrorCode(error?.errorCode) ? error.errorCode : null;
  if (!record && !errorCode) return { status, body: { ...publicCode, error: String(error?.message || UNAVAILABLE) } };
  if (!errorCode) {
    try { errorCode = errorLog.record(error, { userId, scope, location }); }
    catch (cause) { log("错误记录写入失败：", cause?.message); }
  }
  const finalAction = error?.errorAction ?? action;
  return {
    status,
    body: {
      ...publicCode,
      error: errorCode ? failureText(errorCode, finalAction) : UNAVAILABLE,
      ...(errorCode ? { errorCode } : {}),
      ...(errorCode && finalAction ? { action: finalAction } : {}),
    },
  };
}

export function errorResponder({ errorLog, log = console.error } = {}) {
  return (error, req, res, _next) => {
    if (error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "图片最大 12 MB，请换一张较小的图片。" });
    if (error.name === "MulterError") return res.status(400).json({ error: "请一次上传一张 PNG、JPEG 或 WebP 图片。" });
    if (error.type === "entity.too.large") return res.status(413).json({ error: "提交内容过大，请减少正文长度。" });
    if (error.type === "entity.parse.failed") return res.status(400).json({ error: "请求格式有误，请重新提交。" });
    const { status, body } = publicErrorBody(error, {
      errorLog, log, userId: req.user?.id ?? null, scope: "http",
      location: `${req.method} ${req.originalUrl.split("?")[0]}`,
    });
    res.status(status).json(body);
  };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/error-responses.test.mjs`
Expected: PASS（6 项）

- [ ] **Step 5: 提交**

```bash
git add server/errors.mjs tests/error-responses.test.mjs
git commit -m "feat: answer unexpected HTTP errors with an error code"
```

---

### Task 5: 旧失败文字迁移

**Files:**
- Create: `server/legacy-failures.mjs`
- Test: `tests/legacy-failures.test.mjs`

改版前存下的失败信息没有代码，可能含原始技术细节。启动时一次性改为「处理失败」，用 `app_settings` 里的标记保证只执行一次。

- [ ] **Step 1: 写失败测试**

```js
// tests/legacy-failures.test.mjs
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/legacy-failures.test.mjs`
Expected: FAIL，`Cannot find module '.../server/legacy-failures.mjs'`

- [ ] **Step 3: 实现**

```js
// server/legacy-failures.mjs
import { LEGACY_FAILURE, parseFailure } from "../shared/error-codes.mjs";

const MIGRATION_KEY = "legacy_failures_migrated_v1";
const legacy = (value) => typeof value === "string" && value !== "" && value !== LEGACY_FAILURE && !parseFailure(value);
const hasTable = (database, name) => Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

function rewriteColumn(database, table, column) {
  if (!hasTable(database, table)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all())
    if (legacy(row.value)) update.run(LEGACY_FAILURE, row.id);
}

function rewriteJson(database, table, column, mutate) {
  if (!hasTable(database, table)) return;
  const update = database.prepare(`UPDATE ${table} SET ${column}=? WHERE rowid=?`);
  for (const row of database.prepare(`SELECT rowid AS id, ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL`).all()) {
    let value;
    try { value = JSON.parse(row.value); } catch { continue; }
    if (!value || typeof value !== "object") continue;
    const before = JSON.stringify(value);
    mutate(value);
    const after = JSON.stringify(value);
    if (after !== before) update.run(after, row.id);
  }
}

const clean = (holder, key = "error") => { if (holder && legacy(holder[key])) holder[key] = LEGACY_FAILURE; };

export function migrateLegacyFailures(database) {
  if (!hasTable(database, "app_settings")) return false;
  if (database.prepare("SELECT 1 FROM app_settings WHERE key=?").get(MIGRATION_KEY)) return false;
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const [table, column] of [["article_sources", "error"], ["source_steps", "error"], ["conversations", "last_error"], ["image_tasks", "blocked_reason"]])
      rewriteColumn(database, table, column);
    rewriteJson(database, "image_tasks", "segmentation_json", (step) => clean(step));
    rewriteJson(database, "image_task_items", "steps_json", (steps) => { for (const step of Object.values(steps)) clean(step); });
    rewriteJson(database, "import_drafts", "draft_json", (draft) => {
      clean(draft, "chapterError");
      clean(draft.chapterProcessing);
      clean(draft.inspectionProcessing);
      for (const file of Array.isArray(draft.files) ? draft.files : []) { clean(file?.info); clean(file?.inspection); }
    });
    database.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run(MIGRATION_KEY, new Date().toISOString());
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
  return true;
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/legacy-failures.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add server/legacy-failures.mjs tests/legacy-failures.test.mjs
git commit -m "feat: replace stored legacy failure text with a neutral message"
```

---

### Task 6: 接入 app、管理员接口

**Files:**
- Create: `server/error-routes.mjs`
- Modify: `server/accounts.mjs:369`
- Modify: `server/app.mjs`（行号以 `2307a9a` 为准）
- Test: `tests/error-log-api.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/error-log-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { ensureSession, sessionHeaders } from "./helpers/session.mjs";

async function start(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-error-log-"));
  const created = createApp({ dataDir });
  const server = created.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    created.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...created, url: `http://127.0.0.1:${server.address().port}` };
}

test("管理员可以浏览、按代码查找并展开错误记录", async (t) => {
  const { url, errorLog } = await start(t);
  const { user } = await ensureSession(url);
  const code = errorLog.record(new Error("磁盘已满\nat write"), { userId: user.id, scope: "http", location: "GET /api/example" });
  const get = (path) => fetch(`${url}${path}`, { headers: sessionHeaders(url) });
  const list = await (await get("/api/admin/errors")).json();
  assert.equal(list.items[0].code, code);
  assert.equal(list.items[0].summary, "磁盘已满");
  assert.equal(list.items[0].username, "test_owner");
  const found = await (await get(`/api/admin/errors?query=${code.toLowerCase()}`)).json();
  assert.deepEqual(found.items.map((item) => item.code), [code]);
  const detail = await get(`/api/admin/errors/${code}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).location, "GET /api/example");
  assert.equal((await get("/api/admin/errors/ZZZZZZ")).status, 404);
});

test("未登录不能读取错误记录", async (t) => {
  const { url } = await start(t);
  assert.equal((await fetch(`${url}/api/admin/errors`)).status, 401);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/error-log-api.test.mjs`
Expected: FAIL，`errorLog` 为 undefined（`Cannot read properties of undefined (reading 'record')`）

- [ ] **Step 3: 新建接口文件**

```js
// server/error-routes.mjs
export function attachErrorRoutes({ app, errorLog, requireAdmin }) {
  app.get("/api/admin/errors", requireAdmin, (req, res) => {
    res.json(errorLog.list({ query: req.query.query, before: req.query.before, limit: req.query.limit }));
  });
  app.get("/api/admin/errors/:code", requireAdmin, (req, res, next) => {
    const entry = errorLog.get(req.params.code);
    if (!entry) return next(Object.assign(new Error("找不到这条错误记录。"), { status: 404, expose: true }));
    res.json(entry);
  });
}
```

- [ ] **Step 4: 导出 `requireAdmin`**

`server/accounts.mjs:369`：

```js
  return { middleware, requireUser, requireAdmin };
```

- [ ] **Step 5: 修改 `server/app.mjs`**

1. 在第 14 行 `import { createNdlOcr } from './ocr/ndl.mjs';` 之后加：

```js
import { createErrorLog, errorResponder } from "./errors.mjs";
import { migrateLegacyFailures } from "./legacy-failures.mjs";
import { attachErrorRoutes } from "./error-routes.mjs";
```

2. 第 236 行（`documents` 补列循环的 `}`）之后加：

```js
  const errorLog = createErrorLog(database);
```

3. 第 244 行 `const app = express();` 之后加：

```js
  app.locals.errorLog = errorLog;
```

4. 第 310–319 行 `attachAIRoutes({ ... })`：在 `localRuby,` 之后加一行 `errorLog,`。
5. 第 490 行改为：`const imageTasks = attachImageTaskRoutes({ app, database, ai, errorLog,`（其余参数不变）。
6. 第 495 行改为：`const sources = createSourceService({ database, ai, requireDocument, fromRow, errorLog });`
7. 第 511 行 `attachImportRoutes({ app, database, ...` 的参数对象里，在 `localOcr:sharedNdlOcr` 之前加 `errorLog,`。
8. 第 512 行（`const tasks = attachTaskRoutes(...)`）之后加：

```js
  migrateLegacyFailures(database);
  attachErrorRoutes({ app, errorLog, requireAdmin: accounts.requireAdmin });
  errorLog.prune();
  const pruneTimer = setInterval(() => errorLog.prune(), 24 * 60 * 60 * 1000);
  pruneTimer.unref();
```

9. 把第 655–678 行整个错误中间件替换为：

```js
  app.use(errorResponder({ errorLog }));
```

10. `close()` 里 `closed = true;` 之后加 `clearInterval(pruneTimer);`。
11. 返回对象（第 702–711 行）加一项 `errorLog,`。

Task 7 才会给 `attachAIRoutes`、`attachImageTaskRoutes`、`createSourceService`、`attachImportRoutes` 加 `errorLog` 参数；在那之前多传的参数会被忽略，不影响运行。

- [ ] **Step 6: 运行，确认通过**

Run: `node --test tests/error-log-api.test.mjs tests/api.test.mjs tests/accounts.test.mjs`
Expected: `error-log-api` 两项 PASS。`api`／`accounts` 中若有断言旧 5xx 文案「服务暂时遇到问题，请稍后再试。」的用例失败，记下名字，留到 Task 12 统一修改；其他失败要先查明原因。

- [ ] **Step 7: 提交**

```bash
git add server/error-routes.mjs server/accounts.mjs server/app.mjs tests/error-log-api.test.mjs
git commit -m "feat: log unexpected errors and expose them to the site owner"
```

---

### Task 7: 后台任务与对话的失败写入代码

**Files:**
- Modify: `server/ai/chat-stream.mjs`
- Modify: `server/ai/routes.mjs:50-60, 1103`
- Modify: `server/image-tasks.mjs:28, 331`
- Modify: `server/sources.mjs:36, 244, 1013-1014, 1058-1059, 1099-1100, 1124, 1219`
- Modify: `server/imports.mjs:41, 81, 93, 191, 218, 317, 329`
- Test: `tests/chat-stream-errors.test.mjs`

- [ ] **Step 1: 写失败测试（流式对话）**

```js
// tests/chat-stream-errors.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { respondToChat } from "../server/ai/chat-stream.mjs";
import { createErrorLog } from "../server/errors.mjs";
import { readEventStream } from "../shared/event-stream.mjs";
import { failureText, isErrorCode } from "../shared/error-codes.mjs";

test("流式对话失败只下发带代码的文案", async (t) => {
  const errorLog = createErrorLog(new DatabaseSync(":memory:"));
  const app = express();
  app.locals.errorLog = errorLog;
  app.post("/chat", (req, res) => respondToChat(req, res, async () => {
    throw Object.assign(new Error("upstream said: model overloaded"), {
      status: 502, expose: true, diagnostic: { code: "AI_INVALID_RESPONSE", category: "invalid_response" },
    });
  }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/chat`, { method: "POST", headers: { Accept: "text/event-stream" } });
  const events = [];
  for await (const frame of readEventStream(response.body)) events.push(JSON.parse(frame.data));
  const error = events.find((event) => event.type === "error");
  assert.ok(isErrorCode(error.errorCode));
  assert.equal(error.error, failureText(error.errorCode));
  assert.equal(error.status, 502);
  assert.equal(errorLog.get(error.errorCode).message, "upstream said: model overloaded");
  assert.equal(errorLog.get(error.errorCode).scope, "chat");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/chat-stream-errors.test.mjs`
Expected: FAIL，`error.errorCode` 为 undefined

- [ ] **Step 3: 修改 `server/ai/chat-stream.mjs`**

第 1 行之后加：

```js
import { publicErrorBody } from "../errors.mjs";
```

把第 28–31 行的 `catch` 块换成：

```js
  } catch (cause) {
    const { status, body } = publicErrorBody(cause, {
      errorLog: req.app.locals.errorLog, userId: req.user?.id ?? null, scope: "chat",
      location: `${req.method} ${req.originalUrl.split("?")[0]}`,
    });
    await emit({ type: "error", status, code: cause?.code, ...body });
  }
```

Run: `node --test tests/chat-stream-errors.test.mjs` → PASS

- [ ] **Step 4: 修改 `server/ai/routes.mjs`**

1. 在文件顶部 import 区加 `import { createErrorLog } from "../errors.mjs";`
2. `attachAIRoutes({` 参数列表里，第 58 行 `localRuby = createLocalRuby(),` 之后加：

```js
  errorLog = createErrorLog(database),
```

3. 第 1103 行改为：

```js
      if (!closed) database.prepare("UPDATE conversations SET last_error=?,updated_at=? WHERE id=? AND user_id=?").run(
        errorLog.capture(cause, { userId: req.user.id, scope: "chat", location: "chat:answer", context: { documentId: row.id, conversationId: record.id } }),
        new Date().toISOString(), record.id, req.user.id);
```

`capture` 会在 `cause` 上留下 `errorCode`，随后 `respondToChat` 或 HTTP 中间件会沿用同一个代码。

- [ ] **Step 5: 修改 `server/image-tasks.mjs`**

1. 顶部 import 区加 `import { createErrorLog } from "./errors.mjs";`
2. 第 28 行改为：

```js
export function attachImageTaskRoutes({ app, database, ai, applyResult, getAppliedDocument, validateDestination = () => ({}), runnerOptions = {}, errorLog = createErrorLog(database) }) {
```

3. 第 331 行改为：

```js
        const message = errorLog.capture(error, { userId: task.user_id, scope: "task", location: `image:${phase}`,
          context: { taskId: task.id, ...(item?.id ? { itemId: item.id } : {}) } });
```

授权失效时 `capture` 返回「AI 暂时不可用 · 错误代码 …」，`blocked_reason` 仍取 `message`，管理员在界面上会看到「去 AI 设置」。

- [ ] **Step 6: 修改 `server/sources.mjs`**

1. 顶部 import 区加 `import { createErrorLog } from "./errors.mjs";`
2. 第 36 行改为：

```js
export function createSourceService({database,ai={},requireDocument,fromRow,now=()=>Date.now(),sessionTtlMs=45000,errorLog=createErrorLog(database)}={}) {
```

3. 紧接着第 36 行之后加一行：

```js
  const failure=(error,row,step)=>errorLog.capture(error,{userId:row.user_id,scope:'source',location:`source:${step}`,context:{documentId:row.document_id,sourceId:row.source_id}});
```

4. 第 244 行改为：

```js
      const message=state==='failed'?failure(value,row,step):state==='requires_review'?'正文出现较大改动，请核对差异。':null;
```

5. 第 1013–1014 行：把 `.run(error.message||'来源处理失败，请重试。',` 改为 `.run(failure(error,row,step),`；把 `.run(error.message||'处理失败',` 改为 `.run(failure(error,row,step),`。
6. 第 1058–1059 行：两处 `.run(error.message,` 都改为 `.run(failure(error,row,step),`。
7. 第 1099 行：`.run(frozen?'stale':'failed',error.message,` 改为 `.run(frozen?'stale':'failed',failure(error,row,step),`。
   第 1100 行：`frozen?null:error.message` 改为 `frozen?null:failure(error,row,step)`。
8. 第 1124 行：`.run(error.message,` 改为 `.run(failure(error,row,localStep),`。
9. 第 1219 行：两处 `.run(error.message,` 都改为 `.run(failure(error,row,step),`。

改完执行 `grep -n "error\.message" server/sources.mjs`，预期没有输出。

- [ ] **Step 7: 修改 `server/imports.mjs`**

1. 顶部 import 区加 `import { createErrorLog } from "./errors.mjs";`
2. 第 41 行 `export function attachImportRoutes({...})` 的参数列表末尾、`}` 之前加 `,errorLog=createErrorLog(database)`。
3. 第 81 行改为：`  async function inspectFileEntry(file,{signal,onStatus,userId=null,importId=null}={}){`
4. 第 93 行改为：

```js
      file.info={...(file.info||{}),detectedType:file.type,error:errorLog.capture(error,{userId,scope:'import',location:'import:inspect',context:{importId,fileId:file.id}})};
```

5. 第 191 行改为：

```js
      draft.chapterError=errorLog.capture(error,{userId,scope:'import',location:'import:chapters',context:{importId:id}});
```

6. 第 218 行改为：`        const parsed=await inspectFileEntry(file,{userId:req.user.id,importId:id});`
   （先确认第 218 行所在的路由处理函数参数名为 `req`：`sed -n 195,218p server/imports.mjs | grep -n "(req"`；若不同，换成实际名字。）
7. 第 317 行：`await inspectFileEntry(file,{signal:controller.signal,onStatus:` 改为 `await inspectFileEntry(file,{userId:draft.userId,importId:draft.id,signal:controller.signal,onStatus:`
8. 第 329 行改为：

```js
        draft.inspectionProcessing={status:error.status===504?'timeout':'failed',error:errorLog.capture(error,{userId:draft.userId,scope:'import',location:'import:inspect',context:{importId:draft.id}})};persist(draft);
```

- [ ] **Step 8: 跑相关测试**

Run: `node --test tests/chat-stream-errors.test.mjs tests/image-tasks.test.mjs tests/sources.test.mjs tests/imports.test.mjs tests/ai-routes.test.mjs`
Expected: 新测试通过；旧用例里断言原始失败文字的会失败，在 Task 12 统一修。记下失败用例名，进入下一步。

- [ ] **Step 9: 提交**

```bash
git add server/ai/chat-stream.mjs server/ai/routes.mjs server/image-tasks.mjs server/sources.mjs server/imports.mjs tests/chat-stream-errors.test.mjs
git commit -m "feat: record background and chat failures with error codes"
```

---

### Task 8: 客户端请求层

**Files:**
- Modify: `client/api.mjs`
- Modify: `client/chat-stream.mjs:1, 5, 15`
- Modify: `client/components/Editor.jsx:19, 223`
- Modify: `client/components/UnifiedImport.jsx:2, 194`
- Test: `tests/client-api.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/client-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import api, { NETWORK_FAILURE, apiFetch } from "../client/api.mjs";

function stubFetch(t, implementation) {
  const original = globalThis.fetch;
  globalThis.fetch = implementation;
  t.after(() => { globalThis.fetch = original; });
}

test("断网时给出白话提示，不出现 Failed to fetch", async (t) => {
  stubFetch(t, async () => { throw new TypeError("Failed to fetch"); });
  await assert.rejects(api("/books"), (error) => error.message === NETWORK_FAILURE && error.network === true && error.status === 0);
  await assert.rejects(apiFetch("/api/imports"), (error) => error.message === NETWORK_FAILURE);
});

test("取消请求仍是 AbortError", async (t) => {
  stubFetch(t, async () => { throw new DOMException("aborted", "AbortError"); });
  await assert.rejects(api("/books"), (error) => error.name === "AbortError");
});

test("错误响应带上错误代码和操作", async (t) => {
  stubFetch(t, async () => new Response(JSON.stringify({ error: "AI 暂时不可用 · 错误代码 7K2QD9", errorCode: "7K2QD9", action: "ai-settings" }),
    { status: 503, headers: { "Content-Type": "application/json" } }));
  await assert.rejects(api("/x"), (error) =>
    error.message === "AI 暂时不可用 · 错误代码 7K2QD9" && error.errorCode === "7K2QD9" && error.action === "ai-settings" && error.status === 503);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/client-api.test.mjs`
Expected: FAIL，does not provide an export named 'NETWORK_FAILURE'

- [ ] **Step 3: 重写 `client/api.mjs`**

```js
export const NETWORK_FAILURE = "连不上服务器，请稍后重试。";

// fetch() rejects with TypeError when the server cannot be reached.
export async function apiFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (cause) {
    if (cause?.name === "TypeError") throw Object.assign(new Error(NETWORK_FAILURE), { status: 0, network: true });
    throw cause;
  }
}

export default async function api(path, options) {
  const response = await apiFetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return readApiResult(response);
}

export async function readApiResult(response) {
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: "服务没有返回有效结果，请稍后重试。" }));
  if (result.code === "WEBSITE_AUTH_REQUIRED")
    globalThis.window?.dispatchEvent(new Event("yohaku:session-expired"));
  if (!response.ok) throw Object.assign(new Error(result.error || "操作未成功，请重试。"), {
    status: response.status, code: result.code, errorCode: result.errorCode, action: result.action,
  });
  return result;
}
```

- [ ] **Step 4: 直接 `fetch` 的三处改用 `apiFetch`**

- `client/chat-stream.mjs` 第 1 行改为 `import { apiFetch, readApiResult } from "./api.mjs";`；第 5 行 `await fetch(` 改为 `await apiFetch(`；第 15 行改为：

```js
    if (event.type === "error") throw Object.assign(new Error(event.error || "回答中断，请重试。"), {status:event.status,code:event.code,errorCode:event.errorCode,action:event.action});
```

- `client/components/Editor.jsx` 第 19 行改为 `import api, { apiFetch } from "../api.mjs";`；第 223 行 `const response = await fetch(` 改为 `const response = await apiFetch(`。
- `client/components/UnifiedImport.jsx` 第 2 行改为 `import api, { apiFetch, readApiResult } from "../api.mjs";`；第 194 行 `await fetch("/api/imports",` 改为 `await apiFetch("/api/imports",`。

- [ ] **Step 5: 运行**

Run: `node --test tests/client-api.test.mjs tests/chat-presentation.test.mjs && npm run build`
Expected: PASS，构建成功

- [ ] **Step 6: 提交**

```bash
git add client/api.mjs client/chat-stream.mjs client/components/Editor.jsx client/components/UnifiedImport.jsx tests/client-api.test.mjs
git commit -m "feat: explain lost connections and carry error codes on the client"
```

---

### Task 9: `ErrorNotice` 组件

**Files:**
- Create: `client/error-presentation.mjs`
- Create: `client/user-context.mjs`
- Create: `client/components/ErrorNotice.mjs`
- Modify: `client/stage2.css`（末尾追加）
- Test: `tests/error-notice.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/error-notice.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorNotice from "../client/components/ErrorNotice.mjs";
import { UserContext } from "../client/user-context.mjs";
import { errorNoticeModel } from "../client/error-presentation.mjs";

const aiError = Object.assign(new Error("AI 暂时不可用 · 错误代码 7K2QD9"), { errorCode: "7K2QD9", action: "ai-settings" });

test("普通错误显示一句话和可复制的代码", () => {
  const html = renderToStaticMarkup(h(ErrorNotice, { error: "出错了，请重试 · 错误代码 7K2QD9" }));
  assert.match(html, /role="alert"/);
  assert.match(html, /出错了，请重试/);
  assert.match(html, /aria-label="复制错误代码 7K2QD9"/);
  assert.doesNotMatch(html, /去 AI 设置/);
});

test("管理员遇到 AI 授权失效时看到去 AI 设置", () => {
  const html = renderToStaticMarkup(h(UserContext.Provider, { value: { isAdmin: true } }, h(ErrorNotice, { error: aiError })));
  assert.match(html, /AI 连接已失效/);
  assert.match(html, /去 AI 设置/);
});

test("朋友只看到 AI 暂时不可用和代码", () => {
  assert.deepEqual(errorNoticeModel(aiError, { isAdmin: false }), { message: "AI 暂时不可用", code: "7K2QD9", action: null, actionLabel: null });
});

test("用户能自己解决的白话原样显示", () => {
  assert.deepEqual(errorNoticeModel(new Error("书名需要填写")), { message: "书名需要填写", code: null, action: null, actionLabel: null });
});

test("没有错误时不渲染", () => {
  assert.equal(renderToStaticMarkup(h(ErrorNotice, { error: null })), "");
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/error-notice.test.mjs`
Expected: FAIL，`Cannot find module '.../client/components/ErrorNotice.mjs'`

- [ ] **Step 3: 实现**

```js
// client/user-context.mjs
import { createContext } from "react";

export const UserContext = createContext(null);
```

```js
// client/error-presentation.mjs
import { AI_SETTINGS_ACTION, AI_UNAVAILABLE, GENERIC_FAILURE, parseFailure } from "../shared/error-codes.mjs";

export function errorNoticeModel(error, { isAdmin = false } = {}) {
  if (!error) return null;
  const text = typeof error === "string" ? error : String(error.message || "");
  const parsed = parseFailure(text);
  const code = (typeof error === "object" && error.errorCode) || parsed?.code || null;
  const action = (typeof error === "object" && error.action) || parsed?.action || null;
  if (code && action === AI_SETTINGS_ACTION && isAdmin)
    return { message: "AI 连接已失效", code, action: AI_SETTINGS_ACTION, actionLabel: "去 AI 设置" };
  if (code) return { message: action === AI_SETTINGS_ACTION ? AI_UNAVAILABLE : GENERIC_FAILURE, code, action: null, actionLabel: null };
  return { message: text || GENERIC_FAILURE, code: null, action: null, actionLabel: null };
}
```

```js
// client/components/ErrorNotice.mjs
import { createElement as h, useContext, useState } from "react";
import { UserContext } from "../user-context.mjs";
import { errorNoticeModel } from "../error-presentation.mjs";

export const OPEN_PANEL_EVENT = "yohaku:open-panel";

export default function ErrorNotice({ error, className = "" }) {
  const user = useContext(UserContext);
  const [copied, setCopied] = useState(false);
  const model = errorNoticeModel(error, { isAdmin: Boolean(user?.isAdmin) });
  if (!model) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(model.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The code stays on screen for manual copying.
    }
  };
  return h("div", { className: `error-notice ${className}`.trim(), role: "alert" },
    h("span", { className: "error-notice-message" }, model.message),
    model.code && h("button", { type: "button", className: "error-notice-code", onClick: copy, "aria-label": `复制错误代码 ${model.code}` },
      copied ? "已复制" : `错误代码 ${model.code}`),
    model.action && h("button", {
      type: "button", className: "text-button error-notice-action",
      onClick: () => window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: "settings" })),
    }, model.actionLabel));
}
```

`client/stage2.css` 末尾追加：

```css
.error-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px 12px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--rust) 30%, transparent);
  border-radius: 8px;
  background: color-mix(in srgb, var(--rust) 7%, var(--paper));
  color: var(--rust-dark);
  font-size: 13px;
}
.error-notice-code {
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  text-decoration: underline dotted;
  cursor: copy;
}
.error-notice-action { color: var(--green); }
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/error-notice.test.mjs`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add client/error-presentation.mjs client/user-context.mjs client/components/ErrorNotice.mjs client/stage2.css tests/error-notice.test.mjs
git commit -m "feat: add an error notice that shows a copyable code"
```

---

### Task 10: 管理员「错误记录」页

**Files:**
- Create: `client/components/ErrorLog.jsx`
- Modify: `client/App.jsx:1-16, 67-75, 412-413, 889-907, 957-960`，以及 `Workspace` 内新增一个 effect
- Modify: `client/stage2.css`（末尾追加）

- [ ] **Step 1: 新建页面**

```jsx
// client/components/ErrorLog.jsx
import { useEffect, useState } from "react";
import api from "../api.mjs";
import ErrorNotice from "./ErrorNotice.mjs";

export default function ErrorLog({ onClose }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [nextBefore, setNextBefore] = useState(null);
  const [open, setOpen] = useState(null);
  const [details, setDetails] = useState({});
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async ({ append = false, search = query } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (search.trim()) params.set("query", search.trim());
      if (append && nextBefore) params.set("before", nextBefore);
      const result = await api(`/admin/errors?${params}`);
      setItems((current) => (append ? [...current, ...result.items] : result.items));
      setNextBefore(result.nextBefore);
    } catch (cause) {
      setError(cause);
    } finally {
      setBusy(false);
    }
  };

  useEffect(() => { load(); }, []);

  const toggle = async (code) => {
    if (open === code) return setOpen(null);
    setOpen(code);
    if (details[code]) return;
    try {
      const entry = await api(`/admin/errors/${encodeURIComponent(code)}`);
      setDetails((current) => ({ ...current, [code]: entry }));
    } catch (cause) {
      setError(cause);
    }
  };

  return (
    <section className="stage2-page error-log" aria-label="错误记录">
      <div className="stage2-heading">
        <h1>错误记录</h1>
        <button type="button" className="button subtle" onClick={onClose}>返回</button>
      </div>
      <form className="error-log-search" onSubmit={(event) => { event.preventDefault(); load({ search: query }); }}>
        <input aria-label="错误代码" placeholder="粘贴错误代码" value={query} onChange={(event) => setQuery(event.target.value)} />
        <button type="submit" className="button secondary" disabled={busy}>查找</button>
      </form>
      <ErrorNotice error={error} />
      {!items.length && !busy && <p className="error-log-empty">没有记录</p>}
      <ol className="error-log-list">
        {items.map((item) => (
          <li key={item.code}>
            <button type="button" className="error-log-row" aria-expanded={open === item.code} onClick={() => toggle(item.code)}>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString("zh-CN")}</time>
              <code>{item.code}</code>
              <span>{item.username || "—"}</span>
              <span>{item.location || item.scope}</span>
              <span className="error-log-summary">{item.summary}</span>
            </button>
            {open === item.code && details[item.code] && (
              <div className="error-log-detail">
                <p>{details[item.code].message}</p>
                {details[item.code].stack && <pre>{details[item.code].stack}</pre>}
                <pre>{JSON.stringify(details[item.code].context, null, 2)}</pre>
              </div>
            )}
          </li>
        ))}
      </ol>
      {nextBefore && <button type="button" className="button secondary" disabled={busy} onClick={() => load({ append: true })}>更多</button>}
    </section>
  );
}
```

- [ ] **Step 2: 样式**

`client/stage2.css` 末尾追加：

```css
.error-log-search { display: flex; gap: 8px; margin: 0 0 16px; }
.error-log-search input { flex: 1; max-width: 280px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-transform: uppercase; }
.error-log-list { list-style: none; margin: 12px 0; padding: 0; border-top: 1px solid var(--line); }
.error-log-list li { border-bottom: 1px solid var(--line); }
.error-log-row {
  display: grid;
  grid-template-columns: 150px 70px 90px minmax(120px, 200px) 1fr;
  gap: 10px;
  width: 100%;
  padding: 10px 4px;
  border: 0;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.error-log-row code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.error-log-summary { overflow: hidden; color: var(--muted); text-overflow: ellipsis; white-space: nowrap; }
.error-log-detail { padding: 0 4px 14px; font-size: 13px; }
.error-log-detail pre {
  overflow: auto;
  max-height: 320px;
  padding: 10px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--line) 35%, var(--paper));
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}
.error-log-empty { color: var(--muted); }
@media (max-width: 720px) {
  .error-log-row { grid-template-columns: 1fr auto; }
  .error-log-row span { display: none; }
  .error-log-row .error-log-summary { display: block; grid-column: 1 / -1; }
}
```

- [ ] **Step 3: 接入 `client/App.jsx`**

1. import 区（第 16 行之后）加：

```jsx
import ErrorLog from "./components/ErrorLog.jsx";
import { OPEN_PANEL_EVENT } from "./components/ErrorNotice.mjs";
import { UserContext } from "./user-context.mjs";
```

2. 第 67–75 行，用 `UserContext.Provider` 包住 `Workspace`：

```jsx
  else content = (
    <UserContext.Provider value={session.user}>
      <Workspace
        key={session.user.id}
        user={session.user}
        onLoggedOut={() => {
          history.replaceState(null, "", window.location.pathname);
          setSession({ user: null, needsSetup: false });
        }}
      />
    </UserContext.Provider>
  );
```

3. 第 413 行改为：`    if (["settings", "roles", "errors"].includes(name) && !user.isAdmin) return;`
4. 在 `openPanel` 定义（第 412 行起）结束之后，加一个 effect，让 `ErrorNotice` 的「去 AI 设置」能打开面板：

```jsx
  useEffect(() => {
    const open = (event) => openPanel(event.detail);
    window.addEventListener(OPEN_PANEL_EVENT, open);
    return () => window.removeEventListener(OPEN_PANEL_EVENT, open);
  });
```

5. 第 900–906 行「角色配置」按钮之后、`</div>` 之前加：

```jsx
              <button
                className={`text-button sidebar-settings-button ${panel === "errors" ? "active" : ""}`}
                type="button" disabled={saving} onClick={() => openPanel("errors")}
              >
                <span className="ai-dot" aria-hidden="true" />
                错误记录
              </button>
```

6. 第 959–960 行 `RoleSettings` 分支之后加：

```jsx
        ) : panel === "errors" && user.isAdmin ? (
          <ErrorLog onClose={closePanel} />
```

- [ ] **Step 4: 构建并在浏览器中验证**

Run: `npm run build`
Expected: 构建成功

在内置浏览器（`yohaku-dev` 预览，桌面 1280 宽）：
1. 以管理员登录，侧栏底部出现「错误记录」，点开显示列表或「没有记录」。
2. 在浏览器控制台执行 `await fetch('/api/admin/errors').then(r => r.status)`，返回 200。
3. 让一次请求失败：执行 `await fetch('/api/documents/not-a-real-id/conversations', {method:'POST', headers:{'Content-Type':'application/json'}, body:'{}'}).then(r => r.json())`，记下返回内容。若它是 404 白话（用户能自己解决的错误），换成停掉 AI 连接后在阅读页划词提问，得到带代码的提示。
4. 把代码粘贴到错误记录页搜索框，点「查找」，展开后能看到完整信息。
5. 切到手机尺寸（375 宽），列表只显示时间、代码与摘要。
6. 截图保存到 `artifacts/step1-error-log-desktop.png`、`artifacts/step1-error-log-phone.png`。

- [ ] **Step 5: 提交**

```bash
git add client/components/ErrorLog.jsx client/App.jsx client/stage2.css
git commit -m "feat: add the site owner's error log page"
```

---

### Task 11: 移除界面上的执行详情与诊断明细

**Files:**
- Delete: `client/components/ExecutionDetails.mjs`、`tests/execution-details.test.mjs`
- Modify: `client/components/DocumentChat.jsx:10, 281`
- Modify: `client/components/ImageTasks.jsx:6, 61, 86, 235, 236, 252, 253`
- Modify: `client/components/PagedReader.jsx:4, 8-34, 148, 158`
- Modify: `tests/browser/unified-sources.e2e.mjs:380-436`

- [ ] **Step 1: 删除组件与它的单元测试**

```bash
git rm client/components/ExecutionDetails.mjs tests/execution-details.test.mjs
```

- [ ] **Step 2: `DocumentChat.jsx`**

删除第 10 行 `import ExecutionDetails from "./ExecutionDetails.mjs";` 和第 281 行整行 `{message.role === "assistant" && <ExecutionDetails ... />}`。

- [ ] **Step 3: `ImageTasks.jsx`**

- 删除第 6 行 import。
- 第 61 行改为 `    <ExecutionTiming execution={step.execution} />`（去掉后面的 `<ExecutionDetails .../>`）。
- 删除第 86 行 `<ExecutionDetails execution={task.execution} />`。
- 删除第 235 行 `<ExecutionDetails execution={task.segmentation?.execution} label="分句" />`。
- 第 236 行改为 `        {manualStep && <ExecutionTiming execution={manualStep.execution} />}`。
- 删除第 252、253 行两个 `<ExecutionDetails .../>`。

执行 `grep -n "ExecutionDetails" client -r`，预期没有输出。

- [ ] **Step 4: `PagedReader.jsx`**

- 删除第 8–34 行（`errorCategories`、`providerLabels`、`diagnosticTime`、`DiagnosticFacts`）。
- 删除第 148 行 `{diagnostics?.current && <details className="reading-diagnostics">…</details>}`。
- 删除第 158 行 `{recentFailures.length > 0 && <details className="reading-diagnostics reading-diagnostics-history">…</details>}`，并删除第 119 行 `const recentFailures = …`。
- 第 4 行 import：执行 `grep -nE "processingStepLabel|processingDuration|sourceLabel\(" client/components/PagedReader.jsx`，把不再出现的名字从 import 中删掉。

- [ ] **Step 5: 更新浏览器用例**

`tests/browser/unified-sources.e2e.mjs`：

- 第一个用例（第 380 行起）：删除第 393–396 行（点「处理详情」并断言 iliad codix、模型 id、operation-27），改为：

```js
  await expect(preparation.getByText("处理详情",{exact:true})).toHaveCount(0);
  await expect(preparation).not.toContainText("Deepseek/deepseek-v4-flash-0731");
```

- 第二个用例（第 399 行起）：删除第 415–421 行（「处理详情」、HTTP 503、UPSTREAM_HTTP_ERROR、排队／执行耗时断言），改为：

```js
  await expect(preparation.getByText("处理详情",{exact:true})).toHaveCount(0);
  await expect(preparation).not.toContainText("HTTP 503");
```

  删除第 427–433 行（「最近处理异常（1）」及其历史断言；保留第 434 行 `getByRole("alert")` 断言），改为：

```js
  await expect(page.getByText(/最近处理异常/)).toHaveCount(0);
```

  保留其余断言（准备状态、`SECRET_RAW_RESPONSE` 不出现、恢复后正文显示、截图）。

- [ ] **Step 6: 运行**

Run: `npm run build && npx playwright test -c tests/browser/sources.config.mjs -g "reading diagnostics"`
Expected: 构建成功；两个用例通过（桌面与手机项目）。若 `sources.config.mjs` 不包含此文件，用 `grep -l unified-sources tests/browser/*.config.mjs` 找到对应配置。

- [ ] **Step 7: 提交**

```bash
git add -A client/components tests/browser/unified-sources.e2e.mjs
git commit -m "refactor: stop showing provider, model and diagnostic details to readers"
```

---

### Task 12: 全量回归与旧断言更新

**Files:**
- Create: `tests/helpers/failures.mjs`
- Modify: Task 7、Task 11 之后新增失败的用例文件（以实际失败名单为准）

- [ ] **Step 1: 新建断言辅助**

```js
// tests/helpers/failures.mjs
import assert from "node:assert/strict";
import { parseFailure } from "../../shared/error-codes.mjs";

// Background failures now store "<sentence> · 错误代码 XXXXXX"; the original
// message lives in error_log.
export function assertLoggedFailure(text, { action = null } = {}) {
  const parsed = parseFailure(text);
  assert.ok(parsed, `期望带错误代码的失败文案，实际：${text}`);
  assert.equal(parsed.action, action);
  return parsed.code;
}
```

- [ ] **Step 2: 跑全量并列出新增失败**

```bash
npm test > /tmp/yohaku-test.log 2>&1; awk '/^✖ failing tests:/{exit} /^✖ /{sub(/ \([0-9.]+ms\)$/,""); print}' /tmp/yohaku-test.log | sort -u | comm -23 - artifacts/baseline-failing-tests.txt
```

- [ ] **Step 3: 逐个修正**

对每个新增失败，打开 `/tmp/yohaku-test.log` 中对应的断言位置，按下表修改，**不删除用例要验证的行为**：

| 旧断言 | 新断言 |
| --- | --- |
| `assert.equal(x.error, "<原始失败文字>")` 或 `assert.match(x.error, /原始/)`（后台任务、来源、导入、对话 `lastError`） | `assertLoggedFailure(x.error)` |
| 断言「网站 AI 授权需要恢复…」 | `assertLoggedFailure(x, { action: "ai-settings" })` |
| 断言 HTTP 5xx 的 `body.error === "服务暂时遇到问题，请稍后再试。"` | `assertLoggedFailure(body.error)` 并 `assert.equal(body.errorCode, parseFailure(body.error).code)` |
| 需要核对原始信息的用例 | 用 `createApp()` 返回的 `errorLog.get(code).message` 断言原始信息 |
| 断言 SSE 错误事件 `event.error` 为原始 AI 信息 | `assertLoggedFailure(event.error)` |

在每个改动的测试文件顶部加 `import { assertLoggedFailure } from "./helpers/failures.mjs";`（需要时再加 `import { parseFailure } from "../shared/error-codes.mjs";`）。

如果某个失败不是因为失败文案格式变化（例如逻辑真的被改坏），停下来按 superpowers:systematic-debugging 排查，不要改断言迁就。

- [ ] **Step 4: 复跑，直到没有新增失败**

再次执行 Step 2 的命令，预期输出为空。

- [ ] **Step 5: 构建与浏览器回归**

```bash
npm run build && npm run test:browser
```

Expected: 构建成功；默认 Playwright 用例（`stage1.spec.mjs`、`pwa*.spec.mjs`）通过。

- [ ] **Step 6: 在内置浏览器走一遍**

桌面 1280 与手机 375 宽各一遍，截图存到 `artifacts/step1-*.png`：
1. 首页、书籍页、阅读页正常打开，没有「执行来源」「处理详情」「最近处理异常」。
2. 断开 dev 服务器后在页面上触发一次请求，看到「连不上服务器，请稍后重试。」，没有「Failed to fetch」。重新 `preview_start`。
3. 管理员「错误记录」页能按 Task 10 Step 4 的方式查到一条记录。

- [ ] **Step 7: 提交**

```bash
git add tests
git commit -m "test: assert coded failure text instead of raw error messages"
```

---

## 完成标准

- `npm test` 相对基线没有新增失败；`npm run build` 成功；默认 Playwright 用例通过。
- 界面上不再出现提供方、模型 id、token 数、HTTP 状态、处理编号和「Failed to fetch」。
- 系统错误显示「出错了，请重试 · 错误代码 XXXXXX」，管理员能在「错误记录」页查到同一代码的完整信息；AI 授权失效时管理员看到「去 AI 设置」。
- 旧数据中的原始失败文字已替换为「处理失败」。

## 后续步骤

第 2–5 步各写一份计划，写之前先确认本步已合入：

1. `docs/superpowers/plans/…-ui-ux-step2-navigation.md`：侧栏、首页、书籍页、阅读进度表（设计文档第 2 节）；「错误记录」入口移进账号菜单。
2. `…-step3-reading.md`：阅读页（第 3 节）。
3. `…-step4-import.md`：拍照导入（第 4 节）。
4. `…-step5-tasks-settings.md`：任务、校对、AI 页合并（含 `status.lastError` 改用 `ErrorNotice`）、安装横幅（第 5 节）。
