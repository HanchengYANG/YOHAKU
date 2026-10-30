import { join } from "node:path";
import { createChatGPTAuth } from "./auth.mjs";
import { createWebRuntime } from "./web-runtime.mjs";
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
  webRuntimeOptions,
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
  const cli = createCodexRuntime({
    ...runtimeOptions,
    auth,
    storageDir: join(directory, "runtime"),
  });
  const web = createWebRuntime({ ...webRuntimeOptions, auth });
  let busy = false, lastTransport = "cli", generation = 0;
  const runtime = {
    async run(input = {}) {
      if (busy) throw Object.assign(new Error("AI 正在处理另一项请求，请稍后重试。"), { status: 409, expose: true });
      busy = true;
      const currentGeneration = generation;
      try {
        if (!input.webSearch) { lastTransport = "cli"; return await cli.run(input); }
        lastTransport = "responses";
        const { model } = await cli.prepare(input);
        if (generation !== currentGeneration) throw Object.assign(new Error("AI 请求已停止，请重试。"), { status: 409, expose: true });
        return await web.run({ ...input, model });
      } finally { busy = false; }
    },
    stop: () => { generation++; cli.stop(); web.stop(); },
    status: () => ({ ...cli.status(), busy, ...(lastTransport === "responses" ? { ...web.status(), busy } : {}), transport: lastTransport }),
  };
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
