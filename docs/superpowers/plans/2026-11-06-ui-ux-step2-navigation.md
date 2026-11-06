# UI／UX 改版第 2 步：导航、首页、书籍页与阅读进度 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 侧栏只留「＋ 添加」「任务」「书架」和账号菜单；首页以「继续阅读」开头；书籍页只有一个主按钮，文章行只显示一种状态；阅读进度带上最近打开时间，供首页和书籍页使用。

**Architecture:** 服务端已经有 `reading_positions` 表（`server/sources.mjs` 第 65 行），分页文章的翻页心跳会写入页码，打开文章时 `GET /api/documents/:id` 的 `reading` 快照也已从记录的页开始。本步把这张表交给新模块 `server/reading-positions.mjs` 管理：补上 `updated_at` 列，心跳改用它写入（带时间），新增 `PUT /api/documents/:id/reading-position` 供未分页的旧文章记录“打开过”，文章与书籍摘要带出 `readingPosition`／`lastOpenedAt`。任务是否“需要处理”由 `shared/task-attention.mjs` 统一判断：服务端用它给 `/api/tasks` 加 `counts.attention`，书籍页用它把任务映射到文章行的「准备中」「需要处理」。首页与书籍页的排序、文案放进纯函数模块 `client/library-model.mjs`，用 `node --test` 测；侧栏从 `App.jsx` 拆到 `client/components/Sidebar.jsx`。

**Tech Stack:** Node 24 内置 `node:sqlite`、Express 5、React 19、`node --test`、Playwright。

**设计文档：** `docs/superpowers/specs/2026-11-06-ui-ux-overhaul-design.md` 第 2 节；所有改到的界面按 §1.1 文案原则；§1.6「错误记录」入口移进账号菜单。

---

## 开始前

- 确认第 1 步已合入：`git log --oneline -1` 为 `bbb51d9` 或之后，工作区干净。
- **单元测试基线**（提交 `bbb51d9`，Node 24）：`npm test` 共 829 项，801 通过、26 失败。失败全部是 PDF／EPUB 用例（本机缺少 `fixtures/epub/*` 与文档运行环境），名单在 `artifacts/baseline-failing-tests.txt`（`artifacts/` 已被 `.gitignore` 忽略）。判定标准：失败名单不得超出基线。对比命令（本计划多处使用）：

```bash
npm test > /tmp/yohaku-test.log 2>&1; awk '/^✖ failing tests:/{exit} /^✖ /{sub(/ \([0-9.]+ms\)$/,""); print}' /tmp/yohaku-test.log | sort -u | comm -23 - artifacts/baseline-failing-tests.txt
```

  输出为空表示没有新增失败。

- **浏览器基线**（都需要先 `npm run build`）：
  - 默认配置 `npx playwright test`：30 项全部通过（`stage1.spec.mjs`、`pwa*.spec.mjs`，desktop + phone）。本计划新增 4 项，完成后应为 34 项全部通过。
  - `npx playwright test -c tests/browser/sources.config.mjs`：150／150 通过。
  - `npx playwright test -c tests/browser/tasks.config.mjs`：42／42 通过。
  - `playwright.ai.config.mjs`：在 main 上已有约 66 项失败（测试登录限流），**只作参考**；但不在既有失败名单里的用例不得因本计划变成失败。开始任何修改前，先保存既有失败名单：

```bash
npm run build && PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/yohaku-ai.json npx playwright test -c playwright.ai.config.mjs --reporter=json > /dev/null 2>&1; node -e '
const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const failing = new Set();
const walk = (suite, trail) => {
  for (const spec of suite.specs || [])
    for (const run of spec.tests || [])
      if (run.status === "unexpected" || run.status === "flaky")
        failing.add(`${run.projectName} › ${spec.file} › ${[...trail, spec.title].join(" › ")}`);
  for (const child of suite.suites || []) walk(child, [...trail, child.title]);
};
for (const suite of report.suites || []) walk(suite, []);
console.log([...failing].sort().join("\n"));
' /tmp/yohaku-ai.json > artifacts/ai-browser-baseline-failing.txt; wc -l artifacts/ai-browser-baseline-failing.txt
```

  预期约 66 行。名单里不含行号，所以修改测试文件不影响对比。

- **行号约定**：文中所有行号都是提交 `bbb51d9` 时的原始行号。插入或删除行会让下面的行号移动，所以同一文件内请从行号大的地方往上改，或按文中引用的原文定位。
- **已经具备、本步不重做的部分**：
  - 打开分页文章时恢复到记录的页：`computeHydratedDocument`（`server/sources.mjs` 第 753–759 行）返回的 `reading` 快照按 `reading_positions` 取页，`PagedReader` 没有 `resumePosition` 时直接用这个快照（`client/components/PagedReader.jsx` 第 15–16 行）。Task 3 用测试锁住这个行为。
  - 翻页写入：`PagedReader` 的心跳 effect 依赖页码（第 76 行），每次翻页立刻发一次 `POST /reading-session`，服务端在这次心跳里写进度（`server/sources.mjs` 第 822 行），阅读中每 8 秒再发一次。设计文档要求的“防抖”目的是不让翻页产生额外写入；本步不新增请求，写入继续搭在这次心跳上，所以不另做客户端防抖。
  - 删除级联：删除文章（`server/app.mjs` 第 620 行）和删除书籍（`server/books.mjs` 第 144 行经 `beforeDeleteDocument`）都会调用 `sources.deleteDocument`，后者删除该文章的 `reading_positions`。Task 3 改为通过新模块删除，并用测试锁住。
- **本步刻意不做的事**：
  - 账号菜单的「安装为 App」：安装事件 `beforeinstallprompt` 保存在 `client/PWAManager.jsx` 的组件状态里，而 `PWAManager` 挂在 `Workspace` 之外（登录页也要用）。要放进账号菜单，需要把事件提到共享状态，同时去掉桌面横幅（§5.4）并改 `pwa*.spec.mjs`；只做一半会让桌面同时出现横幅和菜单项。留到第 5 步与 §5.4 一起做。
  - 「AI 设置」「角色配置」合并成一个「AI」页：第 5 步。本步账号菜单里两项分开列出（仅管理员）。
  - 任务页标题「任务与导入草稿」改为「任务」：第 5 步（§5.1）。本步只改侧栏入口的文字。
  - 首页「拍照添加」直接打开相机：第 4 步。本步点它只打开现有添加页（统一导入的「上传或粘贴文件」，可选照片）。
  - `App.jsx` 顶部错误横幅改用 `ErrorNotice`：它主要承载阅读页的错误，第 3 步重做阅读页时处理。本步改到的书籍页和账号菜单里的错误显示改用 `ErrorNotice`。

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `shared/task-attention.mjs`（新） | 判断任务「需要处理」（失败、待确认、未完成草稿）或「准备中」，服务端计数与书籍页共用 |
| `server/tasks.mjs` | `/api/tasks` 的 `counts` 增加 `attention` |
| `server/reading-positions.mjs`（新） | `reading_positions` 表结构与迁移（补 `updated_at`）、读写、`PUT /api/documents/:id/reading-position` |
| `server/sources.mjs` | 心跳写进度改走 `readingPositions.save`；删除文章时 `readingPositions.remove`；新增 `pageCounts` |
| `server/books.mjs` | 书籍摘要带 `lastOpenedAt`，文章行带 `readingPosition` |
| `server/app.mjs` | 创建并注入 `readingPositions`；`readingSummaries` 合并页码与页数；文章列表带进度；挂新接口 |
| `client/library-model.mjs`（新） | 首页「继续阅读」「最近阅读」、书籍页概况、主按钮、文章行状态的纯函数 |
| `client/account-menu.mjs`（新） | 账号菜单项（管理员与普通账号） |
| `client/components/UserMenu.jsx` | 改为账号行 + 向上展开的菜单，错误用 `ErrorNotice` |
| `client/components/Sidebar.jsx`（新） | 从 `App.jsx` 拆出的侧栏（`App.jsx` 少约 160 行，侧栏结构集中一处） |
| `client/sidebar.css`（新） | 侧栏与账号菜单样式 |
| `client/main.jsx` | 引入 `sidebar.css` |
| `client/App.jsx` | 改用 `Sidebar`；首页、书籍页新属性；未分页文章打开时记录；回到首页时刷新摘要；去掉 `activeTaskCount` |
| `client/components/Welcome.jsx`、`client/welcome.css` | 首页重做（两个文件整体替换） |
| `client/components/BookView.jsx`、`client/books.css` | 书籍页重做（`books.css` 只换书籍页部分） |
| `client/styles.css`、`client/design-theme.css`、`client/accounts.css`、`client/stage2.css`、`client/image-tasks.css` | 删除被替换结构的旧样式 |
| `tests/task-attention.test.mjs`、`tests/reading-positions.test.mjs`、`tests/reading-positions-api.test.mjs`、`tests/library-model.test.mjs`、`tests/account-menu.test.mjs`（新） | 单元与接口测试 |
| `tests/tasks.test.mjs` | 新增 `counts.attention` 用例 |
| `tests/browser/navigation.mjs`（新） | 浏览器用例共用：打开抽屉、账号菜单、添加页的粘贴文字 |
| `tests/browser/stage1.spec.mjs`、`unified-sources.e2e.mjs`、`unified-tasks.e2e.mjs`、`stage2.e2e.mjs`、`stage3.e2e.mjs`、`api-base.e2e.mjs` | 新文案、新结构的选择器；`stage1.spec.mjs` 新增 2 个用例 |

细节打磨可参考已安装的 `frontend-design:frontend-design` 技能，但不改配色、字体（变量在 `client/design-theme.css`）。

---

### Task 1: 任务是否需要处理

**Files:**
- Create: `shared/task-attention.mjs`
- Modify: `server/tasks.mjs:1`、`server/tasks.mjs:71`
- Test: `tests/task-attention.test.mjs`、`tests/tasks.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/task-attention.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { taskAttention } from "../shared/task-attention.mjs";

test("失败、待确认和未完成草稿需要处理，排队与运行中算准备中", () => {
  for (const status of ["failed", "timeout", "timed_out", "needs_attention", "blocked", "error", "interrupted", "requires_review", "needs_review", "draft"])
    assert.equal(taskAttention({ status }), "attention", status);
  for (const status of ["queued", "running", "retrying", "retry_wait", "resource_wait", "waiting_resource"])
    assert.equal(taskAttention({ status }), "working", status);
  for (const status of ["completed", "dependency_wait", "paused", "cancelled", undefined])
    assert.equal(taskAttention({ status }), null, String(status));
});

test("已归档的任务不算，只有 state 时按 state 判断", () => {
  assert.equal(taskAttention({ status: "failed", archived: true }), null);
  assert.equal(taskAttention({ state: "draft" }), "attention");
  assert.equal(taskAttention(null), null);
});
```

在 `tests/tasks.test.mjs` 文件末尾追加：

```js
test('task counts report how many unarchived tasks need the reader',async t=>{
  const f=await fixture(t);
  f.add('failed');f.add('review',{status:'requires_review'});f.add('draft',{status:'draft',canDelete:false});
  f.add('running',{status:'running',canDelete:false});f.add('done',{status:'completed',archived:true,canDelete:false});
  const {status,data}=await f.request('?limit=1');
  assert.equal(status,200);
  assert.equal(data.counts.active,4);
  assert.equal(data.counts.attention,3);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/task-attention.test.mjs tests/tasks.test.mjs`
