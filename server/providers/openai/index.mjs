import { join } from "node:path";
import { createChatGPTAuth } from "./auth.mjs";
import { createCodexRuntime } from "./runtime.mjs";

const capabilities = Object.freeze({
  imageInput: true,
  structuredOutput: true,
  conversations: true,
  subscriptionAuth: true,
});

export function createOpenAIConnection({
  storageDir,
  callbackUri,
  authOptions,
  runtimeOptions,
} = {}) {
  if (typeof storageDir !== "string" || !storageDir) {
    const error = new Error("需要指定 AI 提供方的本地存储目录。");
    error.status = 400;
    error.expose = true;
    throw error;
  }
  const directory = join(storageDir, "openai");
  const auth = createChatGPTAuth({
    ...authOptions,
    storageDir: directory,
    callbackUri,
  });
  const runtime = createCodexRuntime({
    ...runtimeOptions,
    auth,
    storageDir: join(directory, "runtime"),
  });
  return {
    id: "openai",
    label: "OpenAI",
    auth,
    runtime,
    capabilities,
    async status() {
      const authentication = await auth.status();
      return {
        providerId: "openai",
        label: "OpenAI",
        connected: authentication.connected,
        capabilities,
        authentication,
        runtime: runtime.status(),
      };
    },
    close: () => runtime.stop(),
  };
}
