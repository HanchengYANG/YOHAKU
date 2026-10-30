import { randomUUID, createHash } from "node:crypto";
import multer from "multer";
import { blocksToHtml, htmlToBlocks, appendImageBodyHtml } from "../shared/article-html.mjs";
import { serializeBlocks, plainText, parseText } from "../shared/document.mjs";

const phases = ["prepare", "recognize", "annotate"];
const fail = (status, message, code) => Object.assign(new Error(message), { status, expose: true, ...(code ? { code } : {}) });
const json = (value) => value == null ? null : JSON.stringify(value);
const parse = (value) => value == null ? null : JSON.parse(value);
const publicImage = (image) => { const { path, ...metadata } = image; return metadata; };
const identifier = (value) => typeof value === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(value);
const initialSteps = () => Object.fromEntries(phases.map((phase) => [phase, { state: "pending", attempts: 0, error: null, nextRunAt: 0 }]));
const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const adoptionHash = (document, resultVersion) => createHash("sha256")
  .update(JSON.stringify(canonical({ document, resultVersion }))).digest("hex");

function textInput(value, maximum, label, { empty = true } = {}) {
  if (typeof value !== "string" || value.length > maximum || (!empty && !value.trim()))
    throw fail(400, `${label}${empty ? "" : "需要填写，"}最多 ${maximum} 个字符。`);
  return value.trim();
}

