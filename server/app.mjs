import express from "express";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync, chmodSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { attachAIRoutes } from "./ai/routes.mjs";
import { attachAccountRoutes } from "./accounts.mjs";
import {
  parseText,
  serializeBlocks,
  plainText,
  stats,
} from "../shared/document.mjs";

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
  const paragraphs = document.blocks
    .map((block) =>
      block.segments
        .map((segment) => {
          const base = htmlEscape(segment.text);
          return segment.reading
            ? `<ruby>${base}<rp>（</rp><rt>${htmlEscape(segment.reading)}</rt><rp>）</rp></ruby>`
            : base;
        })
        .join(""),
    )
    .map((line) => (line ? `${line}  ` : ""))
    .join("\n");
  return `# ${htmlEscape(document.title)}\n\n${paragraphs}\n`;
}

function validateInput(input, updating = false) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new HttpError(400, "请提供文章内容。");
  }
  const { title, kind, orientation, content, revision } = input;
  if (typeof title !== "string" || !title.trim() || title.trim().length > 160) {
    throw new HttpError(400, "标题需要填写，最多 160 个字符。");
  }
  if (!kinds.has(kind)) throw new HttpError(400, "请选择有效的材料类型。");
  if (!orientations.has(orientation))
    throw new HttpError(400, "请选择横排或竖排。");
  if (
    typeof content !== "string" ||
    !content.trim() ||
    content.length > 600_000
  ) {
    throw new HttpError(400, "正文或注音内容过长，请缩短后再保存。");
  }
  if (updating && (!Number.isSafeInteger(revision) || revision < 1)) {
    throw new HttpError(400, "缺少有效的文档版本，请重新打开后再保存。");
  }
  return { title: title.trim(), kind, orientation, content, revision };
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
  const blocks = JSON.parse(row.blocks_json);
  return {
    id: row.id,
    title: row.title,
    kind: row.kind,
    orientation: row.orientation,
    content: serializeBlocks(blocks),
    blocks,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    sourceImageId: row.source_image_id || null,
    recognition: row.recognition_json ? JSON.parse(row.recognition_json) : null,
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
  };
}

