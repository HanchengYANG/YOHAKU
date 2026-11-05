import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createChatGPTAuth } from "./auth.mjs";
import { createWebRuntime } from "./web-runtime.mjs";
import { createCodexPool } from "./pool.mjs";
import { createOpenAIModelTests } from "./model-tests.mjs";
import { validateModelReasoning } from "../reasoning.mjs";
import { normalizeReasoning } from "../../../shared/ai-roles.mjs";

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
  const availabilityListeners=new Set();
  const createPool=()=>{const pool=createCodexPool({
    ...runtimeOptions,
    auth,
    storageDir: join(directory, "runtime"),
  });pool.onAvailable(()=>{for(const listener of availabilityListeners)listener();});return pool;};
  let cli = createPool();
  const web = createWebRuntime({ ...webRuntimeOptions, auth });
  let active = 0, testing = false, lastTransport = "cli", generation = 0;
  const run=async(input = {},lease)=>{
      active++;
      const currentGeneration = generation;
      try {
        if (!input.webSearch) { lastTransport = "cli"; return await (lease || cli).run(input); }
        lastTransport = "responses";
        const { model } = await cli.prepare(input);
        if (generation !== currentGeneration) throw Object.assign(new Error("AI 请求已停止，请重试。"), { status: 409, expose: true });
        return await web.run({ ...input, model });
      } finally { active--; }
  };
  const runtime = {
    run,
    cliAvailable:input=>cli.available(input),
    onCLIAvailable(listener){availabilityListeners.add(listener);return()=>availabilityListeners.delete(listener);},
    reserveCLI(input){const lease=cli.reserve(input);return lease&&{run:input=>run(input,lease),release:()=>lease.release()};},
    stop: () => { generation++; cli.stop(); web.stop(); cli = createPool(); },
    status: () => ({ ...cli.status(), busy: active > 0 || testing, testing, ...(lastTransport === "responses" ? { ...web.status(), busy: active > 0 || testing } : {}), transport: lastTransport, activeCount: active }),
  };
  const credentialStatus = () => auth.credentialStatus();
  const modelTests = createOpenAIModelTests({ directory, credentialStatus, runtime });
  const catalogFile = join(directory, "model-catalog.json");
  let catalog = null, loaded;
  async function knownModels() {
    await (loaded ||= (async () => {
      try { catalog = JSON.parse(await readFile(catalogFile, "utf8")); }
      catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    })());
    const credential = await credentialStatus();
    return catalog?.credentialId === credential.credentialId ? catalog.value : { models: [], source: "subscription" };
  }
  async function models({ signal, refresh = true } = {}) {
    if (active > 0 || testing) throw Object.assign(new Error("AI 正在处理请求，请稍后刷新模型目录。"), { status: 409, expose: true });
    signal?.throwIfAborted();
    const credential = await credentialStatus();
    const value = await cli.models({ refresh, expectedAccountId: credential.activeAccountId, expectedSubject: credential.subject });
    signal?.throwIfAborted();
    if ((await credentialStatus()).credentialId !== credential.credentialId)
      throw Object.assign(new Error("授权已变化，请重新获取模型目录。"), { status: 409, expose: true });
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const next = { credentialId: credential.credentialId, value }, temporary = `${catalogFile}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(next), { mode: 0o600, flag: "wx" });
      await rename(temporary, catalogFile); catalog = next; loaded = Promise.resolve();
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    return value;
  }
  async function validateReasoning(model, input) {
    if (!normalizeReasoning(input)) return undefined;
    const catalog = await knownModels();
    return validateModelReasoning(catalog.models.find((entry) => entry.id === model), input);
  }
  return {
    id: "openai",
    label: "OpenAI",
    auth,
    runtime,
    capabilities,
    credentialStatus,
    models, knownModels, validateReasoning,
    testReports: () => modelTests.reports(),
    async testModel(model, options = {}) {
      if (active > 0 || testing) throw Object.assign(new Error("AI 正在处理请求，请稍后测试。"), { status: 409, expose: true });
      testing = true;
      try { await validateReasoning(model, options.reasoning); return await modelTests.test(model, options); }
      finally { testing = false; }
    },
    async configuration() {
      const catalog = await knownModels();
      const defaultModel = catalog.models.find((entry) => entry.isDefault && entry.inputModalities?.includes("image"))
        || catalog.models.find((entry) => entry.inputModalities?.includes("image"));
      return { models: catalog.models, modelsSource: catalog.source, model: cli.status().model || defaultModel?.id || null,
        modelChecks: await modelTests.reports() };
    },
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
