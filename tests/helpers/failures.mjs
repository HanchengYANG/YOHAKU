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
