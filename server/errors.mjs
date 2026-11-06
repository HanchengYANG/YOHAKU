import { randomBytes } from "node:crypto";
import { AI_SETTINGS_ACTION, ERROR_CODE_ALPHABET, GENERIC_FAILURE, failureText, isErrorCode, parseFailure } from "../shared/error-codes.mjs";
import { sanitizeDiagnostic } from "./ai/diagnostics.mjs";

export function newErrorCode(bytes = randomBytes(6)) {
  // 256 is a multiple of 32, so every character is equally likely.
  return Array.from(bytes.subarray(0, 6), (byte) => ERROR_CODE_ALPHABET[byte % 32]).join("");
}

// SDK errors can carry credentials; hide the common shapes before storing.
export function redact(text) {
  return String(text ?? "")
    .replace(/(\b(?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]*/gi, "$1[已隐藏]")
    .replace(/(authorization["']?\s*[:=]\s*["']?)(?:(?:bearer|basic|token)\s+)?[^\s,;"']+/gi, "$1[已隐藏]")
    .replace(/\bbearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer [已隐藏]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[已隐藏]")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}/g, "[已隐藏]")
    .replace(/((?:api[_-]?key|token|secret|password)["']?\s*[:=]\s*["']?)[^\s,;"'}]+/gi, "$1[已隐藏]");
}

const SECRET_KEY = /api[_-]?key|token|secret|password|authorization|cookie/i;

// Redact field by field so the stored context stays valid JSON. Numbers are
// kept: counters such as inputTokens cannot hold credentials.
const redactJson = (value) => JSON.stringify(value, (key, item) =>
  key && SECRET_KEY.test(key) && (typeof item === "string" || (item && typeof item === "object")) ? "[已隐藏]"
    : typeof item === "string" ? redact(item) : item);

const parseContext = (text) => {
  try { const value = JSON.parse(text); return value && typeof value === "object" ? value : {}; }
  catch { return {}; }
};

// Cancelling an AI request is the user's own choice, so it is not recorded.
const userFixableAICodes = new Set(["AI_BUSY", "AI_CANCELLED"]);

export function classifyError(error) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const code = typeof error?.code === "string" ? error.code : null;
  const kind = code || (typeof error?.diagnostic?.code === "string" ? error.diagnostic.code : null);
  // Provider errors raised inside a role carry execution details but may lack a diagnostic.
  const fromAI = Boolean(error?.diagnostic) || Boolean(error?.execution?.providerId) || Boolean(code?.startsWith("AI_"));
  if (code === "AI_AUTH_REQUIRED" || (fromAI && [401, 403].includes(status)))
    return { record: true, kind: "AI_AUTH_REQUIRED", action: AI_SETTINGS_ACTION };
  if (status < 500 && (!fromAI || userFixableAICodes.has(kind)))
    return { record: false, kind, action: null };
  return { record: true, kind, action: null };
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function createErrorLog(database, {
  now = () => Date.now(), generateCode = newErrorCode, retentionMs = 90 * DAY_MS, log = console.error,
} = {}) {
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
  const insert = database.prepare(`INSERT INTO error_log
    (code,created_at,user_id,scope,location,kind,status,message,stack,context_json) VALUES(?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(code) DO NOTHING`);
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
      if (insert.run(code, createdAt, userId, scope, location, kind, status, message, stack, redactJson(details)).changes) return code;
    }
    throw new Error("无法生成唯一的错误代码。");
  }

  // Background failures: record once per error object and return the text
  // that is stored in the existing error fields. Never throws: callers are
  // already handling a failure, so a broken log falls back to the plain text.
  function capture(error, meta) {
    const target = error && typeof error === "object" ? error : new Error(String(error));
    if (!isErrorCode(target.errorCode)) {
      try {
        const { action } = classifyError(target);
        target.errorCode = record(target, meta);
        target.errorAction = action;
      } catch (cause) {
        try { log("错误记录写入失败：", redact(target.message || target), redact(cause?.message)); } catch {}
        return GENERIC_FAILURE;
      }
    }
    return failureText(target.errorCode, target.errorAction);
  }

  const present = (row) => row ? {
    code: row.code, createdAt: row.created_at, userId: row.user_id, username: row.username ?? null,
    scope: row.scope, location: row.location, kind: row.kind, status: row.status,
    message: row.message, stack: row.stack, context: parseContext(row.context_json),
  } : null;

  function get(code) {
    return present(database.prepare(select(" WHERE e.code=?")).get(normalize(code)));
  }

  function list({ query = "", before = null, limit = 50 } = {}) {
    const size = Math.min(Math.max(Number.parseInt(limit, 10) || 50, 1), 200);
    const where = [], params = [];
    // Admins may paste the whole failure sentence instead of the bare code.
    const code = parseFailure(String(query ?? "").trim())?.code ?? normalize(query);
    if (code) { where.push("e.code=?"); params.push(code); }
    // The cursor is "createdAt|code", because several rows can share a timestamp.
    if (before) {
      const [at, last = ""] = String(before).split("|", 2);
      where.push("(e.created_at<? OR (e.created_at=? AND e.code<?))"); params.push(at, at, normalize(last));
    }
    const rows = database.prepare(`${select(where.length ? ` WHERE ${where.join(" AND ")}` : "")} ORDER BY e.created_at DESC, e.code DESC LIMIT ?`)
      .all(...params, size + 1);
    return {
      items: rows.slice(0, size).map((row) => ({
        code: row.code, createdAt: row.created_at, username: row.username ?? null,
        scope: row.scope, location: row.location, kind: row.kind,
        summary: row.message.split("\n", 1)[0].slice(0, 120),
      })),
      nextBefore: rows.length > size ? `${rows[size - 1].created_at}|${rows[size - 1].code}` : null,
    };
  }

  function prune() {
    return Number(database.prepare("DELETE FROM error_log WHERE created_at<?").run(new Date(now() - retentionMs).toISOString()).changes);
  }

  return { record, capture, get, list, prune };
}

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
    catch (cause) { log("错误记录写入失败：", redact(error?.message || error), redact(cause?.message)); }
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