/** Durable, single-process image import queue. AI work never belongs to an HTTP request. */
export function attachImageTaskRoutes({ app, database, ai, applyResult, getAppliedDocument, validateDestination = () => ({}), runnerOptions = {} }) {
  const { enabled = true, pollIntervalMs = 1000, retryDelayMs = 2000, blockedRetryMs = 15000,
    maxAutomaticRetries = 2, now = () => Date.now() } = runnerOptions;
  database.exec(`
    CREATE TABLE IF NOT EXISTS image_tasks (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL, state TEXT NOT NULL,
      version INTEGER NOT NULL, idempotency_key TEXT NOT NULL, creation_json TEXT NOT NULL,
      input_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      submitted_at TEXT, started_at TEXT, completed_at TEXT, blocked_reason TEXT,
      next_run_at INTEGER NOT NULL DEFAULT 0, queue_order INTEGER NOT NULL DEFAULT 0,
      result_version INTEGER, applied_document_id TEXT, applied_at TEXT,
      applied_input_hash TEXT, applied_copies_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(user_id,idempotency_key)
    );
    CREATE INDEX IF NOT EXISTS image_tasks_user ON image_tasks(user_id,updated_at);
    CREATE INDEX IF NOT EXISTS image_tasks_queue ON image_tasks(state,next_run_at,queue_order);
    CREATE TABLE IF NOT EXISTS image_task_items (
      task_id TEXT NOT NULL, id TEXT NOT NULL, position INTEGER NOT NULL, name TEXT NOT NULL,
      image_id TEXT, image_json TEXT, upload_hash TEXT, quarter_turns INTEGER NOT NULL DEFAULT 0,
      base_revision INTEGER, prepared_revision INTEGER, steps_json TEXT NOT NULL,
      recognition_json TEXT, annotation_json TEXT, review_annotations_json TEXT NOT NULL DEFAULT '[]', attempt_token TEXT,
      PRIMARY KEY(task_id,id)
    );
    CREATE INDEX IF NOT EXISTS image_task_items_image ON image_task_items(image_id);
  `);
  if (!database.prepare("PRAGMA table_info(image_task_items)").all().some((column) => column.name === "review_annotations_json"))
    database.exec("ALTER TABLE image_task_items ADD COLUMN review_annotations_json TEXT NOT NULL DEFAULT '[]'");
  const taskColumns = database.prepare("PRAGMA table_info(image_tasks)").all().map((column) => column.name);
  if (!taskColumns.includes("applied_input_hash")) database.exec("ALTER TABLE image_tasks ADD COLUMN applied_input_hash TEXT");
  if (!taskColumns.includes("applied_copies_json")) database.exec("ALTER TABLE image_tasks ADD COLUMN applied_copies_json TEXT NOT NULL DEFAULT '{}'");
  let closed = false, timer = null, active = null;
  const submittingImages = new Map();
  let queueOrder = database.prepare("SELECT coalesce(max(queue_order),0) AS value FROM image_tasks").get().value;
  const iso = () => new Date(now()).toISOString();
  const getRow = database.prepare("SELECT * FROM image_tasks WHERE id=? AND user_id=?");
  const getItems = database.prepare("SELECT * FROM image_task_items WHERE task_id=? ORDER BY position,id");
  const getItem = database.prepare("SELECT * FROM image_task_items WHERE task_id=? AND id=?");

  function transaction(work) {
    database.exec("BEGIN IMMEDIATE");
    try { const result = work(); database.exec("COMMIT"); return result; }
    catch (error) { database.exec("ROLLBACK"); throw error; }
  }
  function requireTask(userId, id) {
    const row = getRow.get(id, userId);
    if (!row) throw fail(404, "找不到你账号下的图片任务。");
    return row;
  }
  function expectVersion(row, version) {
    if (!Number.isSafeInteger(version) || version !== row.version)
      throw fail(409, "导入任务已在其他页面更新，请刷新后重试。", "TASK_VERSION_CONFLICT");
  }
  function changeTask(id, patch = {}) {
    const entries = Object.entries(patch);
    database.prepare(`UPDATE image_tasks SET version=version+1,updated_at=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE id=?`)
      .run(iso(), ...entries.map(([, value]) => value), id);
  }
  function destination(userId, input, validate = true) {
    const bookId = input.bookId || null, targetId = input.targetId || null;
    if ((bookId && !identifier(bookId)) || (targetId && !identifier(targetId))) throw fail(400, "请选择有效的书籍或文章。");
    const newBookTitle = textInput(input.newBookTitle || "", 160, "新书名");
    if (input.createNewBook !== undefined && typeof input.createNewBook !== "boolean") throw fail(400, "新建书籍选项无效。");
    const createNewBook = input.createNewBook ?? !!newBookTitle;
    if ((createNewBook || newBookTitle) && (bookId || targetId)) throw fail(400, "新建书籍不能同时指定已有书籍或文章。");
    const checked = validate ? validateDestination(userId, { bookId, targetId }) || {} : {};
    return { title: textInput(input.title || "", 160, "文章标题"), bookId, targetId, newBookTitle, createNewBook,
      targetRevision: checked.targetRevision ?? checked.revision ?? null };
  }
  function describeItem(item) {
    const steps = parse(item.steps_json), phase = phases.find((name) => steps[name].state !== "succeeded") || "annotate";
    const status = phases.every((name) => steps[name].state === "succeeded") ? "succeeded" : steps[phase].state;
    return { id: item.id, name: item.name, position: item.position, imageId: item.image_id,
      imageRevision: item.prepared_revision || item.base_revision, quarterTurns: item.quarter_turns,
      sourceImage: parse(item.image_json), uploadState: item.image_id ? "uploaded" : "pending",
      phase: item.image_id ? phase : "upload", status: item.image_id ? status : "pending",
      error: steps[phase].error, steps, hasRecognition: !!item.recognition_json, hasAnnotation: !!item.annotation_json,
      recognized: !!item.recognition_json, annotated: !!item.annotation_json };
  }
  function present(row, items = getItems.all(row.id)) {
    const described = items.map(describeItem);
    return { id: row.id, state: row.state, version: row.version, ...parse(row.input_json),
      createdAt: row.created_at, updatedAt: row.updated_at, submittedAt: row.submitted_at,
      startedAt: row.started_at, completedAt: row.completed_at, blockedReason: row.blocked_reason,
      lastError: row.blocked_reason || described.find((item) => item.error)?.error || null,
      resultVersion: row.result_version, appliedDocumentId: row.applied_document_id, appliedAt: row.applied_at,
      items: described, counts: { total: items.length, uploaded: items.filter((item) => item.image_id).length,
        recognized: items.filter((item) => item.recognition_json).length,
        completed: items.filter((item) => item.annotation_json).length,
        failed: described.filter((item) => item.status === "failed").length,
        pending: described.filter((item) => ["pending", "running"].includes(item.status)).length } };
  }
  function taskFor(userId, id) { return present(requireTask(userId, id)); }
  function resultFor(userId, id) {
    const task = requireTask(userId, id);
    if (task.result_version == null) throw fail(409, "请先停止处理并固定结果，再开始人工校对。");
    const items = getItems.all(id).filter((item) => item.image_id), input = parse(task.input_json);
    const fragments = items.filter((item) => item.recognition_json).map((item) => {
      const recognition = parse(item.recognition_json), annotation = parse(item.annotation_json);
      return blocksToHtml((annotation || recognition).blocks, { sourceImageId: item.image_id });
    });
    const bodyHtml = fragments.length ? fragments.slice(1).reduce(appendImageBodyHtml, fragments[0]) : "<p></p>";
    const blocks = htmlToBlocks(bodyHtml);
    const sourceImages = items.map((item) => ({ id: item.image_id, taskId: task.id, taskItemId: item.id, name: item.name,
      reviewAnnotations: parse(item.review_annotations_json) || [],
      sourceImage: parse(item.image_json), recognition: item.recognition_json ? {
        ...parse(item.recognition_json), ...(item.annotation_json ? { annotation: parse(item.annotation_json).annotation || parse(item.annotation_json) } : {}),
        sourceImageId: item.image_id, sourceImage: parse(item.image_json), autoAnnotationCompleted: !!item.annotation_json,
      } : null, manualRequired: !item.recognition_json }));
    return { taskId: id, taskVersion: task.version, taskResultVersion: task.result_version,
      title: input.title || parse(items.find((item) => item.recognition_json)?.recognition_json)?.title || items[0]?.name.replace(/\.[^.]+$/, "") || "图片文章",
      kind: input.bookId || input.createNewBook || input.newBookTitle ? "book" : "article", orientation: "horizontal",
      bookId: input.bookId, newBookTitle: input.newBookTitle, createNewBook: input.createNewBook, appendToDocumentId: input.targetId,
      targetRevision: input.targetRevision, bodyHtml, blocks, content: serializeBlocks(blocks), sourceImages,
      sourceImageId: items[0]?.image_id || null, sourceImage: parse(items[0]?.image_json),
      recognition: sourceImages[0]?.recognition || null, appendedImageId: items[0]?.image_id || null,
      autoAnnotationCompleted: items.length > 0 && items.every((item) => item.annotation_json),
      annotationError: items.some((item) => !item.annotation_json) ? "部分图片未完成自动识别或注音，可对照原图手动录入及校正。" : "",
      initializeSentences: true };
  }

  function checkDraft(row) {
    if (row.state !== "draft") throw fail(409, "任务已提交，不能再修改这批图片，请打开最新任务状态。");
  }
  function setSteps(item, steps, patch = {}) {
    const entries = Object.entries(patch);
    database.prepare(`UPDATE image_task_items SET steps_json=?${entries.map(([key]) => `,${key}=?`).join("")} WHERE task_id=? AND id=?`)
      .run(json(steps), ...entries.map(([, value]) => value), item.task_id, item.id);
  }
  function invalidateAttempt(taskId) {
    for (const item of getItems.all(taskId)) {
      const steps = parse(item.steps_json);
      for (const step of Object.values(steps)) if (step.state === "running") { step.state = "pending"; step.attempts = Math.max(0, step.attempts - 1); }
      setSteps(item, steps, { attempt_token: null });
    }
    if (active?.taskId === taskId) active.controller.abort();
  }
  function freezeResult(userId, id, version) {
    return transaction(() => {
      const row = requireTask(userId, id);
      if (row.result_version != null) return present(row);
      expectVersion(row, version);
      if (!getItems.all(id).some((item) => item.image_id)) throw fail(400, "请至少上传一张图片后再进入人工处理。");
      invalidateAttempt(id);
      changeTask(id, { state: "cancelled", blocked_reason: null, completed_at: row.completed_at || iso(), result_version: row.version + 1 });
      return taskFor(userId, id);
    });
  }

  // A previous process cannot still write to this connection. Restore only its
  // uncommitted step; recognition/annotation checkpoints remain untouched.
  transaction(() => {
    for (const row of database.prepare("SELECT * FROM image_tasks WHERE state='running'").all()) {
      invalidateAttempt(row.id);
      changeTask(row.id, { state: "queued", queue_order: ++queueOrder });
    }
  });

  function nextPhase(item) {
    if (!item.image_id) return null;
    const steps = parse(item.steps_json);
    for (const phase of phases) {
      if (steps[phase].state === "failed") return null;
      if (steps[phase].state !== "succeeded") return { phase, step: steps[phase], steps };
    }
    return null;
  }
  function schedule(delay = 0) {
    if (!enabled || closed || timer || active) return;
    timer = setTimeout(() => { timer = null; void runNext(); }, delay);
    timer.unref?.();
  }
  function validAttempt(taskId, itemId, token) {
    if (closed) return false;
    const task = database.prepare("SELECT state FROM image_tasks WHERE id=?").get(taskId);
    return task?.state === "running" && getItem.get(taskId, itemId)?.attempt_token === token;
  }
  async function perform(task, item, phase, signal) {
    if (phase === "prepare") {
      const image = await ai.getImage(task.user_id, item.image_id);
      const expected = item.base_revision + (item.quarter_turns ? 1 : 0);
      if (image.revision === expected) return publicImage(image);
      if (!item.quarter_turns || image.revision !== item.base_revision)
        throw fail(409, "图片版本已变化，已保留原图，请重新检查方向或手动处理。");
      return publicImage(await ai.rotateImage(task.user_id, item.image_id,
        { quarterTurns: item.quarter_turns, revision: item.base_revision }, { internal: true, taskId: task.id }));
    }
    if (phase === "recognize") return ai.recognizeImage(task.user_id, item.image_id,
      { engine: "llm", priority: "background", persist: false, expectedRevision: item.prepared_revision, signal });
    const draft = parse(item.recognition_json);
    const result = await ai.annotateImage(task.user_id, item.image_id,
      { content: draft.content, manualReadings: [], priority: "background", persist: false,
        draft, expectedRevision: item.prepared_revision, signal });
    if (!Array.isArray(result?.blocks) || plainText(result.blocks) !== plainText(draft.blocks))
      throw fail(502, "注音结果改变了正文，原识别结果已保留，请重试或手动注音。");
    return result;
  }
  async function execute(task, item, phase, token, controller) {
    try {
      const output = await perform(task, item, phase, controller.signal);
      if (!validAttempt(task.id, item.id, token)) return;
      transaction(() => {
        const current = getItem.get(task.id, item.id), steps = parse(current.steps_json);
        steps[phase] = { ...steps[phase], state: "succeeded", error: null, nextRunAt: 0 };
        const patch = { attempt_token: null };
        if (phase === "prepare") { patch.image_json = json(output); patch.prepared_revision = output.revision; }
        else if (phase === "recognize") {
          if (!Array.isArray(output?.blocks)) throw fail(502, "图片识别结果缺少有效正文，请重试或手动录入。");
          patch.recognition_json = json(output);
        } else patch.annotation_json = json(output);
        setSteps(current, steps, patch);
        const complete = getItems.all(task.id).every((value) => phases.every((name) => parse(value.steps_json)[name].state === "succeeded"));
        const currentTask = requireTask(task.user_id, task.id);
        changeTask(task.id, { state: complete ? "ready" : "queued", queue_order: ++queueOrder,
          ...(complete ? { result_version: currentTask.version + 1, completed_at: iso() } : {}) });
      });
    } catch (error) {
      if (!validAttempt(task.id, item.id, token)) return;
      transaction(() => {
        const current = getItem.get(task.id, item.id), steps = parse(current.steps_json), step = steps[phase];
        const authRequired = error.code === "AI_AUTH_REQUIRED" || error.status === 401;
        const busy = error.code === "AI_BUSY";
        const transient = error.name === "TypeError" || [408, 429, 500, 502, 503, 504].includes(error.status) || ["ETIMEDOUT", "ECONNRESET", "ENETUNREACH"].includes(error.code);
        const retry = authRequired || busy || transient && step.attempts <= maxAutomaticRetries;
        const message = authRequired ? "网站 AI 授权需要恢复，请联系网站拥有者；已上传图片和已完成结果均已保留。" : String(error.message || "处理失败，请重试或手动处理。").slice(0, 1000);
        steps[phase] = { ...step, state: retry ? "pending" : "failed", error: message,
          attempts: authRequired || busy ? Math.max(0, step.attempts - 1) : step.attempts,
          nextRunAt: retry ? now() + (authRequired ? blockedRetryMs : retryDelayMs * Math.max(1, step.attempts)) : 0 };
        setSteps(current, steps, { attempt_token: null });
        changeTask(task.id, { state: authRequired ? "blocked" : "queued", blocked_reason: authRequired ? message : null,
          next_run_at: authRequired ? now() + blockedRetryMs : 0, queue_order: ++queueOrder });
      });
    }
  }
  function runNext() {
    if (closed) return Promise.resolve(false);
    if (active) return active.promise;
    let selected;
    transaction(() => {
      const tasks = database.prepare("SELECT * FROM image_tasks WHERE state IN ('queued','blocked') AND next_run_at<=? AND applied_document_id IS NULL ORDER BY queue_order,id LIMIT 100").all(now());
      for (const task of tasks) {
        const items = getItems.all(task.id), candidates = items.map((item) => ({ item, next: nextPhase(item) })).filter(({ next }) => next);
        const candidate = candidates.find(({ next }) => next.step.nextRunAt <= now());
        if (!candidate) {
          if (!candidates.length) {
            const complete = items.length > 0 && items.every((item) => !!item.annotation_json);
            changeTask(task.id, { state: complete ? "ready" : "needs_attention", completed_at: iso(),
              blocked_reason: null, ...(complete ? { result_version: task.version + 1 } : {}) });
          }
          continue;
        }
        const { item, next } = candidate, token = randomUUID(), controller = new AbortController();
        next.steps[next.phase] = { ...next.step, state: "running", attempts: next.step.attempts + 1, error: null };
        setSteps(item, next.steps, { attempt_token: token });
        changeTask(task.id, { state: "running", blocked_reason: null, next_run_at: 0,
          started_at: task.started_at || iso(), queue_order: ++queueOrder });
        selected = { task: requireTask(task.user_id, task.id), item: getItem.get(task.id, item.id), phase: next.phase, token, controller };
        break;
      }
    });
    if (!selected) { schedule(pollIntervalMs); return Promise.resolve(false); }
    const { task, item, phase, token, controller } = selected;
    active = { taskId: task.id, itemId: item.id, token, controller, promise: null };
    active.promise = execute(task, item, phase, token, controller).finally(() => {
      active = null;
      schedule(0);
    });
    return active.promise;
  }
  function assertImageMutable({ userId, imageId }) {
    if (submittingImages.has(imageId)) throw fail(409, "这张图片正在提交任务，方向暂时已固定，请稍后重试。");
    const linked = database.prepare(`SELECT t.id FROM image_task_items i JOIN image_tasks t ON t.id=i.task_id
      WHERE i.image_id=? AND t.user_id=? AND t.state IN ('queued','running','blocked','needs_attention') AND t.applied_document_id IS NULL LIMIT 1`).get(imageId, userId);
    if (linked) throw fail(409, "这张图片已用于提交的任务，方向已固定；请保存结果后再修改文章图片。");
  }
  ai.setImageMutationGuard?.(assertImageMutable);

  app.post("/api/image-tasks", (req, res) => {
    const key = textInput(req.body?.idempotencyKey || "", 200, "请求标识", { empty: false });
    const submitted = destination(req.user.id, req.body || {}, false);
    const creation = json(submitted);
    const existing = database.prepare("SELECT * FROM image_tasks WHERE user_id=? AND idempotency_key=?").get(req.user.id, key);
    if (existing) {
      if (existing.creation_json !== creation) throw fail(409, "同一个请求标识不能用于不同的导入内容。");
      return res.json(present(existing));
    }
    const input = destination(req.user.id, req.body || {});
    const id = randomUUID(), at = iso();
    database.prepare("INSERT INTO image_tasks(id,user_id,state,version,idempotency_key,creation_json,input_json,created_at,updated_at) VALUES(?,?,'draft',1,?,?,?,?,?)")
      .run(id, req.user.id, key, creation, json(input), at, at);
    res.status(201).json(taskFor(req.user.id, id));
  });
  app.get("/api/image-tasks", (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 20)), offset = Math.max(0, Number(req.query.offset) || 0);
    if (!Number.isInteger(limit) || !Number.isInteger(offset)) throw fail(400, "任务分页参数无效。");
    const total = database.prepare("SELECT count(*) AS count FROM image_tasks WHERE user_id=?").get(req.user.id).count;
    const rows = database.prepare(`SELECT * FROM image_tasks WHERE user_id=? ORDER BY
      CASE WHEN applied_document_id IS NOT NULL THEN 6 WHEN state IN ('running','queued') THEN 0 WHEN state='blocked' THEN 1 WHEN state='needs_attention' THEN 2 WHEN state='ready' THEN 3 WHEN state='draft' THEN 4 ELSE 5 END,
      updated_at DESC,id DESC LIMIT ? OFFSET ?`).all(req.user.id, limit, offset);
    const counts = Object.fromEntries(database.prepare("SELECT state,count(*) AS count FROM image_tasks WHERE user_id=? AND applied_document_id IS NULL GROUP BY state").all(req.user.id).map((row) => [row.state, row.count]));
    res.json({ tasks: rows.map((row) => present(row)), total, limit, offset, counts });
  });
  app.get("/api/image-tasks/:id", (req, res) => res.json(taskFor(req.user.id, req.params.id)));
  app.get("/api/image-tasks/:id/result", (req, res) => res.json(resultFor(req.user.id, req.params.id)));
  app.patch("/api/image-tasks/:id", (req, res) => res.json(transaction(() => {
    const row = requireTask(req.user.id, req.params.id), body = req.body || {};
    checkDraft(row); expectVersion(row, body.version);
    const input = destination(req.user.id, { ...parse(row.input_json), ...body });
    let items = getItems.all(row.id);
    if (body.removeItemIds !== undefined) {
      if (!Array.isArray(body.removeItemIds) || body.removeItemIds.some((id) => !items.some((item) => item.id === id))) throw fail(400, "移除图片列表无效。");
      for (const id of body.removeItemIds) database.prepare("DELETE FROM image_task_items WHERE task_id=? AND id=?").run(row.id, id);
      items = getItems.all(row.id);
    }
    const order = body.itemOrder ?? body.itemsOrder;
    if (order !== undefined) {
      if (!Array.isArray(order) || order.length !== items.length || new Set(order).size !== items.length || order.some((id) => !items.some((item) => item.id === id))) throw fail(400, "图片顺序必须包含当前全部图片且不能重复。");
      order.forEach((id, position) => database.prepare("UPDATE image_task_items SET position=? WHERE task_id=? AND id=?").run(position, row.id, id));
    }
    if (body.itemDirections !== undefined) {
      if (!body.itemDirections || Array.isArray(body.itemDirections) || typeof body.itemDirections !== "object") throw fail(400, "图片方向无效。");
      for (const [id, turns] of Object.entries(body.itemDirections)) {
        if (!items.some((item) => item.id === id) || !Number.isInteger(turns) || turns < 0 || turns > 3) throw fail(400, "图片方向无效。");
        database.prepare("UPDATE image_task_items SET quarter_turns=? WHERE task_id=? AND id=?").run(turns, row.id, id);
      }
    }
    changeTask(row.id, { input_json: json(input) });
    return taskFor(req.user.id, row.id);
  })));
  app.post("/api/image-tasks/:id/items", (req, res) => res.json(transaction(() => {
    const row = requireTask(req.user.id, req.params.id), requested = req.body?.items;
    checkDraft(row);
    if (!Array.isArray(requested) || !requested.length || requested.length > 100 || requested.some((item) => !item || typeof item !== "object") || new Set(requested.map((item) => item.id)).size !== requested.length)
      throw fail(400, "请选择有效的图片条目，每批最多 100 张。");
    const items = getItems.all(row.id);
    const normalized = requested.map((item) => {
      if (!identifier(item.id)) throw fail(400, "图片条目标识无效。");
      return { id: item.id, name: textInput(item.name || "粘贴的截图", 200, "图片名称", { empty: false }) };
    });
    if (normalized.every((item) => items.some((old) => old.id === item.id && old.name === item.name))) return present(row);
    expectVersion(row, req.body.version);
    const added = normalized.filter((item) => !items.some((old) => old.id === item.id));
    if (items.length + added.length > 100) throw fail(400, "每篇文章最多支持 100 张图片。");
    if (normalized.some((item) => items.some((old) => old.id === item.id && old.name !== item.name))) throw fail(409, "图片条目标识已用于不同文件。");
    let position = items.length ? Math.max(...items.map((item) => item.position)) + 1 : 0;
    for (const item of added) database.prepare("INSERT INTO image_task_items(task_id,id,position,name,steps_json) VALUES(?,?,?,?,?)")
      .run(row.id, item.id, position++, item.name, json(initialSteps()));
    changeTask(row.id);
    return taskFor(req.user.id, row.id);
  })));
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1, fields: 0 } });
  const uploads = new Map();
  app.post("/api/image-tasks/:id/items/:itemId/image", upload.single("image"), async (req, res) => {
    const task = requireTask(req.user.id, req.params.id), item = getItem.get(task.id, req.params.itemId);
    if (!item) throw fail(404, "找不到这张待上传图片。");
    if (!req.file) throw fail(400, "请选择一张图片。");
    const hash = createHash("sha256").update(req.file.buffer).digest("hex"), key = `${task.id}:${item.id}`;
    if (item.image_id) {
      if (item.upload_hash !== hash) throw fail(409, "这张图片条目已经上传了其他文件，请新增图片或重新选择原文件。");
      return res.json(taskFor(req.user.id, task.id));
    }
    checkDraft(task);
    if (uploads.has(key)) {
      await uploads.get(key);
      const stored = getItem.get(task.id, item.id);
      if (stored?.upload_hash !== hash) throw fail(409, "另一设备已为这个条目上传了不同图片。");
      return res.json(taskFor(req.user.id, task.id));
    }
    const pending = (async () => {
      // The draft's JSON name preserves Unicode; multipart originalname may
      // have been decoded as Latin-1 by the upload parser.
      const image = await ai.saveImage(req.user.id, req.file.buffer, { mimeType: req.file.mimetype, originalName: item.name });
      if (closed) throw fail(503, "服务正在停止，请重新连接确认上传结果。");
      transaction(() => {
        const current = requireTask(req.user.id, task.id);
        checkDraft(current);
        if (!getItem.get(task.id, item.id)) throw fail(409, "这张图片已在其他设备移除。");
        database.prepare("UPDATE image_task_items SET image_id=?,image_json=?,upload_hash=?,base_revision=? WHERE task_id=? AND id=?")
          .run(image.id, json(publicImage(image)), hash, image.revision, task.id, item.id);
        changeTask(task.id);
      });
    })();
    uploads.set(key, pending);
    try { await pending; } finally { uploads.delete(key); }
    res.json(taskFor(req.user.id, task.id));
  });
  app.post("/api/image-tasks/:id/submit", async (req, res) => {
    const initial = requireTask(req.user.id, req.params.id);
    if (initial.submitted_at) return res.status(202).json(present(initial));
    const snapshots = getItems.all(initial.id);
    const imageIds = snapshots.filter((item) => item.image_id).map((item) => item.image_id);
    if (imageIds.some((id) => ai.isImageMutating?.(id)))
      throw fail(409, "图片方向正在保存，请完成后再提交任务。");
    // Hold every input before reading any metadata. Otherwise image A could
    // rotate after its read while submission is still awaiting image B.
    for (const id of imageIds) submittingImages.set(id, (submittingImages.get(id) || 0) + 1);
    try {
      const images = new Map(await Promise.all(imageIds.map(async (id) => [id, await ai.getImage(req.user.id, id)])));
      if (closed) throw fail(503, "服务正在停止，请重新连接确认任务状态。");
      const result = transaction(() => {
        const row = requireTask(req.user.id, req.params.id);
        if (row.submitted_at) return present(row);
        checkDraft(row); expectVersion(row, req.body?.version);
        const items = getItems.all(row.id);
        if (!items.length || items.some((item) => !item.image_id)) throw fail(400, "请先上传全部图片，或移除尚未上传的条目。");
        if (items.some((item) => images.get(item.image_id)?.revision !== item.base_revision || ai.isImageMutating?.(item.image_id)))
          throw fail(409, "图片方向正在保存或已变化，请刷新准备页后重新确认。");
        const input = destination(req.user.id, parse(row.input_json));
        if (input.createNewBook && !input.newBookTitle) throw fail(400, "请填写新书籍名称后再提交识别。");
        const checked = validateDestination(req.user.id, input) || {};
        if ((checked.existingImageCount || 0) + items.length > 100) throw fail(400, "每篇文章最多保存 100 张图片，请选择另一篇文章或新建文章。");
        changeTask(row.id, { state: "queued", input_json: json(input), submitted_at: iso(), queue_order: ++queueOrder });
        return taskFor(req.user.id, row.id);
      });
      res.status(202).json(result); schedule(0);
    } finally {
      for (const id of imageIds) {
        const remaining = submittingImages.get(id) - 1;
        if (remaining) submittingImages.set(id, remaining);
        else submittingImages.delete(id);
      }
    }
  });
  app.post("/api/image-tasks/:id/retry", (req, res) => {
    const result = transaction(() => {
      const row = requireTask(req.user.id, req.params.id);
      if (row.applied_document_id || row.result_version != null) throw fail(409, "结果已固定用于校对或保存，不能再由后台改写。");
      if (!["needs_attention", "blocked"].includes(row.state)) throw fail(409, "任务当前不需要重试。");
      expectVersion(row, req.body?.version);
      for (const item of getItems.all(row.id)) {
        const steps = parse(item.steps_json);
        for (const step of Object.values(steps)) if (step.state !== "succeeded") Object.assign(step, { state: "pending", attempts: 0, error: null, nextRunAt: 0 });
        setSteps(item, steps, { attempt_token: null });
      }
      changeTask(row.id, { state: "queued", completed_at: null, blocked_reason: null, next_run_at: 0, queue_order: ++queueOrder });
      return taskFor(req.user.id, row.id);
    });
    res.status(202).json(result); schedule(0);
  });
  app.post("/api/image-tasks/:id/cancel", (req, res) => {
    if (req.body?.freezeResult) return res.json(freezeResult(req.user.id, req.params.id, req.body.version));
    res.json(transaction(() => {
      const row = requireTask(req.user.id, req.params.id);
      if (row.state === "cancelled" || row.state === "ready") return present(row);
      expectVersion(row, req.body?.version);
      invalidateAttempt(row.id);
      changeTask(row.id, { state: "cancelled", blocked_reason: null, completed_at: row.completed_at || iso() });
      return taskFor(req.user.id, row.id);
    }));
  });
  app.post("/api/image-tasks/:id/items/:itemId/annotate", async (req, res) => {
    const task = requireTask(req.user.id, req.params.id), item = getItem.get(task.id, req.params.itemId);
    if (task.result_version == null || req.body?.resultVersion !== task.result_version || task.applied_document_id)
      throw fail(409, "请使用当前固定的校对结果生成注音。");
    if (!item?.image_id) throw fail(404, "找不到这张来源图片。");
    const content = req.body?.content;
    if (typeof content !== "string" || !content.trim() || content.length > 600000) throw fail(400, "请先输入有效的正文。");
    const input = parse(task.input_json), draft = parse(item.recognition_json) || {
      title: input.title || "手动录入正文", kind: input.bookId || input.newBookTitle ? "book" : "article",
      orientation: "horizontal", blocks: parseText(content), warnings: [], nonBody: [], content,
    };
    const image = await ai.getImage(req.user.id, item.image_id);
    const result = await ai.annotateImage(req.user.id, item.image_id, {
      content, manualReadings: req.body.manualReadings || [], draft,
      expectedRevision: image.revision, priority: "interactive", persist: false, signal: req.aiSignal,
    });
    if (closed) throw fail(503, "服务正在停止，请重新连接。");
    transaction(() => {
      const current = requireTask(req.user.id, task.id);
      if (current.result_version !== task.result_version || current.applied_document_id)
        throw fail(409, "任务结果已保存，本次迟到注音没有应用。");
      const latest = getItem.get(task.id, item.id), content = serializeBlocks(result.blocks);
      const reviews = (parse(latest.review_annotations_json) || [])
        .filter((review) => serializeBlocks(review.blocks) !== content);
      reviews.push(result);
      database.prepare("UPDATE image_task_items SET review_annotations_json=? WHERE task_id=? AND id=?")
        .run(json(reviews.slice(-3)), task.id, item.id);
    });
    res.json(result);
  });
  app.post("/api/image-tasks/:id/apply", (req, res) => res.json(transaction(() => {
    const row = requireTask(req.user.id, req.params.id);
    const fingerprint = adoptionHash(req.body?.document, req.body?.resultVersion);
    const readApplied = (id) => {
      if (!getAppliedDocument) throw fail(409, "这份结果已经保存，请打开已保存的文章。");
      return getAppliedDocument(req.user.id, id);
    };
    const saveDocument = () => {
      if (!applyResult) throw fail(501, "文章保存暂未接入。");
      const result = resultFor(req.user.id, row.id);
      const document = applyResult({ task: present(row), document: req.body.document, userId: req.user.id, sourceImages: result.sourceImages });
      if (!document?.id || typeof document.then === "function") throw new Error("Task applyResult must synchronously return the saved document.");
      return document;
    };
    if (row.applied_document_id) {
      if (row.applied_input_hash === fingerprint) return readApplied(row.applied_document_id);
      const value = req.body?.document;
      if (!value || value.saveAsNew !== true || value.id)
        throw fail(409, "这份任务已在其他页面保存，当前编辑不能作为重复请求丢弃。请打开已保存文章，或将当前内容另存为新文章。");
      if (req.body?.resultVersion !== row.result_version)
        throw fail(409, "校对结果版本已变化，请重新打开任务结果。");
      const copies = parse(row.applied_copies_json) || {};
      if (copies[fingerprint]) return readApplied(copies[fingerprint]);
      const document = saveDocument();
      changeTask(row.id, { applied_copies_json: json({ ...copies, [fingerprint]: document.id }) });
      return document;
    }
    expectVersion(row, req.body?.version);
    if (row.result_version == null || req.body?.resultVersion !== row.result_version || !["ready", "cancelled"].includes(row.state))
      throw fail(409, "校对结果版本已变化，请重新打开任务结果。");
    const document = saveDocument();
    changeTask(row.id, { applied_document_id: document.id, applied_at: iso(), applied_input_hash: fingerprint });
    return document;
  })));

  function close() {
    if (closed) return;
    clearTimeout(timer); timer = null;
    transaction(() => {
      if (active) {
        const task = database.prepare("SELECT * FROM image_tasks WHERE id=?").get(active.taskId);
        if (task?.state === "running") { invalidateAttempt(task.id); changeTask(task.id, { state: "queued", queue_order: ++queueOrder }); }
      }
    });
    closed = true;
    active?.controller.abort();
  }
  schedule(0);
  return { getTask: taskFor, getResult: resultFor, freezeResult, assertImageMutable, runNext,
    close, stop: close, drain: () => active?.promise || Promise.resolve() };
}
