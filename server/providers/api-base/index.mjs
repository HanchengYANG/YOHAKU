import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText, streamText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createModelTests } from "./model-tests.mjs";

export const CODIX_MODELS = Object.freeze([
  { id: "codiX-agent", name: "codiX Agent", limit: { context: 262144, output: 32768 } },
  { id: "codiX-chat", name: "codiX Chat", limit: { context: 250000, output: 16384 } },
  { id: "Deepseek/deepseek-v4-flash-0731", name: "Deepseek V4 Flash", limit: { context: 262144, output: 32768 } },
  { id: "Qwen/Qwen3.5-397B-A17B", name: "Qwen3.5 397B A17B", limit: { context: 262144, output: 16384 } },
  { id: "Gemma4-26B", name: "Gemma4-26B", limit: { context: 262144, output: 32768 } },
  { id: "Qwen/Qwen3.6-35B", name: "Qwen3.6 35B", limit: { context: 250000, output: 32768 } },
  { id: "Qwen/Qwen3-235B-A22B-Instruct-2507", name: "Qwen3 235B A22B Instruct 2507", limit: { context: 250000, output: 16384 } },
]);
export const API_BASE_DEFAULTS = Object.freeze({
  baseURL: "https://iliad.codix.scw.eu/v1",
  model: "codiX-agent",
});
const capabilities = Object.freeze({
  imageInput: true, structuredOutput: true, conversations: true,
  subscriptionAuth: false, webSearch: false,
});
const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });

function validateConfiguration(input, previous, requireKey = true) {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw fail(400, "请提供 iliad codix 的 API key。");
  const baseURL = API_BASE_DEFAULTS.baseURL;
  if (input.baseURL !== undefined &&
      (typeof input.baseURL !== "string" || input.baseURL.trim().replace(/\/+$/, "") !== baseURL))
    throw fail(400, "iliad codix 的服务地址固定，不能修改。");
  const model = typeof input.model === "string" ? input.model.trim() : "";
  if (!model || model.length > 300 || /\s/.test(model)) throw fail(400, "请填写有效的模型 ID。");
  if (input.apiKey !== undefined && typeof input.apiKey !== "string") throw fail(400, "API key 格式无效。");
  const suppliedKey = input.apiKey?.trim();
  const apiKey = suppliedKey || previous.apiKey;
  if ((requireKey && !apiKey) || apiKey === "YOUR_API_KEY" || apiKey.length > 8192 || /\s/.test(apiKey))
    throw fail(400, "请填写 iliad codix 的有效 API key。");
  return { baseURL, model, apiKey,
    modelSelected: input.modelSelected === true,
    id: baseURL === previous.baseURL && apiKey === previous.apiKey ? previous.id : randomUUID() };
}

// Never expose SDK errors verbatim: they can contain request headers or bodies.
function publicError(cause, signal, image) {
  if (signal?.aborted) return fail(409, "API 请求已取消或超时，请重试。");
  if (cause?.expose) return cause;
  const status = cause?.statusCode;
  if (status === 401 || status === 403) return fail(status, "API key 无效、已失效或无权使用所选模型，请在 AI 设置中检查。");
  if (status === 429) return fail(429, "API 请求达到服务的用量或频率限制，请稍后重试或检查配额。");
  if (status === 404) return fail(502, "iliad codix 未找到此模型，请刷新模型列表并检查模型 ID。");
  if (status === 400 || status === 422) return fail(502, image
    ? "API 拒绝了图片请求，请确认所选模型支持图片输入和 JSON 输出。"
    : "API 拒绝了请求，请确认模型 ID 及其 JSON 输出支持。");
  return fail(502, "API 调用失败或返回格式无效，请检查服务状态、模型能力和网络后重试。");
}

