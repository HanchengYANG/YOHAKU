import { createOpenAIConnection } from "./openai/index.mjs";

// Registry metadata describes implemented adapters, never account entitlements.
// Disabled entries are placeholders only; they do not construct clients or keys.
export const PROVIDERS = Object.freeze([
  Object.freeze({
    id: "openai",
    name: "OpenAI",
    enabled: true,
    authModes: Object.freeze(["chatgpt_subscription"]),
  }),
  Object.freeze({
    id: "claude",
    name: "Claude",
    enabled: false,
    authModes: Object.freeze([]),
  }),
  Object.freeze({
    id: "api_base",
    name: "API Base",
    enabled: false,
    authModes: Object.freeze([]),
  }),
]);

export function createProviderConnection({
  providerId = "openai",
  storageDir,
  callbackUri,
  openAIOptions,
} = {}) {
  if (providerId !== "openai") {
    const error = new Error(
      "该 AI 提供方尚未实现。目前仅支持 OpenAI 的 ChatGPT 订阅授权。",
    );
    error.status = 501;
    error.expose = true;
    throw error;
  }
  return createOpenAIConnection({
    ...openAIOptions,
    storageDir,
    callbackUri,
  });
}