Expected: FAIL：`Cannot find module '.../shared/task-attention.mjs'`；`tasks.test.mjs` 新用例 `undefined !== 3`

- [ ] **Step 3: 实现**

```js
// shared/task-attention.mjs
// Decides whether a task needs the reader (failed, waiting for confirmation or
// an unfinished draft) or is still working by itself. The server counts the
// first kind for the sidebar and home; the book page maps both onto articles.
const attentionStatuses = new Set([
  "failed", "timeout", "timed_out", "needs_attention", "blocked", "error",
  "interrupted", "requires_review", "needs_review", "draft",
]);
const workingStatuses = new Set([
  "queued", "running", "retrying", "retry_wait", "resource_wait", "waiting_resource",
]);

export function taskAttention(task) {
  if (!task || task.archived) return null;
  const status = task.status || task.state;
  if (attentionStatuses.has(status)) return "attention";
  if (workingStatuses.has(status)) return "working";
  return null;
}
```

`server/tasks.mjs` 第 1 行之前插入：

```js
import { taskAttention } from '../shared/task-attention.mjs';
```

第 71 行

```js
    const counts={active:tasks.filter(task=>!task.archived).length,archived:tasks.filter(task=>task.archived).length};
```

改为：

```js
    const counts={active:tasks.filter(task=>!task.archived).length,archived:tasks.filter(task=>task.archived).length,
      attention:tasks.filter(task=>taskAttention(task)==='attention').length};
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/task-attention.test.mjs tests/tasks.test.mjs`
Expected: PASS（`task-attention` 2 项，`tasks.test.mjs` 全部）

- [ ] **Step 5: 提交**

```bash
git add shared/task-attention.mjs server/tasks.mjs tests/task-attention.test.mjs tests/tasks.test.mjs
git commit -m "feat: count tasks that need the reader"
```

---

### Task 2: 阅读进度模块

**Files:**
- Create: `server/reading-positions.mjs`
- Test: `tests/reading-positions.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/reading-positions.test.mjs`
Expected: FAIL，`Cannot find module '.../server/reading-positions.mjs'`

- [ ] **Step 3: 实现**

