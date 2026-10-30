import express from "express";
import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAIRoutes } from "./ai/routes.mjs";
import { attachAccountRoutes } from "./accounts.mjs";
import { attachBookRoutes } from "./books.mjs";
import { attachImageTaskRoutes } from "./image-tasks.mjs";
import {
  parseText,
  serializeBlocks,
  plainText,
  stats,
} from "../shared/document.mjs";
import { splitRubyDisplay } from "../shared/ruby-display.mjs";
import {
  blocksToHtml, htmlToBlocks, normalizeBodyHtml, bodyText, bodyRanges,
  editBodyText, syncBodyReadings, sourceBodyHtml,
} from "../shared/article-html.mjs";
const hashBody = (html) => createHash("sha256").update(bodyText(html)).digest("hex");

const kinds = new Set(["lyrics", "article", "textbook", "book"]);
const orientations = new Set(["horizontal", "vertical"]);
const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
const rootDir = fileURLToPath(new URL("../", import.meta.url));

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const htmlEscape = (value) =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

function markdown(document) {
  const ranges = bodyRanges(document.bodyHtml);
  if (ranges.sentences.length || ranges.sources.length || ranges.qa.length)
    return `# ${htmlEscape(document.title)}\n\n${document.bodyHtml}\n`;
  const paragraphs = document.blocks
    .map((block) => {
      const text = block.segments
        .map((segment) => {
          const parts = splitRubyDisplay(segment.text, segment.reading);
          const text = parts.map((part) => {
            const base = htmlEscape(part.text);
            return part.reading
              ? `<ruby>${base}<rp>（</rp><rt>${htmlEscape(part.reading)}</rt><rp>）</rp></ruby>`
              : base;
          }).join("");
          return segment.reading && !parts.some((part) => part.reading)
            ? `<span title="${htmlEscape(segment.reading)}">${text}</span>`
            : text;
        })
        .join("");
      if (!text) return "";
      if (block.type === "heading") return `\n## ${text}\n`;
      if (block.type === "list_item") return `- ${text}`;
      return `${text}  `;
    })
    .join("\n");
  return `# ${htmlEscape(document.title)}\n\n${paragraphs}\n`;
}

function validateInput(input, updating = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "请提供文章内容。");
  }
  const { title, kind, orientation, content, bodyHtml, revision } = input;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
    throw new HttpError(400, "标题需要填写，最多 160 个字符。");
  }
  if (!kinds.has(kind)) throw new HttpError(400, "请选择有效的材料类型。");
  if (!orientations.has(orientation))
    throw new HttpError(400, "请选择横排或竖排。");
  if (
    bodyHtml === undefined && (typeof content !== "string" ||
    !content.trim() || content.length > 600_000)
  ) {
    throw new HttpError(400, "正文或注音内容过长，请缩短后再保存。");
  }
  if (updating && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new HttpError(400, "缺少有效的文档版本，请重新打开后再保存。");
  }
  return { title: title.trim(), kind, orientation: "horizontal", content, bodyHtml, revision };
}

function parseContent(content, previous = [], manualReadings = []) {
  try {
    const blocks = parseText(content, previous);
    if (!Array.isArray(manualReadings) || manualReadings.length > 20000)
      throw new HttpError(400, "手动注音记录格式无效。");
    for (const edited of manualReadings) {
      if (
        !edited ||
        typeof edited.blockId !== "string" ||
        !Number.isInteger(edited.rubyIndex) ||
        typeof edited.text !== "string" ||
        typeof edited.reading !== "string"
      )
        throw new HttpError(400, "手动注音记录格式无效。");
      const block = blocks.find((b) => b.id === edited.blockId);
      const segment = block?.segments.filter((s) => s.reading)[
        edited.rubyIndex
      ];
      if (segment?.text === edited.text && segment.reading === edited.reading)
        segment.origin = "manual";
    }
    const text = plainText(blocks);
    if (!text.trim() || text.length > 200_000) {
      throw new HttpError(
        400,
        "正文需要填写，最多 200000 个字符（不含注音）。",
      );
    }
    return blocks;
  } catch (error) {
    throw new HttpError(400, error.message || "振假名格式有误，请检查正文。");
  }
}

