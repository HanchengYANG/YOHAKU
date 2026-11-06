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