```js
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
// client records that they were opened with this route.
export function attachReadingPositionRoutes({ app, readingPositions, requireDocument }) {
  app.put("/api/documents/:id/reading-position", (req, res) => {
    requireDocument(req.user.id, req.params.id);
    const pageIndex = req.body?.pageIndex;
    if (!Number.isSafeInteger(pageIndex) || pageIndex < 0) throw fail(400, "阅读页位置无效。");
    res.json(readingPositions.save(req.user.id, req.params.id, { pageIndex }));
  });
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/reading-positions.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 5: 提交**

```bash
git add server/reading-positions.mjs tests/reading-positions.test.mjs
git commit -m "feat: add reading position store with last-opened time"
```

---

### Task 3: 阅读进度接入服务端

**Files:**
- Modify: `server/sources.mjs:10`、`:37`、`:65`、`:822`、`:1281-1289`、`:1308`
- Modify: `server/books.mjs:17`、`:55-67`、`:94`
- Modify: `server/app.mjs:17`、`:240`、`:329`、`:504-505`、`:552`、`:573`、`:697-707`
- Test: `tests/reading-positions-api.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/reading-positions-api.test.mjs`
Expected: FAIL 3 项：摘要里没有 `readingPosition`（`Cannot read properties of undefined (reading 'pageIndex')`、`undefined !== null`），PUT 返回 404

- [ ] **Step 3: `server/sources.mjs` 改用新模块**

第 10 行 `import { createErrorLog } from './errors.mjs';` 之后插入：

```js
import { createReadingPositions } from './reading-positions.mjs';
```

第 37 行签名末尾的 `errorLog=createErrorLog(database)}={}) {` 改为：

```js
errorLog=createErrorLog(database),readingPositions=createReadingPositions(database)}={}) {
```

（默认值在函数体之前执行，所以直接调用 `createSourceService` 的单元测试也会先建好新表。）

删除第 65 行（表结构改由 `server/reading-positions.mjs` 负责）：

```
    CREATE TABLE IF NOT EXISTS reading_positions(user_id TEXT NOT NULL,document_id TEXT NOT NULL,page_id TEXT,page_index INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(user_id,document_id));
```

第 822 行

```js
    if(active&&mode==='reading')database.prepare('INSERT INTO reading_positions VALUES(?,?,?,?) ON CONFLICT(user_id,document_id) DO UPDATE SET page_id=excluded.page_id,page_index=excluded.page_index').run(userId,id,snapshot.currentPage?.id||null,snapshot.index);
```

改为（表多了一列，原来按位置的 `VALUES(?,?,?,?)` 会报错）：

```js
    if(active&&mode==='reading')readingPositions.save(userId,id,{pageIndex:snapshot.index,pageId:snapshot.currentPage?.id||null});
```

第 1287 行

```js
    for(const table of ['reading_pages','reading_positions','reading_sessions','source_preparation_jobs'])database.prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`).run(userId,id);
```

改为：

```js
    for(const table of ['reading_pages','reading_sessions','source_preparation_jobs'])database.prepare(`DELETE FROM ${table} WHERE user_id=? AND document_id=?`).run(userId,id);
    readingPositions.remove(userId,id);
```

在 `deleteDocument` 函数结束的 `}`（第 1289 行）之后插入：

```js
  // Reading pages published so far per article; summaries show 第 N / M 页.
  function pageCounts(userId){return new Map(database.prepare('SELECT document_id,COUNT(*) AS count FROM reading_pages WHERE user_id=? GROUP BY document_id').all(userId).map(row=>[row.document_id,row.count]));}
```

第 1308 行返回对象中的 `deleteDocument,stop,close,drain};` 改为 `deleteDocument,pageCounts,stop,close,drain};`。

第 119、727、734、810 行读取 `page_index` 的四处查询保持不动：它们只读页码，表结构变化不影响。

- [ ] **Step 4: `server/books.mjs` 带出进度**

第 17 行签名改为：

```js
export function attachBookRoutes({ app, database, summary, readingSummaries = () => new Map(), requireDocument, beforeDeleteDocument = () => {}, beforeDeleteBook = () => {} }) {
```

第 55–67 行 `present` 整个函数替换为：

```js
  function present(book, includePages = false, reading = readingSummaries(book.owner_id)) {
    const summaries = pages(book).map((row) => ({ ...summary(row), readingPosition: reading.get(row.id) || null }));
    // A book was last opened when any of its articles was.
    const lastOpenedAt = summaries.reduce((latest, page) => {
      const openedAt = page.readingPosition?.updatedAt;
      return openedAt && (!latest || openedAt > latest) ? openedAt : latest;
    }, null);
    return {
      id: book.id, title: book.title, revision: book.revision,
      createdAt: book.created_at, updatedAt: book.updated_at,
      pageCount: summaries.length,
      articleCount: summaries.length,
      charCount: summaries.reduce((count, page) => count + page.charCount, 0),
      rubyCount: summaries.reduce((count, page) => count + page.rubyCount, 0),
      preview: summaries.find((page) => page.preview)?.preview || "",
      lastOpenedAt,
      ...(includePages ? { pages: summaries, articles: summaries } : {}),
    };
  }
```

第 94 行

```js
    res.json({ books: books.map((book) => present(book)) });
```

改为：

```js
    const reading = readingSummaries(req.user.id);
    res.json({ books: books.map((book) => present(book, false, reading)) });
```

- [ ] **Step 5: `server/app.mjs` 接线**

第 17 行之后插入：

```js
import { attachReadingPositionRoutes, createReadingPositions } from "./reading-positions.mjs";
```

第 240 行 `const errorLog = createErrorLog(database);` 之后插入：

```js
  const readingPositions = createReadingPositions(database);
```

第 329 行 `const books = attachBookRoutes({ app, database, summary, requireDocument,` 改为：

```js
  const books = attachBookRoutes({ app, database, summary, readingSummaries, requireDocument,
```

第 504–505 行改为：

```js
  const sources = createSourceService({ database, ai, requireDocument, fromRow, errorLog, readingPositions });
  sources.attachRoutes(app);
  attachReadingPositionRoutes({ app, readingPositions, requireDocument });
```

第 552 行 `app.get("/api/documents", (req, res) => {` 之前插入（函数声明会提升，第 329 行传给书籍路由时可以先引用；它只在请求时调用，那时 `sources` 已创建）：

```js
  // Reading progress for summaries: the saved page plus how many reading pages
  // the article has so far (0 for articles outside the source workflow).
  function readingSummaries(userId) {
    const counts = sources.pageCounts(userId);
    const summaries = new Map();
    for (const [documentId, position] of readingPositions.forUser(userId))
      summaries.set(documentId, { ...position, pageCount: counts.get(documentId) || 0 });
    return summaries;
  }

```

第 573 行

```js
    res.json({ documents: rows.map(summary) });
```

改为：

```js
    const reading = readingSummaries(req.user.id);
    res.json({ documents: rows.map((row) => ({ ...summary(row), readingPosition: reading.get(row.id) || null })) });
```

第 703 行返回对象的 `sources,` 之后加一行 `readingPositions,`。

- [ ] **Step 6: 运行，确认通过**

Run: `node --test tests/reading-positions-api.test.mjs tests/reading-positions.test.mjs tests/books.test.mjs tests/source-workflow-api.test.mjs tests/sources.test.mjs tests/api.test.mjs`
Expected: PASS（这些文件中没有基线失败项）

- [ ] **Step 7: 跑全量对比**

Run: 开始前的对比命令
Expected: 输出为空

- [ ] **Step 8: 提交**

```bash
git add server/sources.mjs server/books.mjs server/app.mjs tests/reading-positions-api.test.mjs
git commit -m "feat: expose reading progress in document and book summaries"
```

---

### Task 4: 首页与书籍页的数据辅助

**Files:**
- Create: `client/library-model.mjs`
- Test: `tests/library-model.test.mjs`

- [ ] **Step 1: 写失败测试**

```js
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
  assert.deepEqual(bookResume(book), { page: book.pages[1], label: "继续阅读 · 第二篇" });
  const unread = { pages: book.pages.map((page) => ({ ...page, readingPosition: null })) };
  assert.deepEqual(bookResume(unread), { page: unread.pages[0], label: "开始阅读" });
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
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/library-model.test.mjs`
Expected: FAIL，`Cannot find module '.../client/library-model.mjs'`

- [ ] **Step 3: 实现**

```js
// client/library-model.mjs
// Pure helpers for the home page and the book page. Inputs are the summaries
// from /api/documents, /api/books and /api/books/:id; readingPosition is
// { pageIndex, pageCount, updatedAt } (see server/reading-positions.mjs).
import { taskAttention } from "../shared/task-attention.mjs";

// ISO timestamps sort correctly as strings.
const newestFirst = (a, b) => (a < b ? 1 : a > b ? -1 : 0);
const openedAt = (item) => item?.readingPosition?.updatedAt || null;
const characters = (count) => `${(count || 0).toLocaleString("zh-CN")} 字`;

// Articles outside the source workflow have no reading pages (pageCount 0).
export function pageProgress(position) {
  if (!position || !(position.pageCount > 0)) return null;
  const page = Math.min(position.pageIndex + 1, position.pageCount);
  return { page, total: position.pageCount, label: `第 ${page} / ${position.pageCount} 页`,
    percent: Math.round((page / position.pageCount) * 100) };
}

// The most recently opened article; the newest one when nothing was read yet.
export function continueReading(documents = [], books = []) {
  const opened = documents.filter(openedAt).sort((a, b) => newestFirst(openedAt(a), openedAt(b)));
  const document = opened[0] || [...documents].sort((a, b) => newestFirst(a.createdAt, b.createdAt))[0];
  if (!document) return null;
  const resumed = opened.length > 0;
  return {
    document,
    book: document.bookId ? books.find((book) => book.id === document.bookId) || null : null,
    resumed,
    progress: resumed ? pageProgress(document.readingPosition) : null,
  };
}

// Books and standalone articles by last opened; never opened ones follow by update time.
export function recentEntries(books = [], documents = [], limit = 6) {
  return [
    ...books.map((item) => ({ ...item, entryType: "book", openedAt: item.lastOpenedAt || null })),
    ...documents.map((item) => ({ ...item, entryType: "document", openedAt: openedAt(item) })),
  ]
    .sort((a, b) => Number(!a.openedAt) - Number(!b.openedAt)
      || newestFirst(a.openedAt, b.openedAt)
      || newestFirst(a.updatedAt, b.updatedAt))
    .slice(0, limit);
}

export function bookFacts(book) {
  const pages = book.pages || [];
  const count = book.pages ? pages.length : book.pageCount || 0;
  const total = book.charCount ?? pages.reduce((sum, page) => sum + (page.charCount || 0), 0);
  return `${count} 篇 · ${characters(total)}`;
}

export function bookResume(book) {
  const pages = book.pages || [];
  const opened = pages.filter(openedAt).sort((a, b) => newestFirst(openedAt(a), openedAt(b)))[0];
  if (opened) return { page: opened, label: `继续阅读 · ${opened.title}` };
  return pages[0] ? { page: pages[0], label: "开始阅读" } : null;
}

// documentId -> "attention" | "working"; a task that needs the reader wins.
export function documentTaskStates(tasks = []) {
  const states = new Map();
  for (const task of tasks || []) {
    const state = taskAttention(task);
    if (!state || !task.documentId) continue;
    if (state === "attention" || !states.has(task.documentId)) states.set(task.documentId, state);
  }
  return states;
}

export function articleRowState(page, taskState = null) {
  if (taskState === "attention") return { kind: "attention", label: "需要处理" };
  if (taskState === "working") return { kind: "working", label: "准备中" };
  const progress = pageProgress(page.readingPosition);
  if (progress) return { kind: "position", label: `读到第 ${progress.page} 页` };
  return { kind: "length", label: characters(page.charCount) };
}
```

- [ ] **Step 4: 运行，确认通过**

Run: `node --test tests/library-model.test.mjs`
Expected: PASS（5 项）

- [ ] **Step 5: 提交**

```bash
git add client/library-model.mjs tests/library-model.test.mjs
git commit -m "feat: add home and book page view models"
```

---

### Task 5: 账号菜单（含「错误记录」入口）

**Files:**
- Create: `client/account-menu.mjs`、`client/sidebar.css`、`tests/browser/navigation.mjs`
- Modify: `client/components/UserMenu.jsx`（整体替换）、`client/App.jsx:898-931`、`client/main.jsx:12`
- Modify（删旧样式）: `client/styles.css:354-374`、`client/design-theme.css:77-78`、`:180-196`、`client/accounts.css:142-189`、`client/stage2.css:836`
- Test: `tests/account-menu.test.mjs`、`tests/browser/stage1.spec.mjs`（新用例）、`tests/browser/stage2.e2e.mjs`、`tests/browser/api-base.e2e.mjs`

- [ ] **Step 1: 写失败测试**

```js
// tests/account-menu.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { accountMenuItems, isAdminUser } from "../client/account-menu.mjs";

test("管理员菜单依次为 AI 设置、角色配置、错误记录、邀请朋友、退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: true }).map((item) => item.label),
    ["AI 设置", "角色配置", "错误记录", "邀请朋友", "退出"]);
  assert.deepEqual(accountMenuItems({ role: "admin" }).filter((item) => item.panel).map((item) => item.panel),
    ["settings", "roles", "errors"]);
});

test("普通账号只有退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: false }).map((item) => item.label), ["退出"]);
  assert.deepEqual(accountMenuItems(null).map((item) => item.label), ["退出"]);
  assert.equal(isAdminUser({ role: "member" }), false);
});
```

- [ ] **Step 2: 运行，确认失败**

Run: `node --test tests/account-menu.test.mjs`
Expected: FAIL，`Cannot find module '.../client/account-menu.mjs'`

- [ ] **Step 3: 实现菜单项**

```js
// client/account-menu.mjs
// Items of the account menu at the bottom of the sidebar, in display order.
// AI 设置 and 角色配置 stay separate until step 5 merges them into one AI page.
export const isAdminUser = (user) => user?.role === "admin" || user?.isAdmin === true;

export function accountMenuItems(user) {
  return [
    ...(isAdminUser(user) ? [
      { id: "settings", label: "AI 设置", panel: "settings" },
      { id: "roles", label: "角色配置", panel: "roles" },
      { id: "errors", label: "错误记录", panel: "errors" },
      { id: "invite", label: "邀请朋友" },
    ] : []),
    { id: "logout", label: "退出" },
  ];
}
```

Run: `node --test tests/account-menu.test.mjs`
Expected: PASS（2 项）

- [ ] **Step 4: 替换 `client/components/UserMenu.jsx`**

```jsx
import { Fragment, useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import { accountMenuItems, isAdminUser } from "../account-menu.mjs";

// The account row at the bottom of the sidebar. Admin pages, invitations and
// logout open from a menu that unfolds upward over the shelf.
export default function UserMenu({ user, onLoggedOut, onBeforeLogout, onOpenPanel, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [invitation, setInvitation] = useState(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  const tokenInput = useRef(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const admin = isAdminUser(user);
  useEffect(() => {
    setOpen(false);
    setInvitation(null);
    setCopied(false);
    setError(null);
  }, [user?.id, user?.username]);
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) setOpen(false);
    };
    window.document.addEventListener("pointerdown", outside);
    return () => window.document.removeEventListener("pointerdown", outside);
  }, [open]);

  const perform = async (action, operation) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause);
    } finally {
      pending.current = false;
      setBusy("");
    }
  };
  const logout = () =>
    perform("logout", async () => {
      if (onBeforeLogout && (await onBeforeLogout()) === false) return;
      await api("/session/logout", { method: "POST", body: "{}" });
      setInvitation(null);
      setOpen(false);
      onLoggedOut();
    });
  const invite = () =>
    perform("invite", async () => {
      const result = await api("/invitations", { method: "POST", body: "{}" });
      if (!result || typeof result.token !== "string" || !result.token)
        throw new Error("邀请码未生成，请重试。");
      setInvitation(result);
      setCopied(false);
    });
  const copy = async () => {
    if (!invitation || busy) return;
    setError(null);
    setCopied(false);
    if (!navigator.clipboard?.writeText) {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setError("当前浏览器不支持自动复制，请选中邀请码手动复制。");
      return;
    }
    try {
      await navigator.clipboard.writeText(invitation.token);
      setCopied(true);
    } catch {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setError("未能复制，请选中邀请码手动复制。");
    }
  };
  const choose = (item) => {
    if (item.id === "invite") return invite();
    if (item.id === "logout") return logout();
    setOpen(false);
    onOpenPanel?.(item.panel);
  };
  const expiryValue =
    typeof invitation?.expiresAt === "number" && invitation.expiresAt < 1e12
      ? invitation.expiresAt * 1000
      : invitation?.expiresAt;
  const expiry = expiryValue ? new Date(expiryValue) : null;

  if (!user) return null;
  return (
    <section className="account-user-menu" aria-label="当前网站账号" ref={root}
      onKeyDown={(event) => {
        if (event.key !== "Escape" || !open) return;
        event.stopPropagation();
        setOpen(false);
        trigger.current?.focus();
      }}>
      {open && (
        <div className="account-menu-panel" id="account-menu">
          {accountMenuItems(user).map((item) => (
            <Fragment key={item.id}>
              <button type="button" className={`account-menu-item${item.id === "logout" ? " is-logout" : ""}`}
                disabled={!!busy || (disabled && !!item.panel)} onClick={() => choose(item)}>
                {item.id === "invite" && busy === "invite" ? "正在生成…"
                  : item.id === "logout" && busy === "logout" ? "正在退出…" : item.label}
              </button>
              {item.id === "invite" && invitation && (
                <div className="user-menu-invitation">
                  <label>
                    邀请码
                    <input aria-label="新生成的邀请码" ref={tokenInput} value={invitation.token} readOnly
                      spellCheck={false} onFocus={(event) => event.target.select()} />
                  </label>
                  <div className="invite-copy-row">
                    {expiry && !Number.isNaN(expiry.getTime()) && (
                      <small>有效至 {expiry.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</small>
                    )}
                    <button className="text-button" type="button" disabled={!!busy} onClick={copy}>
                      {copied ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          ))}
          {error && <ErrorNotice error={error} />}
        </div>
      )}
      <button ref={trigger} type="button" className="account-trigger"
        aria-label={`账号菜单（${user.username}）`} aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        onClick={() => setOpen((value) => !value)}>
        <span className="account-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="account-name">
          <strong title={user.username}>{user.username}</strong>
          {admin && <small>管理员</small>}
        </span>
        <Icon name="more" size={16} />
      </button>
    </section>
  );
}
```

用户名只在账号行出现一次（`stage2.e2e.mjs` 用 `menu.getByText(username)` 定位，菜单里再出现一次会触发 strict mode）。删掉原来的说明「朋友注册后，保存自己的资料，并使用网站共享的 AI。」和「仅向你想邀请的人提供」（§1.1）。

- [ ] **Step 5: `App.jsx` 去掉管理员按钮行**

第 898–931 行（`<div className="sidebar-footer">` 到它的 `</div>`，包括 `sidebar-admin-row` 和原 `UserMenu`）替换为：

```jsx
        <div className="sidebar-footer">
          <UserMenu user={user} disabled={saving} onOpenPanel={openPanel}
            onBeforeLogout={mayLeave} onLoggedOut={onLoggedOut} />
        </div>
```

`openPanel` 已经拦截非管理员打开 `settings`／`roles`／`errors`（第 418 行），不用再改。

- [ ] **Step 6: 新建 `client/sidebar.css` 并引入**

```css
/* Sidebar layer for UI step 2. design-theme.css keeps the colors of the dark
   bookshelf; this file adds the account menu (and, in Task 6, the top of the
   sidebar). */

/* Account row and its menu, which unfolds upward over the shelf. */
.sidebar .account-user-menu {
  position: relative;
  min-width: 0;
  padding-top: 10px;
  border-top: 1px solid #ffffff24;
}
.account-trigger {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 44px;
  padding: 6px 8px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #e4e5d8;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.account-trigger:hover,
.account-trigger[aria-expanded="true"] {
  background: #ffffff12;
}
.account-avatar {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: #efdec0;
  color: var(--ink);
  font-size: 12px;
  font-weight: 600;
}
.account-name {
  flex: 1;
  min-width: 0;
}
.account-name strong {
  display: block;
  overflow: hidden;
  color: #fbf4e6;
  font-size: 13px;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account-name small {
  display: block;
  color: #bacdbb;
  font-size: 10px;
}
.account-menu-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 6px);
  left: 0;
  z-index: 5;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 6px;
  border: 1px solid #496358;
  border-radius: 8px;
  background: var(--green-dark);
  box-shadow: 0 12px 28px #0b1a1766;
}
.account-menu-item {
  width: 100%;
  min-height: 36px;
  padding: 8px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: #e4e5d8;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.account-menu-item:hover:not(:disabled) {
  background: #ffffff14;
  color: #fbf4e6;
}
.account-menu-item:disabled {
  opacity: 0.55;
  cursor: default;
}
.account-menu-item.is-logout {
  margin-top: 4px;
  border-top: 1px solid #ffffff1f;
  border-radius: 0 0 5px 5px;
}
.account-menu-panel .user-menu-invitation {
  margin: 2px 4px 6px;
}
.account-menu-panel .error-notice {
  margin: 4px;
}
```

`client/main.jsx` 第 12 行 `import "./document-chat.css";` 之后加：

```js
import "./sidebar.css";
```

- [ ] **Step 7: 删除被替换的旧样式**

1. `client/styles.css` 删除第 354–374 行（`.sidebar-admin-row`、`.sidebar-settings-button`、`.ai-dot`、`.ai-dot.connected` 四个块）。
2. `client/stage2.css` 删除第 836 行 `.sidebar-admin-row { flex-wrap: wrap; }`。
3. `client/design-theme.css` 先删除第 180–196 行（`.sidebar .account-user-menu, .sidebar .sidebar-admin-row`、`.sidebar .user-menu-header small`、`.sidebar .ai-dot`、`.sidebar .ai-dot.connected`、`.sidebar .user-menu-error` 五个块，保留第 197 行起的 `.sidebar .user-menu-invitation`），再把第 77–78 行

```css
.sidebar .document-link strong,
.sidebar .user-menu-header strong {
```

   改为

```css
.sidebar .document-link strong {
```

4. `client/accounts.css` 删除第 142–189 行（`.account-user-menu` 到 `.user-menu-admin > button`），保留第 190 行起的 `.user-menu-invitation`。

Run: `grep -rn "sidebar-admin-row\|sidebar-settings-button\|ai-dot\|user-menu-header\|user-menu-admin\|user-menu-error" client`
Expected: 无输出

- [ ] **Step 8: 浏览器用例共用辅助**

```js
// tests/browser/navigation.mjs
// Sidebar helpers shared by the browser suites. On phones the sidebar is a
// drawer that must be opened first; the backdrop button exists only while it is open.
import { expect } from "@playwright/test";

export async function openShelf(page) {
  const toggle = page.getByRole("button", { name: "打开书架", exact: true });
  if (!(await toggle.isVisible())) return;
  if (await page.getByRole("button", { name: "关闭书架", exact: true }).isVisible()) return;
  await toggle.click();
}

export async function openAccountMenu(page) {
  await openShelf(page);
  const trigger = page.getByRole("button", { name: /^账号菜单/ });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
}
```

- [ ] **Step 9: 更新选择器**

`tests/browser/stage2.e2e.mjs`（AI 配置）：

- 第 11 行之后插入 `import { openAccountMenu } from "./navigation.mjs";`
- 第 166–173 行（打开抽屉的 `if` 块和 `await page.getByRole("button", { name: "AI 设置", exact: true }).click();`）替换为：

```js
  await openAccountMenu(page);
  await page.getByRole("button", { name: "AI 设置", exact: true }).click();
```

- 第 1594–1596 行

```js
    await menu
      .getByRole("button", { name: "生成朋友的邀请码", exact: true })
      .click();
```

  替换为：

```js
    await openAccountMenu(page);
    await menu.getByRole("button", { name: "邀请朋友", exact: true }).click();
```

- 第 1639–1641 行

```js
    await expect(
      menu.getByRole("button", { name: "生成朋友的邀请码", exact: true }),
    ).toHaveCount(0);
```

  替换为（先展开菜单，下一行「AI 设置」为 0 的断言才有意义；第 1657 行的「退出」也就在已展开的菜单里）：

```js
    await openAccountMenu(page);
    await expect(menu.getByRole("button", { name: "邀请朋友", exact: true })).toHaveCount(0);
```

`tests/browser/api-base.e2e.mjs`（AI 配置）：

- 第 5 行之后插入 `import { openAccountMenu } from "./navigation.mjs";`
- 第 30–34 行 `open` 改为：

```js
  const open = async (name) => {
    await openAccountMenu(page);
    await page.getByRole("button", { name, exact: true }).click();
  };
```

- 第 171–175 行 `openRoles` 改为：

```js
  const openRoles = async () => {
    await openAccountMenu(page);
    await page.getByRole("button", { name: "角色配置", exact: true }).click();
  };
```

`tests/browser/stage1.spec.mjs`（默认配置）新增用例：第 2 行之后插入 `import { openAccountMenu } from "./navigation.mjs";`，文件末尾追加：

```js
test("账号菜单收纳管理员入口，错误记录从菜单打开", async ({ page }) => {
  await page.goto("/");
  await openAccountMenu(page);
  const menu = page.getByRole("region", { name: "当前网站账号", exact: true });
  for (const name of ["AI 设置", "角色配置", "错误记录", "邀请朋友", "退出"])
    await expect(menu.getByRole("button", { name, exact: true })).toBeVisible();
  await page.screenshot({ path: `artifacts/step2-account-menu-${test.info().project.name}.png`, animations: "disabled" });
  await menu.getByRole("button", { name: "错误记录", exact: true }).click();
  await expect(page.getByRole("heading", { name: "错误记录", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "退出", exact: true })).toHaveCount(0);
});
```

- [ ] **Step 10: 运行**

```bash
npm test > /tmp/yohaku-test.log 2>&1; awk '/^✖ failing tests:/{exit} /^✖ /{sub(/ \([0-9.]+ms\)$/,""); print}' /tmp/yohaku-test.log | sort -u | comm -23 - artifacts/baseline-failing-tests.txt
npm run build && npx playwright test
```

Expected: 对比输出为空；构建成功；默认配置 32 项通过（原 30 项 + 新用例 2 项）。

- [ ] **Step 11: 提交**

```bash
git add client/account-menu.mjs client/components/UserMenu.jsx client/App.jsx client/sidebar.css client/main.jsx \
  client/styles.css client/design-theme.css client/accounts.css client/stage2.css \
  tests/account-menu.test.mjs tests/browser/navigation.mjs tests/browser/stage1.spec.mjs tests/browser/stage2.e2e.mjs tests/browser/api-base.e2e.mjs
git commit -m "feat: move admin entries into the account menu"
```

---

### Task 6: 侧栏：添加、任务、书架

**Files:**
- Create: `client/components/Sidebar.jsx`
- Modify: `client/App.jsx:5`、`:25`、`:388-389`、`:770-932`
- Modify: `client/sidebar.css`（追加）
- Modify（删旧样式）: `client/styles.css:148-157`、`:244-248`、`client/image-tasks.css:56-57`
- Test: `tests/browser/navigation.mjs`、`tests/browser/stage1.spec.mjs`、`tests/browser/unified-sources.e2e.mjs`、`tests/browser/unified-tasks.e2e.mjs`、`tests/browser/stage3.e2e.mjs`

这一步没有新的纯逻辑，靠浏览器用例验证；先改用例（会失败），再改界面。

- [ ] **Step 1: 浏览器辅助追加「添加 → 粘贴文字」**

`tests/browser/navigation.mjs` 末尾追加：

```js
export async function openAddText(page) {
  await openShelf(page);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("tab", { name: "粘贴文字", exact: true }).click();
}
```

- [ ] **Step 2: 更新选择器**

`tests/browser/stage1.spec.mjs`（默认配置）：第 3 行（Task 5 加的 import）改为 `import { openAccountMenu, openAddText } from "./navigation.mjs";`，然后：

| 原行 | 原文 | 改为 |
| --- | --- | --- |
| 44–49 | 打开抽屉的 `if` 块 + `.getByRole("button", { name: "导入文字", exact: true }).click()` | `  await openAddText(page);` |
| 166–167 | `if(...打开书架...)...click();` + `await page.getByRole("button",{name:"导入文字",exact:true}).click();` | `  await openAddText(page);` |
| 172–173 | `if(...打开书架...)...click();` + `await page.getByRole("button",{name:"导入文字",exact:true}).click();`（与 166–167 行相同的写法） | `  await openAddText(page);` |

第 427 行「新建书籍」保持不变：书架标题旁的「＋」以 `aria-label="新建书籍"` 提供同名按钮。

`tests/browser/unified-sources.e2e.mjs`（sources 配置）：

- 全文把 `{name:"导入资料",exact:true}` 换成 `{name:"添加",exact:true}`（第 10、1121、1145、1191、1213、1247、1352、1373、1400、1413、1421、1444、1485、1543、1551、1567、1594、1616、1655 行）：

```bash
sed -i 's/{name:"导入资料",exact:true}/{name:"添加",exact:true}/g' tests/browser/unified-sources.e2e.mjs
grep -c '{name:"导入资料",exact:true}' tests/browser/unified-sources.e2e.mjs
```

  Expected: `0`（第 21 行草稿标题 `title:"导入文字"` 是模拟数据，不改）

- 第 673 行 `await page.getByRole("button",{name:"导入文字",exact:true}).click();` 改为：

```js
  await page.getByRole("button",{name:"添加",exact:true}).click();await page.getByRole("tab",{name:"粘贴文字",exact:true}).click();
```

`tests/browser/unified-tasks.e2e.mjs`（tasks 配置；模拟的 `counts` 为 `{active:0,archived:0}`，没有待处理数字，按钮名正好是「任务」）：

- 第 115 行 `{name:"任务与导入草稿",exact:true}` 改为 `{name:"任务",exact:true}`
- 第 116 行同样改为 `{name:"任务",exact:true}`
- 第 113 行任务页标题「任务与导入草稿」不改（第 5 步）

`tests/browser/stage3.e2e.mjs`（AI 配置）：

- 第 8 行之后插入 `import { openAddText } from "./navigation.mjs";`
- 第 27–29 行（`const shelf = …`、`if (await shelf.isVisible()) …`、点「导入文字」）替换为 `  await openAddText(page);`
- 第 556–558 行同样替换为 `    await openAddText(page);`

  这两处之后填写「材料标题」「日语正文」的步骤属于旧编辑器流程，提交 `bbb51d9` 上本来就失败（应在 AI 既有失败名单内），本步只换入口，不扩大修改。

- [ ] **Step 3: 运行，确认失败**

Run: `npm run build && npx playwright test -c tests/browser/tasks.config.mjs -g "unified task entry"`
Expected: FAIL，找不到名为「任务」的按钮

- [ ] **Step 4: 新建 `client/components/Sidebar.jsx`**

```jsx
import Icon from "./Icon.jsx";
import UserMenu from "./UserMenu.jsx";
import { kinds } from "../constants.mjs";

// The bookshelf column: add, tasks, the shelf with search, and the account
// menu. On phones the same column opens as a drawer.
export default function Sidebar({
  user, open, onClose, collapseButtonRef, onCollapse,
  saving, bookBusy, activeId, activeBookId,
  shelfBooks, documents, loading, query, onQueryChange, taskCount = 0,
  onHome, onAdd, onNewBook, onTasks, onOpenBook, onOpenDocument, onOpenPanel,
  onBeforeLogout, onLoggedOut,
}) {
  const onTasksPage = activeId === "tasks" || activeId.startsWith("tasks/");
  return (
    <>
      {open && <button className="sidebar-backdrop" onClick={onClose} aria-label="关闭书架" />}
      <aside id="bookshelf" className={`sidebar ${open ? "is-open" : ""}`} aria-label="书架">
        <button ref={collapseButtonRef} className="icon-button desktop-sidebar-collapse"
          type="button" aria-label="收起书架" aria-controls="bookshelf" aria-expanded="true"
          onClick={onCollapse}>
          <Icon name="panel-close" size={18} />
        </button>
        <a className="brand" href="#" onClick={(event) => { event.preventDefault(); onHome(); }}>
          <span className="brand-mark">余</span>
          <span className="brand-copy">
            <span className="brand-title-row">
              <strong>余白</strong>
              <span className="brand-en">YOHAKU</span>
            </span>
            <small>多语阅读与笔记</small>
          </span>
        </a>
        <div className="sidebar-actions">
          <button className="button primary sidebar-primary-action" type="button" disabled={saving} onClick={onAdd}>
            <Icon name="plus" size={16} />添加
          </button>
          <button className={`sidebar-task-link ${onTasksPage ? "active" : ""}`} type="button"
            aria-current={onTasksPage ? "page" : undefined} disabled={saving || bookBusy} onClick={onTasks}>
            <Icon name="menu" size={16} />
            <span>任务</span>
            {taskCount > 0 && <span className="count">{taskCount}</span>}
          </button>
        </div>
        <div className="shelf-heading">
          <h2>书架</h2>
          <button className="icon-button shelf-new-book" type="button" aria-label="新建书籍" title="新建书籍"
            disabled={saving || bookBusy} onClick={onNewBook}>
            <Icon name="plus" size={15} />
          </button>
        </div>
        <label className="search-box">
          <Icon name="search" size={15} />
          <input aria-label="搜索书架" placeholder="搜索标题或正文" value={query}
            onChange={(event) => onQueryChange(event.target.value)} maxLength={200} />
        </label>
        <nav className="document-list" aria-label="阅读材料">
          {loading && <p className="shelf-empty">正在打开书架…</p>}
          {!loading && documents.length === 0 && shelfBooks.length === 0 && (
            <p className="shelf-empty">{query ? "没有找到匹配的材料。" : "还没有材料。"}</p>
          )}
          {shelfBooks.map((item) => (
            <button className={`document-link ${item.id === activeBookId ? "active" : ""}`} key={`book-${item.id}`}
              type="button" disabled={saving || bookBusy} onClick={() => onOpenBook(item.id)}>
              <span className="document-link-top">
                <span className="kind-dot book" />书籍
                <span>{item.pageCount} 篇 · {item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview?.replace(/\n/g, " ") || "还没有文章"}</small>
            </button>
          ))}
          {documents.map((item) => (
            <button className={`document-link ${item.id === activeId ? "active" : ""}`} key={item.id}
              type="button" disabled={saving} onClick={() => onOpenDocument(item.id)}>
              <span className="document-link-top">
                <span className={`kind-dot ${item.kind}`} />
                {kinds[item.kind]}
                <span>{item.charCount} 字</span>
              </span>
              <strong>{item.title}</strong>
              <small lang="ja">{item.preview?.replace(/\n/g, " ")}</small>
            </button>
          ))}
        </nav>
        <div className="sidebar-footer">
          <UserMenu user={user} disabled={saving} onOpenPanel={onOpenPanel}
            onBeforeLogout={onBeforeLogout} onLoggedOut={onLoggedOut} />
        </div>
      </aside>
    </>
  );
}
```

「任务」的数字是 `counts.attention`（需要你处理的任务数），与首页「N 个导入需要你处理」一致；为 0 时不显示，按钮名就是「任务」。

- [ ] **Step 5: `App.jsx` 改用 `Sidebar`**

1. 删除第 5 行 `import { kinds } from "./constants.mjs";`。
2. 第 25 行 `import UserMenu from "./components/UserMenu.jsx";` 改为 `import Sidebar from "./components/Sidebar.jsx";`。
3. 第 388–389 行 `mayLeave` 定义之后插入：

```js
  const goHome = () => {
    if (!mayLeave()) return;
    setActiveId("");
    setPanel(null);
    setDraft(null);
    setDirty(false);
    history.replaceState(null, "", window.location.pathname);
    setSidebarOpen(false);
  };
```

4. 从第 770 行 `{sidebarOpen && (` 到第 932 行 `</aside>`（含 Task 5 改过的 `sidebar-footer`）整段替换为：

```jsx
      <Sidebar
        user={user} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        collapseButtonRef={sidebarCollapseButton} onCollapse={toggleDesktopSidebar}
        saving={saving} bookBusy={bookBusy} activeId={activeId} activeBookId={book?.id}
        shelfBooks={shelfBooks} documents={documents} loading={loading}
        query={query} onQueryChange={setQuery} taskCount={taskCounts.attention ?? 0}
        onHome={goHome} onAdd={() => openUnifiedImport()} onNewBook={() => openPanel("newBook")}
        onTasks={() => openDocument("tasks")} onOpenBook={openBook} onOpenDocument={openDocument}
        onOpenPanel={openPanel} onBeforeLogout={mayLeave} onLoggedOut={onLoggedOut}
      />
```

  `onAdd` 必须包一层箭头函数：`openUnifiedImport(text)` 的参数为真时打开粘贴文字模式，直接传会把点击事件当成参数。

Run: `grep -n "导入资料\|导入文字\|任务与导入草稿\|我的书架\|sidebar-secondary-actions" client/App.jsx client/components/Sidebar.jsx`
Expected: 无输出

- [ ] **Step 6: 追加侧栏样式，删除旧样式**

`client/sidebar.css` 末尾追加：

```css
/* Top of the sidebar: the add button and the task row. */
.sidebar-actions {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 24px;
}
.sidebar-primary-action {
  gap: 6px;
}
.sidebar .sidebar-task-link {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: #e4e5d8;
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.sidebar .sidebar-task-link > span:first-of-type {
  flex: 1;
}
.sidebar .sidebar-task-link:hover:not(:disabled),
.sidebar .sidebar-task-link.active {
  background: #ffffff12;
  color: #fbf4e6;
}
.sidebar .sidebar-task-link:disabled {
  opacity: 0.55;
  cursor: default;
}
.sidebar .sidebar-task-link .count {
  min-width: 20px;
  padding: 0 7px;
  border-radius: 999px;
  background: var(--rust);
  color: #fff9ef;
  font-size: 11px;
  line-height: 20px;
  text-align: center;
}

/* Shelf heading with the new-book button. */
.shelf-heading h2 {
  margin: 0;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: 2px;
}
.sidebar .shelf-new-book {
  width: 26px;
  height: 26px;
  padding: 4px;
  color: #d3dfd2;
}
.sidebar .shelf-new-book:hover:not(:disabled) {
  background: #ffffff12;
  color: #fbf4e6;
}
```

删除旧样式（同一文件从下往上删）：

1. `client/styles.css` 第 244–248 行 `.shelf-heading > span:first-child { … }`。
2. `client/styles.css` 第 148–157 行 `.sidebar-secondary-actions { … }` 和 `.sidebar-secondary-actions .button { … }`。
3. `client/image-tasks.css` 第 56–57 行 `.sidebar-task-link { … }`、`.sidebar-task-link .count { … }`。

- [ ] **Step 7: 运行**

```bash
npm run build && npx playwright test && npx playwright test -c tests/browser/sources.config.mjs && npx playwright test -c tests/browser/tasks.config.mjs
```

Expected: 构建成功；默认 32 项、sources 150 项、tasks 42 项全部通过。

- [ ] **Step 8: 提交**

```bash
git add client/components/Sidebar.jsx client/App.jsx client/sidebar.css client/styles.css client/image-tasks.css \
  tests/browser/navigation.mjs tests/browser/stage1.spec.mjs tests/browser/unified-sources.e2e.mjs \
  tests/browser/unified-tasks.e2e.mjs tests/browser/stage3.e2e.mjs
git commit -m "refactor: extract the sidebar and keep only add, tasks and shelf"
```

---

### Task 7: 首页（含手机「拍照添加」）

**Files:**
- Modify: `client/components/Welcome.jsx`（整体替换）、`client/welcome.css`（整体替换）
- Modify: `client/App.jsx:147`、`:230`、`:276`、`:1142-1151`
- Test: `tests/browser/stage1.spec.mjs:378`、`:402`、`tests/browser/unified-sources.e2e.mjs:292`

设计文档把手机首页的「📷 拍照添加」单列一项；它只是首页里的一个按钮加手机样式，放在本任务里一起写，避免把 `Welcome.jsx` 写两遍。

- [ ] **Step 1: 更新选择器（先让用例描述新首页）**

`tests/browser/stage1.spec.mjs`：

- 第 378 行用例标题 `"首页书案概览、当前阅读与最近阅读使用已保存书籍和材料并能正确打开"` 改为 `"首页继续阅读与最近阅读使用已保存书籍和材料并能正确打开"`
- 第 402 行 `{ name: "我的阅读资料", exact: true }` 改为 `{ name: "继续阅读", exact: true }`
- 第 405–406、413、418 行的「打开书籍：…」「继续阅读：…」不改：「最近阅读」卡片沿用这两个 `aria-label`。

`tests/browser/unified-sources.e2e.mjs` 第 292 行

```js
  await expect(page.getByRole("region",{name:"我的阅读资料",exact:true})).toContainText("351");
```

改为（统计栏去掉后，用「最近阅读」卡片上的字数验证摘要已刷新）：

```js
  await expect(page.getByRole("region",{name:"最近阅读",exact:true})).toContainText("351 字");
```

- [ ] **Step 2: 运行，确认失败**

Run: `npm run build && npx playwright test -g "首页继续阅读"`
Expected: FAIL，找不到「继续阅读」区域

- [ ] **Step 3: 替换 `client/components/Welcome.jsx`**

```jsx
import Icon from "./Icon.jsx";
import { continueReading, recentEntries } from "../library-model.mjs";

// Home: continue reading, imports that need the reader, then recent reading.
// Phones start with the photo action because they are mostly used for imports;
// welcome.css reorders the blocks there.
export default function Welcome({
  books = [],
  documents = [],
  articles = [],
  loading = false,
  attentionCount = 0,
  onOpenBook,
  onOpenDocument,
  onOpenTasks,
  onAddPhoto,
}) {
  const current = continueReading(articles, books);
  const recent = recentEntries(books, documents);
  return (
    <section className="welcome home" aria-label="阅读首页">
      <button className="home-photo-action" type="button" onClick={onAddPhoto}>
        <span aria-hidden="true">📷</span>拍照添加
      </button>
      {current ? (
        <section className="home-continue" aria-label="继续阅读">
          <div className="home-continue-copy">
            <span className="eyebrow">继续阅读</span>
            <h2>{current.document.title}</h2>
            {current.book && <p className="home-continue-book">{current.book.title}</p>}
            {current.progress && (
              <div className="home-continue-progress">
                <span>{current.progress.label}</span>
                <span className="home-progress-track" role="progressbar" aria-label="阅读进度"
                  aria-valuemin={1} aria-valuemax={current.progress.total} aria-valuenow={current.progress.page}>
                  <span style={{ width: `${current.progress.percent}%` }} />
                </span>
              </div>
            )}
          </div>
          <button className="button primary" type="button" onClick={() => onOpenDocument(current.document.id)}>
            {current.resumed ? "继续阅读" : "开始阅读"}
            <Icon name="arrow" size={16} />
          </button>
        </section>
      ) : (
        <div className="home-library-empty">
          <span className="home-empty-mark" aria-hidden="true">本</span>
          <div>
            <h3>{loading ? "正在打开书架…" : "还没有材料"}</h3>
            {!loading && <p>点「添加」导入照片、PDF、EPUB 或文字。</p>}
          </div>
        </div>
      )}
      {attentionCount > 0 && (
        <button className="home-task-card" type="button" onClick={onOpenTasks}>
          <span>{attentionCount} 个导入需要你处理</span>
          <span className="home-task-link">查看<Icon name="arrow" size={14} /></span>
        </button>
      )}
      {recent.length > 0 && (
        <section className="home-recent" aria-label="最近阅读">
          <h2 className="home-section-title">最近阅读</h2>
          <div className="home-recent-grid">
            {recent.map((item, index) => (
              <button
                key={`${item.entryType}-${item.id}`}
                type="button"
                className={`home-reading-card home-reading-card-${index % 3}`}
                aria-label={`${item.entryType === "book" ? "打开书籍" : "继续阅读"}：${item.title}`}
                onClick={() => (item.entryType === "book" ? onOpenBook(item.id) : onOpenDocument(item.id))}
              >
                <span className="home-reading-spine" aria-hidden="true">
                  <span>{item.entryType === "book" ? "本" : "文"}</span>
                </span>
                <span className="home-reading-content">
                  <small>{item.entryType === "book" ? `书籍 · ${item.pageCount} 篇` : "文章"}</small>
                  <strong>{item.title}</strong>
                  <span lang="ja">{item.preview?.replace(/\n/g, " ") || ""}</span>
                  <span className="home-reading-bottom">
                    {(item.charCount || 0).toLocaleString("zh-CN")} 字
                    <Icon name="arrow" size={18} />
                  </span>
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
    </section>
  );
}
```

DOM 顺序按桌面（继续阅读 → 待处理 → 最近阅读），键盘顺序与桌面视觉一致；手机上用 CSS `order` 把「拍照添加」和待处理条提到前面。「继续阅读」按钮的名称只是「继续阅读」，不带标题，避免与「最近阅读」卡片的「继续阅读：<标题>」重名。

- [ ] **Step 4: 替换 `client/welcome.css`**

```css
/* Home (UI step 2): continue reading first, then imports that need the reader,
   then recent reading. Phones start with the photo action. */
.welcome.home {
  display: flex;
  flex-direction: column;
  gap: 26px;
  width: min(1040px, calc(100% - 80px));
  margin: 40px auto;
  color: var(--ink);
}
.home-photo-action {
  display: none;
}

.home-continue {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: end;
  gap: 20px 32px;
  padding: 30px 34px;
  border: 1px solid #e1dccc;
  border-radius: 12px;
  background: var(--paper);
  box-shadow: 0 18px 40px #203b3912;
}
.home-continue-copy {
  min-width: 0;
}
.home-continue h2 {
  margin: 10px 0 6px;
  font: 500 28px/1.4 "Noto Serif CJK SC", serif;
  overflow-wrap: anywhere;
}
.home-continue-book {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
}
.home-continue-progress {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 18px;
  color: var(--muted);
  font-size: 12px;
}
.home-progress-track {
  display: block;
  flex: 1;
  max-width: 320px;
  height: 4px;
  overflow: hidden;
  border-radius: 999px;
  background: #e8e2d4;
}
.home-progress-track > span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--rust);
}
.home-continue > .button {
  gap: 8px;
  min-height: 44px;
  padding: 10px 22px;
}

.home-task-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  padding: 14px 18px;
  border: 1px solid #e7c9b7;
  border-radius: 8px;
  background: #fbefe6;
  color: var(--ink);
  font: inherit;
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.home-task-card:hover {
  border-color: var(--rust);
}
.home-task-link {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  color: var(--rust-dark);
  font-size: 13px;
}

.home-section-title {
  margin: 0 0 14px;
  color: var(--ink);
  font: 500 19px/1.45 "Noto Serif CJK SC", serif;
}
.home-recent-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 14px;
}
.home-reading-card {
  display: flex;
  min-width: 0;
  padding: 0;
  overflow: hidden;
  border: 1px solid #e1dccc;
  border-radius: 9px;
  background: #fffdf6;
  text-align: left;
  transition:
    transform 0.18s,
    box-shadow 0.18s;
}
.home-reading-card:hover {
  transform: translateY(-2px);
  border-color: #b8c3ac;
  box-shadow: 0 8px 20px #3d442314;
}
.home-reading-spine {
  display: flex;
  flex-shrink: 0;
  align-items: flex-start;
  justify-content: center;
  width: 40px;
  padding-top: 18px;
  border-right: 4px solid #ffffff15;
  background: #3a5b4b;
  color: #ece6cd;
}
.home-reading-spine > span {
  padding-top: 5px;
  border-top: 1px solid #c1b992;
  font: 400 17px "Noto Serif CJK JP", serif;
}
.home-reading-card-1 .home-reading-spine {
  background: #a06e50;
}
.home-reading-card-2 .home-reading-spine {
  background: #68747b;
}
.home-reading-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 16px 15px 13px;
}
.home-reading-content > small {
  color: #88795f;
  font-size: 11px;
}
.home-reading-content > strong {
  display: -webkit-box;
  overflow: hidden;
  color: #2b4036;
  font-size: 14px;
  font-weight: 500;
  line-height: 1.55;
  overflow-wrap: anywhere;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
}
.home-reading-content > [lang="ja"] {
  display: block;
  overflow: hidden;
  color: #788072;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.home-reading-bottom {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
  padding-top: 6px;
  border-top: 1px solid #f0ece1;
  color: #627166;
  font-size: 11px;
}

.home-library-empty {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 22px 24px;
  border: 1px dashed #c8ccb7;
  border-radius: 10px;
  background: #ebeede;
}
.home-empty-mark {
  display: grid;
  flex-shrink: 0;
  place-items: center;
  width: 46px;
  height: 58px;
  border-right: 4px solid #b5bea1;
  border-radius: 3px;
  background: #3a5b4b;
  color: #f7f0d6;
  font: 22px "Noto Serif CJK JP", serif;
}
.home-library-empty h3 {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 500;
}
.home-library-empty p {
  margin: 0;
  color: #68735e;
  font-size: 12px;
  line-height: 1.75;
}

@media (max-width: 1100px) {
  .welcome.home {
    width: calc(100% - 48px);
  }
  .home-continue {
    grid-template-columns: 1fr;
    align-items: start;
  }
  .home-continue > .button {
    justify-self: start;
  }
  .home-recent-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

@media (max-width: 760px) {
  .welcome.home {
    gap: 18px;
    width: calc(100% - 32px);
    margin: 20px auto 28px;
  }
  .home-photo-action {
    display: flex;
    order: -2;
    align-items: center;
    justify-content: center;
    gap: 10px;
    width: 100%;
    min-height: 64px;
    border: 0;
    border-radius: 12px;
    background: var(--ink);
    color: #fbf4e6;
    font: inherit;
    font-size: 18px;
    font-weight: 500;
    letter-spacing: 1px;
    box-shadow: 0 10px 24px #203b3929;
    cursor: pointer;
  }
  .home-photo-action > span {
    font-size: 22px;
  }
  .home-task-card {
    order: -1;
  }
  .home-continue {
    padding: 20px;
  }
  .home-continue h2 {
    font-size: 22px;
  }
  .home-continue > .button {
    justify-self: stretch;
  }
  .home-recent-grid {
    grid-template-columns: 1fr;
  }
  .home-library-empty {
    gap: 12px;
    padding: 16px;
  }
}

@media (prefers-reduced-motion: reduce) {
  .home-reading-card {
    transition: none;
  }
  .home-reading-card:hover {
    transform: none;
  }
}
```

- [ ] **Step 5: `App.jsx` 接线**

1. 第 1142–1151 行 `<Welcome … />` 替换为：

```jsx
          <Welcome
            books={books}
            documents={libraryDocuments}
            articles={articleTargets}
            loading={loading}
            attentionCount={taskCounts.attention ?? 0}
            onOpenBook={openBook}
            onOpenDocument={openDocument}
            onOpenTasks={() => openDocument("tasks")}
            onAddPhoto={() => openUnifiedImport()}
          />
```

   `articleTargets` 来自 `/documents?all=1`，包含书中文章，「继续阅读」从这里选；`libraryDocuments` 只有独立文章，与书籍一起组成「最近阅读」。

2. 第 276 行 `}, [query, refresh]);`（文章与书籍列表的 effect 结束）之后插入：

```js
  const previousActiveId = useRef(activeId);
  useEffect(() => {
    // Reading moves the saved page, so reload the summaries when the reader returns home.
    if (!activeId && previousActiveId.current) setRefresh((n) => n + 1);
    previousActiveId.current = activeId;
  }, [activeId]);
  useEffect(() => {
    if (!currentReadingDocument || currentReadingDocument.sourceWorkflow || !readingReady) return;
    // Paged articles save their page through the reading-session heartbeat;
    // single-page articles only record that they were opened.
    api(`/documents/${encodeURIComponent(currentReadingDocument.id)}/reading-position`, {
      method: "PUT", body: JSON.stringify({ pageIndex: 0 }),
    }).catch(() => { /* Progress is a convenience; reading continues without it. */ });
  }, [currentReadingDocument?.id, currentReadingDocument?.sourceWorkflow, readingReady]);
```

3. 第 230 行

```js
        if (!stopped && current === sequence) { setTaskCounts(result.counts || {}); setActiveTaskCount(result.counts?.active ?? result.activeCount ?? result.total ?? 0); }
```

   改为：

```js
        if (!stopped && current === sequence) setTaskCounts(result.counts || {});
```

4. 删除第 147 行 `const [activeTaskCount, setActiveTaskCount] = useState(0);`。

Run: `grep -n "activeTaskCount" client/App.jsx client/components/*.jsx`
Expected: 无输出

- [ ] **Step 6: 运行**

```bash
npm run build && npx playwright test && npx playwright test -c tests/browser/sources.config.mjs
```

Expected: 默认 32 项、sources 150 项全部通过。

- [ ] **Step 7: 提交**

```bash
git add client/components/Welcome.jsx client/welcome.css client/App.jsx tests/browser/stage1.spec.mjs tests/browser/unified-sources.e2e.mjs
git commit -m "feat: rebuild home around continue reading"
```

---

### Task 8: 书籍页

**Files:**
- Modify: `client/components/BookView.jsx`（整体替换）
- Modify: `client/books.css:1-126`、`:303-320`
- Modify: `client/App.jsx:1106-1115`
- Test: `tests/browser/unified-tasks.e2e.mjs:130-165`、`tests/browser/stage2.e2e.mjs:1849`、`tests/browser/stage1.spec.mjs`（新用例）

- [ ] **Step 1: 写失败的浏览器用例**

`tests/browser/stage1.spec.mjs` 文件末尾追加：

```js
test("首页继续阅读最近打开的文章，书籍页可继续阅读并从菜单重命名", async ({ page }, info) => {
  const suffix = info.project.name;
  let bookId;
  try {
    const book = await (await page.request.post("/api/books", { data: { title: `进度书籍-${suffix}` } })).json();
    bookId = book.id;
    for (const title of ["第一篇", "第二篇"]) {
      const response = await page.request.post("/api/documents", {
        data: { bookId, title: `${title}-${suffix}`, kind: "book", orientation: "horizontal", content: "{本|ほん}を{読|よ}む。" },
      });
      expect(response.status()).toBe(201);
    }
    const second = (await (await page.request.get(`/api/books/${bookId}`)).json()).pages[1];
    const recorded = page.waitForResponse((response) =>
      response.url().endsWith(`/api/documents/${second.id}/reading-position`) && response.request().method() === "PUT");
    await page.goto(`/#${second.id}`);
    await expect(page.getByRole("article", { name: "日语原文", exact: true })).toBeVisible();
    expect((await recorded).status()).toBe(200);

    await page.goto("/");
    const current = page.getByRole("region", { name: "继续阅读", exact: true });
    await expect(current.getByRole("heading", { name: second.title, exact: true })).toBeVisible();
    await expect(current).toContainText(book.title);
    const photo = page.getByRole("button", { name: "拍照添加", exact: true });
    if (suffix === "phone") await expect(photo).toBeVisible();
    else await expect(photo).toHaveCount(0);
    await page.screenshot({ path: `artifacts/step2-home-${suffix}.png`, fullPage: true, animations: "disabled" });

    await page.goto(`/#book/${bookId}`);
    await expect(page.locator(".book-facts")).toHaveText(/^2 篇 · /);
    await expect(page.getByRole("button", { name: `继续阅读 · ${second.title}`, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "书名", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "书籍操作", exact: true }).click();
    await page.getByRole("button", { name: "重命名", exact: true }).click();
    await page.getByRole("textbox", { name: "书名", exact: true }).fill(`改名书籍-${suffix}`);
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("heading", { name: `改名书籍-${suffix}`, exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "书名", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: `artifacts/step2-book-${suffix}.png`, fullPage: true, animations: "disabled" });
  } finally {
    if (bookId) {
      const response = await page.request.get(`/api/books/${bookId}`);
      if (response.ok()) {
        const current = await response.json();
        expect((await page.request.delete(`/api/books/${bookId}`, { data: { revision: current.revision } })).status()).toBe(204);
      }
    }
  }
});
```

（概况用 `.book-facts` 定位：侧栏书架里同一本书也显示「2 篇 · N 字」，按文字找会匹配两处。）

`tests/browser/unified-tasks.e2e.mjs`（tasks 配置）：删除书籍现在要先打开「⋯」菜单；选择「删除书籍」时菜单关闭，焦点回到「书籍操作」按钮，确认框关闭后焦点也回到它。

| 原行 | 原文 | 改为 |
| --- | --- | --- |
| 130 | `let trigger,deletePath,dialogName,scopeText,confirmLabel;` | `let trigger,deletePath,dialogName,scopeText,confirmLabel,opener=null,openTrigger=async()=>{};` |
| 138 | `await page.goto("/#book/book");` | `await page.goto("/#book/book");opener=page.getByRole("button",{name:"书籍操作",exact:true});openTrigger=()=>opener.click();` |
| 150 | `await trigger.click();` | `await openTrigger();await trigger.click();` |
| 158 | `await expect(trigger).toBeFocused();` | `await expect(opener ?? trigger).toBeFocused();` |
| 160 | `await trigger.click();` | `await openTrigger();await trigger.click();` |
| 163 | `await expect(trigger).toBeFocused();` | `await expect(opener ?? trigger).toBeFocused();` |
| 165 | `await trigger.click();` | `await openTrigger();await trigger.click();` |

`task` 与 `article` 两个分支不设 `opener`，行为不变。

`tests/browser/stage2.e2e.mjs`（AI 配置）第 1849 行 `{ name: "添加文字文章", exact: true }` 改为 `{ name: "添加文章", exact: true }`。该用例之后的「保存到书籍」「材料标题」属于旧编辑器流程，提交 `bbb51d9` 上已失败；第 1704 行「添加图片文章」同理，不改。

- [ ] **Step 2: 运行，确认失败**

Run: `npm run build && npx playwright test -g "书籍页可继续阅读"`
Expected: FAIL，找不到 `.book-facts`

- [ ] **Step 3: 替换 `client/components/BookView.jsx`**

```jsx
import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import { articleRowState, bookFacts, bookResume, documentTaskStates } from "../library-model.mjs";