function fromRow(row) {
  const bodyHtml = row.body_html || blocksToHtml(JSON.parse(row.blocks_json), { sourceImageId: row.source_image_id });
  const blocks = htmlToBlocks(bodyHtml);
  const recognition = row.recognition_json ? JSON.parse(row.recognition_json) : null;
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    orientation: "horizontal",
    sourceOrientation:
      recognition?.sourceOrientation || recognition?.orientation ||
      row.orientation,
    content: serializeBlocks(blocks),
    blocks,
    bodyHtml,
    bodyHash: row.body_hash || hashBody(bodyHtml),
    sourceImages: row.source_images_json ? JSON.parse(row.source_images_json) :
      (row.source_image_id ? [{ id: row.source_image_id, recognition }] : []),
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceImageId: row.source_image_id || null,
    recognition,
    ...(row.book_id ? { bookId: row.book_id, position: row.page_position } : {}),
  };
}

function summary(row) {
  const document = fromRow(row);
  const counts = stats(document.blocks);
  return {
    id: document.id,
    title: document.title,
    kind: document.kind,
    orientation: document.orientation,
    preview: plainText(document.blocks).slice(0, 120),
    charCount: counts.charCount,
    rubyCount: counts.rubyCount,
    revision: document.revision,
    createdAt: document.createdAt,
    updatedAt: document.updatedAt,
    ...(document.bookId ? { bookId: document.bookId, position: document.position,
      sourceImageId: document.sourceImageId } : {}),
  };
}