export function createApp({
  dataDir = join(rootDir, "data"),
  callbackUri = `http://127.0.0.1:${process.env.PORT || 4317}/auth/callback`,
  aiServices,
} = {}) {
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
  const requireDocument = (userId, id) => {
    const row = database
      .prepare("SELECT * FROM documents WHERE id=? AND owner_id=?")
      .get(id, userId);
    if (!row) throw new HttpError(404, "找不到这篇材料，可能已经删除。");
    return row;
  };
  const app = express();
  app.disable("x-powered-by");
  app.use((req, _res, next) => {
    try {
      const host = req.headers.host;
      if (
        typeof host !== "string" ||
        !/^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host)
      ) {
        throw new Error("host");
      }
      const authority = new URL(`http://${host}`);
      if (!localHosts.has(authority.hostname)) throw new Error("host");
    } catch {
      return next(new HttpError(403, "当前版本只允许通过本机地址访问。"));
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
          !localHosts.has(origin.hostname) ||
          !["http:", "https:"].includes(origin.protocol) ||
          origin.origin !== req.headers.origin
        )
          throw new Error("origin");
      } catch {
        return next(new HttpError(403, "当前版本只接受本机页面提交。"));
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
  });

  app.get("/api/health", async (req, res) => {
    const authorization = await ai.statusForUser(req.user?.id);
    return res.json({
      status: "ok",
      storage: "sqlite",
      stage: 2,
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
    if (query) {
      const pattern = `%${query.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_")}%`;
      rows = database
        .prepare(
          `SELECT * FROM documents
        WHERE owner_id=? AND (title LIKE ? ESCAPE '!' OR plain_text LIKE ? ESCAPE '!')
        ORDER BY updated_at DESC, id ASC`,
        )
        .all(req.user.id, pattern, pattern);
    } else {
      rows = database
        .prepare(
          "SELECT * FROM documents WHERE owner_id=? ORDER BY updated_at DESC, id ASC",
        )
        .all(req.user.id);
    }
    res.json({ documents: rows.map(summary) });
  });

  app.post("/api/documents", async (req, res) => {
    const input = validateInput(req.body);
    const sourceImageId = req.body.sourceImageId || null;
    let recognition = null;
    if (sourceImageId) {
      await ai.getImage(req.user.id, sourceImageId);
      const storedDraft = database
        .prepare(
          "SELECT draft_json FROM image_drafts WHERE image_id=? AND user_id=?",
        )
        .get(sourceImageId, req.user.id);
      if (!storedDraft)
        throw new HttpError(400, "这张图片尚未完成识别，请先识别再保存草稿。");
      recognition = JSON.parse(storedDraft.draft_json);
    }
    const blocks = parseContent(
      input.content,
      recognition?.blocks || [],
      req.body.manualReadings,
    );
    const id = randomUUID();
    const now = new Date().toISOString();
    database
      .prepare(
        `INSERT INTO documents
      (id, title, kind, orientation, blocks_json, plain_text, revision, created_at, updated_at, owner_id)
      VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
      )
      .run(
        id,
        input.title,
        input.kind,
        input.orientation,
        JSON.stringify(blocks),
        plainText(blocks),
        now,
        now,
        req.user.id,
      );
    if (recognition)
      database
        .prepare(
          "UPDATE documents SET source_image_id=?,recognition_json=? WHERE id=?",
        )
        .run(sourceImageId, JSON.stringify(recognition), id);
    res.status(201).json(fromRow(read.get(id)));
  });

  app.get("/api/documents/:id", (req, res) =>
    res.json(fromRow(requireDocument(req.user.id, req.params.id))),
  );

  app.put("/api/documents/:id", (req, res) => {
    const old = requireDocument(req.user.id, req.params.id);
    const input = validateInput(req.body, true);
    if (input.revision !== old.revision) {
      throw new HttpError(
        409,
        "这篇材料已在其他页面修改。请保留当前文字，重新打开最新版本后再保存。",
      );
    }
    const blocks = parseContent(
      input.content,
      JSON.parse(old.blocks_json),
      req.body.manualReadings,
    );
    const result = database
      .prepare(
        `UPDATE documents SET title = ?, kind = ?, orientation = ?,
      blocks_json = ?, plain_text = ?, revision = revision + 1, updated_at = ?
      WHERE id = ? AND revision = ?`,
      )
      .run(
        input.title,
        input.kind,
        input.orientation,
        JSON.stringify(blocks),
        plainText(blocks),
        new Date().toISOString(),
        old.id,
        input.revision,
      );
    if (result.changes !== 1)
      throw new HttpError(409, "文档版本已更新，请重新打开后再保存。");
    res.json(fromRow(read.get(old.id)));
  });

  app.delete("/api/documents/:id", (req, res) => {
    const document = requireDocument(req.user.id, req.params.id);
    const revision = req.body?.revision;
    if (!Number.isSafeInteger(revision) || revision < 1) {
      throw new HttpError(400, "缺少有效的文档版本，请重新打开后再删除。");
    }
    const result = database
      .prepare("DELETE FROM documents WHERE id = ? AND revision = ?")
      .run(document.id, revision);
    if (result.changes !== 1) {
      throw new HttpError(
        409,
        "这篇材料已在其他页面修改，请重新打开最新版本后再决定是否删除。",
      );
    }
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
      ...(error.code === "WEBSITE_AUTH_REQUIRED" ? { code: error.code } : {}),
      error:
        status >= 500 && !error.expose
          ? "服务暂时遇到问题，请稍后再试。"
          : error.message,
    });
  });

  return {
    app,
    ai,
    close: () => {
      ai.close();
      database.close();
    },
  };
}