// Book page: title with a ⋯ menu (rename, reorder, delete), one primary action
// and article rows that each show a single state.
export default function BookView({
  book,
  onOpenShelf,
  onOpenPage,
  onAddArticle,
  onRename,
  onReorder,
  onDelete,
  busy = false,
  taskCounts = {},
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [mode, setMode] = useState(null);
  const [title, setTitle] = useState(book.title);
  const [error, setError] = useState(null);
  const [taskStates, setTaskStates] = useState(() => new Map());
  const menu = useRef(null);
  const menuButton = useRef(null);
  const pages = book.pages;
  const resume = bookResume(book);

  useEffect(() => {
    setTitle(book.title);
    setError(null);
    setMode(null);
    setMenuOpen(false);
  }, [book.id]);
  // Refetch when the polled counts change, e.g. when a preparation finishes or fails.
  useEffect(() => {
    const controller = new AbortController();
    api("/tasks?scope=active&limit=100", { signal: controller.signal })
      .then((result) => setTaskStates(documentTaskStates(result?.tasks)))
      .catch(() => { /* Without tasks the rows still show the page or length. */ });
    return () => controller.abort();
  }, [book.id, taskCounts.active, taskCounts.attention]);
  useEffect(() => {
    if (!menuOpen) return;
    const outside = (event) => {
      if (!menu.current?.contains(event.target)) setMenuOpen(false);
    };
    window.document.addEventListener("pointerdown", outside);
    return () => window.document.removeEventListener("pointerdown", outside);
  }, [menuOpen]);

  const run = async (action) => {
    setError(null);
    try {
      await action();
      return true;
    } catch (cause) {
      setError(cause);
      return false;
    }
  };
  const choose = (next) => {
    setMenuOpen(false);
    // The confirmation dialog returns focus to the element focused when it
    // opened; the menu items disappear, so hand focus to the ⋯ button first.
    menuButton.current?.focus();
    if (next === "delete") void run(onDelete);
    else {
      if (next === "rename") setTitle(book.title);
      setMode(next);
    }
  };
  const rename = async (event) => {
    event.preventDefault();
    const next = title.trim();
    if (busy || !next) return;
    if (next === book.title) return setMode(null);
    if (await run(() => onRename(next))) setMode(null);
  };
  const movePage = (index, direction) => {
    const pageIds = pages.map((page) => page.id);
    const target = index + direction;
    [pageIds[index], pageIds[target]] = [pageIds[target], pageIds[index]];
    void run(() => onReorder(pageIds));
  };

  return (
    <section className="book-page stage2-page" aria-busy={busy}>
      <nav className="book-breadcrumb" aria-label="位置">
        <button type="button" className="text-button" onClick={onOpenShelf}>书架</button>
        <span aria-hidden="true">/</span>
      </nav>
      <div className="book-title-row">
        <h1>{book.title}</h1>
        <div className="book-menu" ref={menu} onKeyDown={(event) => {
          if (event.key !== "Escape" || !menuOpen) return;
          event.stopPropagation();
          setMenuOpen(false);
          menuButton.current?.focus();
        }}>
          <button ref={menuButton} type="button" className="icon-button" aria-label="书籍操作"
            aria-expanded={menuOpen} aria-controls={menuOpen ? "book-menu" : undefined}
            disabled={busy} onClick={() => setMenuOpen((value) => !value)}>
            <Icon name="more" size={18} />
          </button>
          {menuOpen && (
            <div className="book-menu-panel" id="book-menu">
              <button type="button" onClick={() => choose("rename")}>重命名</button>
              <button type="button" disabled={pages.length < 2} onClick={() => choose("reorder")}>调整顺序</button>
              <button type="button" className="book-delete" onClick={() => choose("delete")}>删除书籍</button>
            </div>
          )}
        </div>
      </div>
      <p className="book-facts">{bookFacts(book)}</p>
      {mode === "rename" && (
        <form className="book-rename" onSubmit={rename}
          onKeyDown={(event) => { if (event.key === "Escape") setMode(null); }}>
          <label>
            书名
            <input value={title} onChange={(event) => setTitle(event.target.value)}
              maxLength={160} required autoFocus disabled={busy} />
          </label>
          <button type="submit" className="button primary" disabled={busy || !title.trim()}>保存</button>
          <button type="button" className="button subtle" disabled={busy} onClick={() => setMode(null)}>取消</button>
        </form>
      )}
      <div className="book-actions">
        {resume && (
          <button type="button" className="button primary" disabled={busy} onClick={() => onOpenPage(resume.page.id)}>
            <span>{resume.label}</span>
          </button>
        )}
        <button type="button" className="button secondary" disabled={busy} onClick={onAddArticle}>
          <Icon name="plus" size={15} />添加文章
        </button>
      </div>
      {error && <ErrorNotice error={error} />}
      {mode === "reorder" && (
        <div className="book-reorder-bar">
          <span>调整顺序</span>
          <button type="button" className="button secondary" onClick={() => setMode(null)}>完成</button>
        </div>
      )}
      {pages.length ? (
        <ol className="book-page-list" aria-label="书籍文章列表">
          {pages.map((page, index) => {
            const state = articleRowState(page, taskStates.get(page.id));
            return (
              <li className="book-page-row" key={page.id}>
                <span className="book-page-number" aria-hidden="true">{index + 1}</span>
                <button type="button" className="book-page-open"
                  aria-label={`打开第 ${index + 1} 篇：${page.title}`}
                  aria-describedby={`book-page-state-${page.id}`}
                  disabled={busy} onClick={() => onOpenPage(page.id)}>
                  <strong>{page.title}</strong>
                  <span id={`book-page-state-${page.id}`} className={`book-page-state is-${state.kind}`}>{state.label}</span>
                </button>
                {mode === "reorder" && (
                  <div className="book-page-order">
                    <button type="button" className="button subtle" aria-label={`上移第 ${index + 1} 篇`}
                      disabled={busy || index === 0} onClick={() => movePage(index, -1)}>上移</button>
                    <button type="button" className="button subtle" aria-label={`下移第 ${index + 1} 篇`}
                      disabled={busy || index === pages.length - 1} onClick={() => movePage(index, 1)}>下移</button>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      ) : (
        <p className="book-empty">还没有文章</p>
      )}
    </section>
  );
}
```

去掉的旧文案（§1.1）：「按文章阅读」、整段说明「一本书包含多篇文章…」、「图片文章／文字文章 · N 处注音」、空书的长说明。

- [ ] **Step 4: 替换书籍页样式**

`client/books.css` 第 303–320 行（`@media (max-width: 760px)` 里从 `.book-heading {` 到 `.book-empty { … }`）替换为：

```css
  .book-title-row h1 {
    font-size: 24px;
  }
  .book-actions {
    margin: 18px 0 22px;
  }
  .book-actions .button {
    flex: 1 1 100%;
  }
  .book-rename {
    flex-wrap: wrap;
  }
  .book-rename label {
    flex-basis: 100%;
  }
  .book-page-row {
    grid-template-columns: 22px minmax(0, 1fr);
    gap: 8px 12px;
    padding: 15px 0;
  }
  .book-page-order {
    grid-column: 2;
  }
  .book-empty {
    padding: 22px 18px;
  }
```

再把第 1–126 行（`.book-heading > div:first-child` 到 `.book-delete { … }`，保留第 127 行起的 `.sr-only`）替换为：

```css
/* Book page (UI step 2): breadcrumb, title with a ⋯ menu, facts, one primary
   action and article rows that each show a single state. */
.book-breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  font-size: 12px;
}
.book-breadcrumb .text-button {
  padding: 0;
  color: var(--muted);
  font-size: 12px;
}
.book-breadcrumb .text-button:hover {
  color: var(--ink);
}
/* The ⋯ button sits at the right edge so its menu can open leftward without
   widening the page on phones. */
.book-title-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
}
.book-title-row h1 {
  min-width: 0;
  margin: 0;
  color: var(--ink);
  font: 500 30px/1.35 "Noto Serif CJK SC", serif;
  letter-spacing: 1px;
  overflow-wrap: anywhere;
}
.book-menu {
  position: relative;
  flex-shrink: 0;
  margin-top: 6px;
}
.book-menu-panel {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 10;
  display: flex;
  flex-direction: column;
  min-width: 150px;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 8px;
  background: var(--paper);
  box-shadow: 0 12px 28px #203b391f;
}
.book-menu-panel button {
  min-height: 34px;
  padding: 7px 10px;
  border: 0;
  border-radius: 5px;
  background: transparent;
  color: var(--ink);
  font: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.book-menu-panel button:hover:not(:disabled) {
  background: #f1ede2;
}
.book-menu-panel button:disabled {
  color: #a7ad9f;
  cursor: default;
}
.book-menu-panel .book-delete {
  color: #9d6152;
}
.book-facts {
  margin: 8px 0 0;
  color: var(--muted);
  font-size: 13px;
}
.book-rename {
  display: flex;
  align-items: flex-end;
  gap: 10px;
  max-width: 620px;
  margin-top: 18px;
}
.book-rename label {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  color: var(--muted);
  font-size: 11px;
}
.book-rename input,
.book-jump select,
.book-target select,
.book-target input {
  width: 100%;
  min-width: 0;
  height: 40px;
  border: 1px solid #dfe3d6;
  border-radius: 5px;
  background: #fcfcf7;
  padding: 8px 12px;
  font-size: 13px;
}
.book-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin: 24px 0 30px;
}
.book-actions .button {
  gap: 6px;
  max-width: 100%;
}
.book-actions .button > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.book-reorder-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
  color: var(--muted);
  font-size: 12px;
}
.book-page-list {
  list-style: none;
  padding: 0;
  margin: 0;
  border-top: 1px solid var(--line);
}
.book-page-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) auto;
  align-items: center;
  gap: 16px;
  padding: 18px 0;
  border-bottom: 1px solid var(--line);
}
.book-page-number {
  color: #8d9981;
  font-size: 12px;
  text-align: center;
}
.book-page-open {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  padding: 6px 0;
  border: 0;
  background: transparent;
  text-align: left;
}
.book-page-open strong {
  font-size: 15px;
  font-weight: 500;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.book-page-open:hover strong {
  color: var(--green);
}
.book-page-state {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.book-page-state.is-position {
  color: var(--green);
}
.book-page-state.is-working {
  color: #8a7a52;
}
.book-page-state.is-attention {
  color: var(--rust-dark);
  font-weight: 500;
}
.book-page-order {
  display: flex;
  gap: 4px;
}
.book-page-order .button {
  min-height: 34px;
  padding: 7px 10px;
  font-size: 11px;
}
.book-empty {
  margin: 0;
  padding: 28px 26px;
  border: 1px dashed #d6ddcf;
  border-radius: 6px;
  background: #f1f3ea;
  color: var(--muted);
  font-size: 13px;
}
```

- [ ] **Step 5: `App.jsx` 接线**

第 1106–1115 行 `<BookView … />` 替换为：

```jsx
          <BookView
            book={book}
            taskCounts={taskCounts}
            onOpenShelf={goHome}
            onOpenPage={openDocument}
            onAddArticle={() => beginBookPage(true)}
            onRename={(title) => updateBook({ title })}
            onReorder={(pageIds) => updateBook({ pageIds })}
            onDelete={deleteBook}
            busy={bookBusy}
          />
```

`beginBookPage(true)` 打开统一导入并预选本书（`setImportBookId(book.id)`）；照片、文件和粘贴文字都在那一页选。

- [ ] **Step 6: 运行**

```bash
npm test > /tmp/yohaku-test.log 2>&1; awk '/^✖ failing tests:/{exit} /^✖ /{sub(/ \([0-9.]+ms\)$/,""); print}' /tmp/yohaku-test.log | sort -u | comm -23 - artifacts/baseline-failing-tests.txt
npm run build && npx playwright test && npx playwright test -c tests/browser/tasks.config.mjs && npx playwright test -c tests/browser/sources.config.mjs
```

Expected: 对比输出为空；默认 34 项、tasks 42 项、sources 150 项全部通过。

- [ ] **Step 7: 提交**

```bash
git add client/components/BookView.jsx client/books.css client/App.jsx \
  tests/browser/stage1.spec.mjs tests/browser/unified-tasks.e2e.mjs tests/browser/stage2.e2e.mjs
git commit -m "feat: rebuild the book page with a single primary action"
```

---

### Task 9: 全量回归与浏览器走查

**Files:**
- Modify: 仅当回归发现新增失败时，改对应用例或代码

- [ ] **Step 1: 单元测试全量对比**

Run: 开始前的对比命令
Expected: 输出为空；总数比基线多出本计划新增的 15 项（`task-attention` 2、`tasks` 1、`reading-positions` 2、`reading-positions-api` 3、`library-model` 5、`account-menu` 2）

- [ ] **Step 2: 构建与三套必过的浏览器配置**

```bash
npm run build
npx playwright test
npx playwright test -c tests/browser/sources.config.mjs
npx playwright test -c tests/browser/tasks.config.mjs
```

Expected: 构建成功；默认 34／34、sources 150／150、tasks 42／42。

- [ ] **Step 3: AI 配置对比（参考）**

```bash
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/yohaku-ai.json npx playwright test -c playwright.ai.config.mjs --reporter=json > /dev/null 2>&1; node -e '
const report = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
const failing = new Set();
const walk = (suite, trail) => {
  for (const spec of suite.specs || [])
    for (const run of spec.tests || [])
      if (run.status === "unexpected" || run.status === "flaky")
        failing.add(`${run.projectName} › ${spec.file} › ${[...trail, spec.title].join(" › ")}`);
  for (const child of suite.suites || []) walk(child, [...trail, child.title]);
};
for (const suite of report.suites || []) walk(suite, []);
console.log([...failing].sort().join("\n"));
' /tmp/yohaku-ai.json > /tmp/yohaku-ai-failing.txt; comm -13 artifacts/ai-browser-baseline-failing.txt /tmp/yohaku-ai-failing.txt
```

Expected: 输出为空。若有输出，逐条单独重跑，例如 `npx playwright test -c playwright.ai.config.mjs --project=desktop -g "<用例标题>"`：单独能过的是登录限流造成的波动，记录即可；单独仍失败的，按 superpowers:systematic-debugging 排查。如果失败点是本计划改过的文案或结构，参照 Task 5–8 的写法改选择器，不删断言。

- [ ] **Step 4: 在内置浏览器走一遍**

用 `preview_start` 启动 `.claude/launch.json` 中的 `yohaku-dev`（端口 5173；它使用 `data/` 中的真实资料，如需登录请用户自己在面板中登录）。分别在 1280、800（桌面）和 375（手机）宽度下检查，截图存到 `artifacts/step2-walkthrough-<页面>-<宽度>.png`：

1. 侧栏只有标志、「添加」、「任务」（有需要处理的任务时显示数字）、「书架」与「＋」、搜索、书架列表、底部账号行；没有「导入文字」「新建书籍」按钮行和管理员按钮行。
2. 账号菜单向上展开：管理员看到「AI 设置」「角色配置」「错误记录」「邀请朋友」「退出」；点「错误记录」打开错误记录页；按 Esc 或点菜单外关闭。
3. 首页：「继续阅读」卡片显示文章、所属书籍、「第 N / M 页」、进度条和按钮；有需要处理的任务时出现「N 个导入需要你处理 · 查看」；「最近阅读」按打开时间排序；没有统计栏。
4. 打开一篇分页文章翻到第 2 页，回首页显示「第 2 / M 页」；再点「继续阅读」从第 2 页开始。
5. 书籍页：「书架 /」、标题和「⋯」（重命名／调整顺序／删除书籍）、「N 篇 · X 字」、「继续阅读 · <文章>」、「添加文章」（打开添加页且已选本书）；文章行只显示一种状态。删除只在自己新建的「走查用书」上试，不动已有书籍。
6. 375 宽：首页第一块是「📷 拍照添加」，其次是待处理条与继续阅读；点「拍照添加」打开添加页；侧栏抽屉结构与桌面相同，账号菜单在抽屉底部向上展开。
7. 每个宽度下 `document.documentElement.scrollWidth <= innerWidth`，界面上没有「导入资料」「任务与导入草稿」「我的书架」「按文章阅读」。

- [ ] **Step 5: 提交（仅当本任务改了文件）**

```bash
git add -A tests client server shared
git commit -m "test: align step 2 regressions with the new navigation"
```

---

## 完成标准

- `npm test` 相对基线没有新增失败；`npm run build` 成功；默认、sources、tasks 三套 Playwright 配置全部通过；AI 配置没有新增失败（登录限流波动除外）。
- 侧栏顶部只有「＋ 添加」和「任务」，「新建书籍」是书架标题旁的「＋」，底部只有账号行；「错误记录」「AI 设置」「角色配置」「邀请朋友」在账号菜单里且仅管理员可见。
- 首页没有统计栏，第一块是「继续阅读」（手机上先是「拍照添加」）；「最近阅读」按最近打开时间排序。
- 书籍页只有一个主按钮，重命名、调整顺序、删除收在「⋯」；文章行只显示「需要处理」「准备中」「读到第 N 页」或字数之一。
- `reading_positions` 有 `updated_at`；翻页写入、打开恢复、删除级联都有测试覆盖。

## 后续步骤

1. `…-step3-reading.md`：阅读页（第 3 节），同时把 `App.jsx` 顶部错误横幅改用 `ErrorNotice`。
2. `…-step4-import.md`：拍照导入（第 4 节），首页「拍照添加」改为直接打开相机。
3. `…-step5-tasks-settings.md`：任务页（标题改为「任务」）、校对、AI 页合并（账号菜单的「AI 设置」「角色配置」合成「AI」）、安装横幅与账号菜单「安装为 App」（第 5 节）。

## 自查

- **设计文档覆盖**：§2.1 侧栏 → Task 5、6；§2.1 账号菜单 → Task 5（「安装为 App」按开始前所述留到第 5 步）；§2.2 首页 → Task 7（手机首个动作同在 Task 7）；§2.3 书籍页 → Task 8；§2.4 阅读进度 → Task 2、3（写入、恢复、删除级联），读取方 → Task 4、7、8；§1.1 文案 → Task 5–8 删除的说明与改短的按钮；§1.6 错误记录入口 → Task 5；§1.5 `ErrorNotice` → 书籍页、账号菜单。
- **占位扫描**：没有 TBD／TODO／省略写法；每个改代码的步骤都给出完整代码或逐行原文 → 新文。
- **名称一致**：`taskAttention`（Task 1）在 Task 4 的 `documentTaskStates` 中使用；`readingPositions.save／forUser／remove`（Task 2）在 Task 3 的 `sources.mjs`、`app.mjs` 中使用；`readingSummaries` 返回 `{ pageIndex, pageCount, updatedAt }`，与 Task 4 的 `pageProgress` 输入一致；`openShelf／openAccountMenu`（Task 5）与 `openAddText`（Task 6）都在 `tests/browser/navigation.mjs`；`goHome` 在 Task 6 定义，Task 8 使用；`counts.attention` 在 Task 1 产生，Task 6、7、8 使用。
