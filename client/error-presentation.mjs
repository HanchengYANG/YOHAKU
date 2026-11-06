import { AI_SETTINGS_ACTION, AI_UNAVAILABLE, GENERIC_FAILURE, parseFailure, splitCodedText } from "../shared/error-codes.mjs";

export function errorNoticeModel(error, { isAdmin = false } = {}) {
  if (!error) return null;
  const text = typeof error === "string" ? error : String(error.message || "");
  const parsed = parseFailure(text);
  // Admins may receive the original guidance in front of the code.
  const guidance = parsed ? null : splitCodedText(text);
  const code = (typeof error === "object" && error.errorCode) || parsed?.code || guidance?.code || null;
  const action = (typeof error === "object" && error.action) || parsed?.action || null;
  if (code && action === AI_SETTINGS_ACTION && isAdmin)
    return { message: "AI 连接已失效", code, action: AI_SETTINGS_ACTION, actionLabel: "去 AI 设置" };
  if (guidance) return { message: guidance.message, code, action: null, actionLabel: null };
  if (code) return { message: action === AI_SETTINGS_ACTION ? AI_UNAVAILABLE : GENERIC_FAILURE, code, action: null, actionLabel: null };
  return { message: text || GENERIC_FAILURE, code: null, action: null, actionLabel: null };
}
