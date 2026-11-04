import { createOpenAIConnection } from "./openai/index.mjs";
import { createAPIBaseConnection } from "./api-base/index.mjs";

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
    name: "iliad codix",
    enabled: true,
    authModes: Object.freeze(["api_key"]),
  }),
]);

export function createProviderConnection({
  providerId = "openai",
  storageDir,
  callbackUri,
  openAIOptions,
  apiBaseOptions,
} = {}) {
  if (providerId === "api_base") return createAPIBaseConnection({ ...apiBaseOptions, storageDir });
  if (providerId !== "openai") {
    const error = new Error(
      "该 AI 提供方尚未实现。请选择 OpenAI 或 iliad codix。",
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