export function createAPIBaseConnection({ storageDir, fetchImpl = globalThis.fetch, timeoutMs = 180000 } = {}) {
  if (typeof storageDir !== "string" || !storageDir) throw fail(400, "需要指定 AI 提供方的本地存储目录。");
  const directory = join(storageDir, "api_base"), filename = join(directory, "connection.json");
  let configuration = { ...API_BASE_DEFAULTS, apiKey: "", id: randomUUID() };
  let initialized, busy = false, controller = null, lastError = null, catalog = null, testing = false, activeModel = null;
  const modelTests = createModelTests({ directory, fetchImpl, timeoutMs: Math.min(timeoutMs, 60000) });
  const load = () => initialized ||= (async () => {
    try {
      const saved = JSON.parse(await readFile(filename, "utf8"));
      configuration = validateConfiguration(saved, configuration, false);
      // Keep a persisted identity so a restart does not switch conversation owners.
      if (typeof saved.id === "string" && saved.id) configuration.id = saved.id;
    }
    catch (error) {
      if (error.code !== "ENOENT") throw fail(503, "无法读取已保存的 API 配置，请检查服务端配置文件。");
    }
  })();
  async function save(next) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      if (next.baseURL !== configuration.baseURL || next.apiKey !== configuration.apiKey) catalog = null;
      configuration = next;
      lastError = null;
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
  }
  const settings = async () => {
    await load();
    const modelChecks = await modelTests.reports(configuration);
    activeModel = configuration.modelSelected && modelChecks.some((report) => report.model === configuration.model && report.passed)
      ? configuration.model : null;
    return { baseURL: configuration.baseURL, model: configuration.model,
      hasKey: !!configuration.apiKey, models: catalog?.models || CODIX_MODELS,
      modelsSource: catalog ? "server" : "preset", activeModel, modelChecks };
  };
  async function models({ signal } = {}) {
    await load();
    if (!configuration.apiKey) throw fail(503, "请先保存 API key，再获取服务端模型列表。");
    const selected = configuration;
    const abortSignal = AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]);
    try {
      const response = await fetchImpl(`${selected.baseURL}/models`, {
        headers: { Authorization: `Bearer ${selected.apiKey}` }, signal: abortSignal, redirect: "error",
      });
      if (response.status === 404 || response.status === 405)
        throw fail(502, "此服务没有提供模型列表接口，可以继续手动填写模型 ID。");
      if (!response.ok) throw Object.assign(new Error("模型列表请求失败。"), { statusCode: response.status });
      const payload = await response.json();
      const entries = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : null;
      if (!entries || entries.length > 5000) throw fail(502, "服务端返回的模型列表格式无效，可以继续手动填写模型 ID。");
      const unique = new Map();
      for (const entry of entries) {
        const id = typeof entry === "string" ? entry : entry?.id;
        if (typeof id !== "string" || !id || id.length > 300 || /\s/.test(id) || id.includes(selected.apiKey)) continue;
        const preset = CODIX_MODELS.find((model) => model.id === id);
        const name = typeof entry?.name === "string" ? entry.name.slice(0, 300).replaceAll(selected.apiKey, "[hidden]") : preset?.name || id;
        unique.set(id, { id, name, ...(preset ? { limit: preset.limit } : {}) });
      }
      const available = [...unique.values()].filter((model) => !/(?:^|[-/_])(?:embeddings?|autocomplete)(?:[-/_]|$)/i.test(model.id));
      if (configuration !== selected) throw fail(409, "API 配置已变化，请重新获取模型列表。");
      catalog = { models: available, total: unique.size, excluded: unique.size - available.length, source: "server" };
      return catalog;
    } catch (cause) { throw publicError(cause, abortSignal); }
  }
  const auth = {
    async status() {
      await load();
      await settings();
      const connected = !!configuration.apiKey && !!activeModel;
      return { connected, requiresLogin: !connected, authMode: "api_key",
        activeAccountId: connected ? configuration.id : null,
        subject: connected ? `api_base:${configuration.id}` : null };
    },
    async accounts() {
      const account = await auth.status();
      return { accounts: [], activeId: account.activeAccountId };
    },
    async start() { throw fail(405, "此提供方使用 API key，请在 AI 设置中保存配置。"); },
    async select() { throw fail(405, "此提供方使用 API key，无需选择 ChatGPT 账户。"); },
    async disconnect() {
      await load();
      runtime.stop();
      await save({ ...configuration, apiKey: "", modelSelected: false, id: randomUUID() });
      activeModel = null;
      return { removed: true };
    },
  };
  const runtime = {
    status: () => ({ busy: busy || testing, running: busy || testing, ready: !!configuration.apiKey && !!activeModel,
      model: activeModel, transport: "ai-sdk", lastError }),
    stop: () => controller?.abort(),
    async run({ prompt, image, schema, webSearch = false, expectedAccountId, expectedSubject, signal, onEvent } = {}) {
      if (busy || testing) throw fail(409, "AI 正在处理另一项请求，请稍后重试。");
      busy = true;
      controller = new AbortController();
      const abortSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]);
      try {
        const account = await auth.status();
        abortSignal.throwIfAborted();
        if (!account.connected) throw fail(503, configuration.apiKey
          ? "请先由网站拥有者测试并启用一个模型，再使用网站 AI。"
          : "请先由网站拥有者在 AI 设置中保存 API key。");
        if ((expectedAccountId && expectedAccountId !== account.activeAccountId) ||
            (expectedSubject && expectedSubject !== account.subject)) throw fail(409, "API 配置已变化，请重试。");
        if (typeof prompt !== "string" || !prompt.trim()) throw fail(400, "请提供有效的问题或识别指令。");
        if (image && !/^data:image\/(png|jpeg|webp);base64,/.test(image)) throw fail(400, "请提供有效的图片数据。");
        const provider = createOpenAICompatible({ name: "api_base", baseURL: configuration.baseURL,
          apiKey: configuration.apiKey, fetch: fetchImpl });
        const instructions = ["你是余白的日语阅读助手，按用户要求处理提供的学习资料。",
          ...(schema ? [`只返回符合以下 JSON Schema 的 JSON 对象，不要添加 Markdown：\n${JSON.stringify(schema)}`] : []),
          ...(webSearch ? ["当前连接没有网页搜索工具。请明确说明未联网，不得声称已检索或核实外部来源。"] : [])].join("\n");
        const options = { model: provider(configuration.model), system: instructions,
          messages: [{ role: "user", content: image
            ? [{ type: "text", text: prompt }, { type: "file", data: image, mediaType: image.slice(5, image.indexOf(";")) }]
            : prompt }],
          maxOutputTokens: CODIX_MODELS.find((model) => model.id === configuration.model)?.limit.output || 16384,
          maxRetries: 0, abortSignal, ...(schema ? { output: Output.json() } : {}) };
        let result, text;
        if (onEvent && !schema) {
          // Consume the SDK's full stream so errors cannot become saved answers.
          result = streamText({ ...options, onError: () => {} });
          text = "";
          for await (const event of result.fullStream) {
            if (event.type === "error") throw event.error;
            if (event.type === "text-delta") {
              text += event.text;
              await onEvent({ type: "delta", delta: event.text });
            }
          }
        } else {
          result = await generateText(options);
          text = schema ? JSON.stringify(result.output) : result.text;
        }
        abortSignal.throwIfAborted();
        if (await result.finishReason !== "stop" || !text?.trim())
          throw fail(502, "AI 输出为空、被截断或未完整完成，未保存部分结果，请重试。");
        const response = await result.response;
        lastError = null;
        return { text, completed: true, threadId: null, model: response.modelId || configuration.model,
          reasoningEffort: null, sources: [], webSearch: { enabled: false, performed: false } };
      } catch (cause) {
        const error = publicError(cause, abortSignal, image);
        lastError = error.message;
        throw error;
      } finally { busy = false; controller = null; }
    },
  };
  return { id: "api_base", label: "iliad codix", auth, runtime, capabilities, configuration: settings, models,
    async configure(input) {
      if (busy || testing) throw fail(409, "AI 正在处理请求，请完成后再修改 API 配置。");
      await load();
      const next = validateConfiguration({ ...input, model: configuration.model,
        modelSelected: configuration.modelSelected }, configuration);
      if (next.id !== configuration.id) next.modelSelected = false;
      await save(next);
      return settings();
    },
    async testModel(model, { signal } = {}) {
      if (busy || testing) throw fail(409, "AI 正在处理请求，请完成后再测试模型。");
      if (typeof model !== "string" || !model || model.length > 300 || /\s/.test(model)) throw fail(400, "请填写有效的待测试模型 ID。");
      await load();
      if (!configuration.apiKey) throw fail(503, "请先保存 API key，再测试模型。");
      testing = true;
      controller = new AbortController();
      try {
        const report = await modelTests.test(configuration, model, {
          signal: AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]),
        });
        if (!report.passed && configuration.model === model && configuration.modelSelected)
          await save({ ...configuration, modelSelected: false });
        await settings();
        return report;
      } finally { testing = false; controller = null; }
    },
    async selectModel(model) {
      if (busy || testing) throw fail(409, "AI 正在处理请求，请完成后再切换模型。");
      await load();
      const reports = await modelTests.reports(configuration);
      if (!reports.some((report) => report.model === model && report.passed))
        throw fail(409, "此模型尚未通过当前 API 配置的测试，请先测试模型。");
      await save({ ...configuration, model, modelSelected: true });
      return settings();
    },
    async status() {
      const authentication = await auth.status();
      return { providerId: "api_base", label: "iliad codix", connected: authentication.connected,
        authentication, capabilities, configuration: await settings(), runtime: runtime.status() };
    },
    close: () => runtime.stop(),
  };
}
