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