export function createApp({
  dataDir = join(rootDir, "data"),
  publicOrigin = process.env.PUBLIC_ORIGIN,
  publicOrigins = process.env.PUBLIC_ORIGINS || "",
  callbackUri = `http://127.0.0.1:${process.env.PORT || 4317}/auth/callback`,
  aiServices,
  mangaOcr,
  ndlOcr,
  imageTaskOptions = {},
} = {}) {
  const sites = [publicOrigin, ...publicOrigins.split(",")]
    .filter((value) => value?.trim())
    .map((value) => {
      const origin = value.trim();
      const site = new URL(origin);
      if (!["http:", "https:"].includes(site.protocol) ||
        site.origin !== origin || site.username || site.password)
        throw new Error("PUBLIC_ORIGIN / PUBLIC_ORIGINS 必须是完整站点来源，例如 https://reader.example:8443。");
      return site;
    });
  const allowedOrigins = new Set(sites.map((site) => site.origin));
  const allowedHosts = new Set(sites.map((site) => site.host));
  const storageDir = resolve(dataDir);
  mkdirSync(storageDir, { recursive: true, mode: 0o700 });
  chmodSync(storageDir, 0o700);
  const databasePath = join(storageDir, "yohaku.sqlite");
  const database = new DatabaseSync(databasePath);
  chmodSync(databasePath, 0o600);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL,
      orientation TEXT NOT NULL,
      blocks_json TEXT NOT NULL,
      plain_text TEXT NOT NULL,
      revision INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  const read = database.prepare("SELECT * FROM documents WHERE id = ?");
  const columns = database
    .prepare("PRAGMA table_info(documents)")
    .all()
    .map((column) => column.name);
  if (!columns.includes("source_image_id"))
    database.exec("ALTER TABLE documents ADD COLUMN source_image_id TEXT");
  if (!columns.includes("recognition_json"))
    database.exec("ALTER TABLE documents ADD COLUMN recognition_json TEXT");
  if (!columns.includes("owner_id"))
    database.exec("ALTER TABLE documents ADD COLUMN owner_id TEXT");
  for (const [name, definition] of [["body_html", "TEXT"], ["body_hash", "TEXT"], ["source_images_json", "TEXT"]]) {
    if (!columns.includes(name)) database.exec(`ALTER TABLE documents ADD COLUMN ${name} ${definition}`);
  }
  const requireDocument = (userId, id) => {
    const row = database
      .prepare("SELECT * FROM documents WHERE id=? AND owner_id=?")
      .get(id, userId);
    if (!row) throw new HttpError(404, "找不到这篇材料，可能已经删除。");
    return row;
  };
  const app = express();
  app.disable("x-powered-by");
  if (sites.length) app.set("trust proxy", "loopback");
  app.use((req, _res, next) => {
    try {
      const host = req.headers.host;
      if (
        typeof host !== "string" ||
        (!allowedHosts.has(host) &&
          !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host))
      ) {
        throw new Error("host");
      }
      const authority = new URL(`http://${host}`);
      if (!localHosts.has(authority.hostname) && !allowedHosts.has(host)) throw new Error("host");
    } catch {
      return next(new HttpError(403, "只允许通过本机或已配置的站点地址访问。"));
    }
    next();
  });
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(req.method) &&
      req.headers.origin
    ) {
      try {
        const origin = new URL(req.headers.origin);
        if (
          !(sites.length ? allowedOrigins.has(origin.origin) : localHosts.has(origin.hostname)) ||
          !["http:", "https:"].includes(origin.protocol) ||
          origin.origin !== req.headers.origin
        )
          throw new Error("origin");
      } catch {
        return next(new HttpError(403, "只接受已允许的页面来源提交。"));
      }
    }
    next();
  });
  app.use(express.json({ limit: "1mb" }));
  const accounts = attachAccountRoutes({
    app,
    database,
    onFirstUser: (id) => {
      database
        .prepare("UPDATE documents SET owner_id=? WHERE owner_id IS NULL")
        .run(id);
      database
        .prepare("UPDATE image_drafts SET user_id=? WHERE user_id IS NULL")
        .run(id);
      database
        .prepare("UPDATE conversations SET user_id=? WHERE user_id IS NULL")
        .run(id);
      database
        .prepare(
          "INSERT OR IGNORE INTO app_settings(key,value) VALUES('legacy_owner',?)",
        )
        .run(id);
    },
  });
  app.use("/api", (req, res, next) =>
    req.path === "/health" ? next() : accounts.requireUser(req, res, next),
  );
  const ai = attachAIRoutes({
    app,
    database,
    storageDir,
    callbackUri,
    services: aiServices,
    mangaOcr,
    ndlOcr,
  });
  const books = attachBookRoutes({ app, database, summary, requireDocument });
  // Material IDs and legacy book membership are unchanged. Existing photos are
  // attached to their original text; old pages remain individual articles.
  const migrateBody = database.prepare("UPDATE documents SET body_html=?,body_hash=?,source_images_json=? WHERE id=?");
  for (const row of database.prepare("SELECT * FROM documents WHERE body_html IS NULL").all()) {
    const html = blocksToHtml(JSON.parse(row.blocks_json), { sourceImageId: row.source_image_id });
    const recognition = row.recognition_json ? JSON.parse(row.recognition_json) : null;
    migrateBody.run(html, hashBody(html), JSON.stringify(row.source_image_id ? [{ id: row.source_image_id, recognition }] : []), row.id);
  }

  async function articleImages(userId, input, previous = []) {
    if (input.sourceImageId != null && typeof input.sourceImageId !== "string") throw new HttpError(400, "图片来源标识无效。");
    if (input.sourceImageId) await ai.getImage(userId, input.sourceImageId);
    const requested = input.sourceImages ?? (input.sourceImageId ? [{ id: input.sourceImageId }] : previous);
    if (!Array.isArray(requested) || requested.length > 100 || requested.some((image) => !image || typeof image.id !== "string" || !image.id) || new Set(requested.map((image) => image.id)).size !== requested.length)
      throw new HttpError(400, "文章来源图片列表无效，最多 100 张且不能重复。");
    const result = [];
    for (const { id } of requested) {
      await ai.getImage(userId, id);
      const old = previous.find((image) => image.id === id);
      const storedDraft = database.prepare("SELECT draft_json FROM image_drafts WHERE image_id=? AND user_id=?").get(id, userId);
      if (!storedDraft && !old) throw new HttpError(400, "这张图片尚未完成识别，请先识别再保存草稿。");
      result.push(old || { id, recognition: JSON.parse(storedDraft.draft_json) });
    }
    return result;
  }

  function articleBody(input, previousBlocks, manualReadings, sourceImages, previousHtml) {
    let html;
    if (input.bodyHtml !== undefined) {
      html = normalizeBodyHtml(input.bodyHtml);
      // Older clients forward the unchanged HTML while editing brace notation.
      // A deliberately changed HTML body is authoritative over forwarded content.
      const canonicalBlocks = htmlToBlocks(html);
      const legacyContentEdit = previousHtml && html === normalizeBodyHtml(previousHtml) && typeof input.content === "string";
      const blocks = parseContent(legacyContentEdit ? input.content : serializeBlocks(canonicalBlocks), canonicalBlocks, manualReadings);
      html = syncBodyReadings(editBodyText(html, plainText(blocks)), blocks);
    } else {
      const blocks = parseContent(input.content, previousBlocks, manualReadings);
      html = previousHtml ? syncBodyReadings(editBodyText(previousHtml, plainText(blocks)), blocks)
        : blocksToHtml(blocks, { sourceImageId: sourceImages[0]?.id });
    }
    const text = bodyText(html);
    if (!text.trim() || text.length > 200_000) throw new HttpError(400, "正文需要填写，最多 200000 个字符（不含注音）。");
    const imageIds = new Set(sourceImages.map((image) => image.id));
    if (bodyRanges(html).sources.some((range) => !imageIds.has(range.id)))
      throw new HttpError(400, "正文引用了不属于这篇文章的图片来源。");
    return { html, blocks: htmlToBlocks(html), text, hash: hashBody(html) };
  }

  function validateQaReferences(html, userId, documentId) {
    const refs = [...new Set(bodyRanges(html).qa.map((range) => range.id))];
    if (!refs.length) return;
    if (!database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qa_groups'").get())
      throw new HttpError(400, "正文引用的问答组不存在。");
    const readGroup = database.prepare("SELECT id FROM qa_groups WHERE id=? AND user_id=? AND document_id=?");
    if (refs.some((id) => !documentId || !readGroup.get(id, userId, documentId)))
      throw new HttpError(400, "正文引用了不属于当前账号或文章的问答组。");
  }

  // Call inside the caller's transaction so task adoption and article changes
  // commit together. The same validation applies to ordinary article saves.
  function writeArticle(userId, value, sourceImages, old = null) {
    const input = validateInput(value, !!old);
    if (old && input.revision !== old.revision)
      throw new HttpError(409, "这篇材料已在其他页面修改。请保留当前文字，重新打开最新版本后再保存。");
    const requestedBookId = value.bookId;
    if (requestedBookId !== undefined && requestedBookId !== null &&
        (typeof requestedBookId !== "string" || !requestedBookId))
      throw new HttpError(400, "请选择有效的书籍。");
    if (old?.book_id && requestedBookId !== undefined && requestedBookId !== old.book_id)
      throw new HttpError(409, "这页已经属于一本书，不能通过编辑移动或移出书籍。");
    const bookId = old?.book_id || requestedBookId || null;
    if (bookId) books.requireBook(userId, bookId);
    const previous = old ? fromRow(old) : null;
    const recognition = sourceImages[0]?.recognition || null;
    const body = articleBody(input, previous?.blocks || recognition?.annotation?.blocks || recognition?.blocks || [],
      value.manualReadings, sourceImages, previous?.bodyHtml);
    const filledSources = new Set(bodyRanges(body.html).sources.filter((source) => source.text.trim()).map((source) => source.id));
    sourceImages = sourceImages.map((image) => !image.recognition || Object.hasOwn(image, "manualRequired")
      ? { ...image, manualRequired: !filledSources.has(image.id),
        ...(!image.recognition && filledSources.has(image.id) ? { origin:"manual" } : {}) } : image);
    validateQaReferences(body.html, userId, old?.id);
    const now = new Date().toISOString(), id = old?.id || randomUUID();
    const position = old?.book_id ? old.page_position : bookId ? database.prepare(
      "SELECT count(*)+1 AS position FROM documents WHERE book_id=? AND owner_id=?",
    ).get(bookId, userId).position : null;
    const fields = [input.title, input.kind, input.orientation, JSON.stringify(body.blocks), body.text,
      now, bookId, position, body.html, body.hash, JSON.stringify(sourceImages),
      sourceImages[0]?.id || null, recognition ? JSON.stringify(recognition) : null];
    if (old) {
      const updated = database.prepare(`UPDATE documents SET title=?,kind=?,orientation=?,blocks_json=?,plain_text=?,
        revision=revision+1,updated_at=?,book_id=?,page_position=?,body_html=?,body_hash=?,source_images_json=?,
        source_image_id=?,recognition_json=? WHERE id=? AND owner_id=? AND revision=?`)
        .run(...fields, id, userId, input.revision);
      if (updated.changes !== 1) throw new HttpError(409, "文档版本已更新，请重新打开后再保存。");
    } else database.prepare(`INSERT INTO documents
      (title,kind,orientation,blocks_json,plain_text,updated_at,book_id,page_position,body_html,body_hash,
       source_images_json,source_image_id,recognition_json,id,owner_id,revision,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)`).run(...fields, id, userId, now);
    if (bookId) books.touch(userId, bookId, now);
    return fromRow(read.get(id));
  }

  function validateTaskDestination(userId, { bookId, targetId }, { allowMissing = false } = {}) {
    let bookTitle = "";
    if (bookId) {
      try { bookTitle = books.requireBook(userId, bookId).title; }
      catch (error) { if (!allowMissing || error.status !== 404) throw error; }
    }
    if (!targetId) return { bookTitle, targetTitle: "" };
    let target;
    try { target = requireDocument(userId, targetId); }
    catch (error) { if (!allowMissing || error.status !== 404) throw error; return { bookTitle, targetTitle: "" }; }
    if ((target.book_id || null) !== (bookId || null))
      throw new HttpError(400, "请选择该书籍中的文章。");
    return { targetRevision: target.revision, bookTitle, targetTitle: target.title,
      existingImageCount: fromRow(target).sourceImages.length };
  }

  function applyTaskResult({ task, document: value, userId, sourceImages }) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new HttpError(400, "请提供校对后的文章。");
    const old = value.id ? requireDocument(userId, value.id) : null;
    if (old && old.id !== task.targetId)
      throw new HttpError(400, "这不是任务选择的目标文章，请将结果另存为新文章。");
    const sourceDocument = old || (task.targetId
      ? database.prepare("SELECT * FROM documents WHERE id=? AND owner_id=?").get(task.targetId, userId) : null);
    const previous = sourceDocument ? fromRow(sourceDocument).sourceImages : [];
    const allowed = new Map([...sourceImages, ...previous].map((image) => [image.id, image]));
    const requested = value.sourceImages;
    if (!Array.isArray(requested) || requested.length > 100 ||
        requested.some((image) => !image || typeof image.id !== "string") ||
        new Set(requested.map((image) => image.id)).size !== requested.length)
      throw new HttpError(400, "文章来源图片列表无效。");
    // A conflict recovery can copy the current edited article into a new one.
    // Deleted originals still have owned image files, but their old recognition
    // metadata is not taken from the client or invented after deletion.
    if (!old && task.targetId && Array.isArray(requested)) {
      for (const image of requested) if (image && !allowed.has(image.id) &&
        database.prepare("SELECT 1 FROM image_owners WHERE image_id=? AND user_id=?").get(image.id, userId))
        allowed.set(image.id, { id:image.id, recognition:null });
    }
    if (requested.some((image) => !allowed.has(image.id)))
      throw new HttpError(400, "文章来源图片无效，请保留任务中的原图。");
    const images = requested.map(({ id }) => {
      const image = allowed.get(id);
      const { reviewAnnotations, ...source } = image;
      const content = reviewAnnotations?.length && value.bodyHtml
        ? serializeBlocks(htmlToBlocks(sourceBodyHtml(value.bodyHtml, id))) : null;
      const reviewed = content && reviewAnnotations?.find((result) => result.content === content);
      const annotation = reviewed?.annotation;
      return { ...source, recognition: source.recognition
        ? { ...source.recognition, ...(annotation ? { annotation } : {}) } : null,
        ...(!source.recognition && annotation ? { annotation } : {}) };
    });
    let next = { ...value };
    if (!old && !next.bookId && next.newBookTitle) {
      if (typeof next.newBookTitle !== "string" || !next.newBookTitle.trim() || next.newBookTitle.trim().length > 160)
        throw new HttpError(400, "书名需要填写，最多 160 个字符。");
      const bookId = randomUUID(), now = new Date().toISOString();
      database.prepare("INSERT INTO books(id,title,owner_id,revision,created_at,updated_at) VALUES(?,?,?,1,?,?)")
        .run(bookId, next.newBookTitle.trim(), userId, now, now);
      next = { ...next, bookId, kind: "book" };
    }
    return writeArticle(userId, next, images, old);
  }

  const imageTasks = attachImageTaskRoutes({ app, database, ai,
    applyResult: applyTaskResult, validateDestination: validateTaskDestination,
    getAppliedDocument: (userId, id) => fromRow(requireDocument(userId, id)), ...imageTaskOptions });
  ai.setImageMutationGuard(imageTasks.assertImageMutable);

  app.get("/api/health", async (req, res) => {
    const authorization = await ai.statusForUser(req.user?.id);
    return res.json({
      status: "ok",
      storage: "sqlite",
      stage: 3,
      capabilities: {
        textImport: true,
        imageImport: true,
        ai: authorization.connected,
        speech: false,
        notes: false,
      },
      aiVerified:
        authorization.connected && !!authorization.runtime?.lastSuccessfulAt,
    });
  });

  app.get("/api/documents", (req, res) => {
    const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (query.length > 200) throw new HttpError(400, "搜索词最多 200 个字符。");
    let rows;
    const includeBookArticles = req.query.all === "1";
    if (query) {
      const pattern = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
      rows = database
        .prepare(
          `SELECT * FROM documents
        WHERE owner_id=? AND (?=1 OR book_id IS NULL) AND (title LIKE ? ESCAPE '!' OR plain_text LIKE ? ESCAPE '!')
        ORDER BY updated_at DESC, id ASC`,
        )
        .all(req.user.id, includeBookArticles ? 1 : 0, pattern, pattern);
    } else {
      rows = database
        .prepare(
          "SELECT * FROM documents WHERE owner_id=? AND (?=1 OR book_id IS NULL) ORDER BY updated_at DESC, id ASC",
        )
        .all(req.user.id, includeBookArticles ? 1 : 0);
    }
    res.json({ documents: rows.map(summary) });
  });

  app.post("/api/documents", async (req, res) => {
    validateInput(req.body);
    const sourceImages = await articleImages(req.user.id, req.body);
    const result = books.transaction(() => writeArticle(req.user.id, req.body, sourceImages));
    res.status(201).json(result);
  });

  app.get("/api/documents/:id", (req, res) =>
    res.json(fromRow(requireDocument(req.user.id, req.params.id))),
  );

  app.put("/api/documents/:id", async (req, res) => {
    const old = requireDocument(req.user.id, req.params.id);
    const input = validateInput(req.body, true);
    if (input.revision !== old.revision)
      throw new HttpError(409, "这篇材料已在其他页面修改。请保留当前文字，重新打开最新版本后再保存。");
    const sourceImages = await articleImages(req.user.id, req.body, fromRow(old).sourceImages);
    const result = books.transaction(() => writeArticle(req.user.id, req.body, sourceImages, old));
    res.json(result);
  });

  app.delete("/api/documents/:id", (req, res) => {
    const document = requireDocument(req.user.id, req.params.id);
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, "缺少有效的文档版本，请重新打开后再删除。");
    }
    books.transaction(() => {
      const result = database
        .prepare("DELETE FROM documents WHERE id = ? AND revision = ?")
        .run(document.id, revision);
      if (result.changes !== 1) {
        throw new HttpError(
          409,
          "这篇材料已在其他页面修改，请重新打开最新版本后再决定是否删除。",
        );
      }
      if (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='qa_groups'").get())
        database.prepare("DELETE FROM qa_groups WHERE document_id=? AND user_id=?").run(document.id, req.user.id);
      database.prepare("DELETE FROM conversations WHERE document_id=? AND user_id=?").run(document.id, req.user.id);
      if (document.book_id) {
        books.reindex(req.user.id, document.book_id);
        books.touch(req.user.id, document.book_id);
      }
    });
    res.status(204).end();
  });

  app.get("/api/documents/:id/export", (req, res) => {
    const document = fromRow(requireDocument(req.user.id, req.params.id));
    const format = req.query.format || "json";
    if (format !== "json" && format !== "markdown")
      throw new HttpError(400, "请选择 JSON 或 Markdown 导出格式。");
    const filename = `${document.id}.${format === "json" ? "json" : "md"}`;
    res.set("Content-Disposition", `attachment; filename="${filename}"`);
    if (format === "json") {
      res
        .type("application/json")
        .send(JSON.stringify({ schemaVersion: 1, document }, null, 2));
    } else {
      res.type("text/markdown").send(markdown(document));
    }
  });

  app.use("/api", (_req, _res, next) =>
    next(new HttpError(404, "接口不存在。")),
  );
  const staticDir = join(rootDir, "dist");
  app.use(express.static(staticDir));
  app.use((req, res, next) => {
    if (
      req.method === "GET" &&
      req.accepts("html") &&
      existsSync(join(staticDir, "index.html"))
    ) {
      res.sendFile(join(staticDir, "index.html"));
    } else next();
  });
  app.use((_req, res) => res.status(404).json({ error: "页面不存在。" }));
  app.use((error, _req, res, _next) => {
    if (error.code === "LIMIT_FILE_SIZE")
      return res
        .status(413)
        .json({ error: "图片最大 12 MB，请换一张较小的图片。" });
    if (error.name === "MulterError")
      return res
        .status(400)
        .json({ error: "请一次上传一张 PNG、JPEG 或 WebP 图片。" });
    if (error.type === "entity.too.large")
      return res.status(413).json({ error: "提交内容过大，请减少正文长度。" });
    if (error.type === "entity.parse.failed")
      return res.status(400).json({ error: "请求格式有误，请重新提交。" });
    const status = error.status || 500;
    if (status >= 500 && !error.expose)
      console.error("数据库或服务错误：", error.message);
    res.status(status).json({
      ...(["WEBSITE_AUTH_REQUIRED", "TASK_VERSION_CONFLICT", "TASK_RESULT_STALE", "TASK_UNAVAILABLE"].includes(error.code) ? { code: error.code } : {}),
      error:
        status >= 500 && !error.expose
          ? "服务暂时遇到问题，请稍后再试。"
          : error.message,
    });
  });

  let closed = false;
  function close() {
    if (closed) return;
    closed = true;
    imageTasks.close();
    ai.close();
    database.close();
  }
  async function shutdown({ beforeClose = Promise.resolve() } = {}) {
    if (closed) return;
    imageTasks.close();
    ai.close();
    await imageTasks.drain();
    await ai.whenIdle?.();
    await beforeClose;
    close();
  }
  return {
    app,
    ai,
    imageTasks,
    close,
    shutdown,
  };
}
