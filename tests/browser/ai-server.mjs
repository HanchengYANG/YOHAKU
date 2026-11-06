// Browser integration harness only. OAuth and model replies below are explicit
// test doubles; the production server never imports this module.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import sharp from "sharp";
import { createApp } from "../../server/app.mjs";
import { createProviderConnection } from "../../server/providers/index.mjs";
import { ANNOTATION_SCHEMA } from "../../shared/ocr-correction.mjs";
import { OCR_BODY_SCHEMA } from "../../shared/ocr.mjs";
import { SENTENCE_SCHEMA } from "../../shared/sentences.mjs";
import { setTimeout as delay } from "node:timers/promises";
import express from "express";
import { normalizeReasoning, reasoningKey } from "../../shared/ai-roles.mjs";

const dataDir = fileURLToPath(
  new URL("../../artifacts/ai-e2e-data/", import.meta.url),
);
await rm(dataDir, { recursive: true, force: true });
const callbackUri = "http://127.0.0.1:4319/auth/callback";
const accountId = "ui-test-account";
let connected = false;
let busy = false;
const turns = new Map();
const runtimeCalls = [];
let runtimeSequence = 0;
let chatStreamControl = null;
const chatStreamWaiters = new Set();
const imageControlsPath = new URL("../../artifacts/ai-e2e-data/image-runtime-controls.json", import.meta.url);

async function imageFault(phase) {
  if (!existsSync(imageControlsPath)) return;
  const controls = JSON.parse(readFileSync(imageControlsPath, "utf8"));
  const key = phase === "recognize" ? "ocrFailures" : "annotationFailures";
  const skipKey = phase === "recognize" ? "ocrSkip" : "annotationSkip";
  const skip = controls[skipKey] > 0;
  const fail = !skip && (controls[key] === "permanent" || controls[key] > 0);
  if (skip) {
    controls[skipKey]--;
    writeFileSync(imageControlsPath, JSON.stringify(controls));
  } else if (Number.isFinite(controls[key]) && controls[key] > 0) {
    controls[key]--;
    writeFileSync(imageControlsPath, JSON.stringify(controls));
  }
  if (controls.delayMs) await new Promise((resolve) => setTimeout(resolve, controls.delayMs));
  if (fail) throw Object.assign(new Error(`浏览器测试故障：${phase === "recognize" ? "识别" : "注音"}暂时失败。`),
    { status: 502, expose: true });
}

async function sentenceFault() {
  if (!existsSync(imageControlsPath)) return;
  const controls = JSON.parse(readFileSync(imageControlsPath, "utf8"));
  const fail = controls.sentenceFailures === "permanent" || controls.sentenceFailures > 0;
  if (Number.isFinite(controls.sentenceFailures) && controls.sentenceFailures > 0) {
    controls.sentenceFailures--;
    writeFileSync(imageControlsPath, JSON.stringify(controls));
  }
  if (controls.sentenceDelayMs) await new Promise((resolve) => setTimeout(resolve, controls.sentenceDelayMs));
  if (fail) throw Object.assign(new Error("浏览器测试故障：整批分句暂时失败。"), { status: 502, expose: true });
}

const auth = {
  async status() {
    return {
      connected,
      requiresLogin: !connected,
      email: connected ? "ui-test-only@example.invalid" : null,
      activeAccountId: connected ? accountId : null,
      subject: connected ? "ui-test-subject" : null,
      lastError: null,
    };
  },
  async accounts() {
    return {
      activeId: connected ? accountId : null,
      accounts: connected
        ? [
            {
              id: accountId,
              subject: "ui-test-subject",
              email: "ui-test-only@example.invalid",
              connected: true,
            },
          ]
        : [],
    };
  },
  async start() {
    const url = new URL("https://auth.openai.com/api/accounts/authorize");
    url.search = new URLSearchParams({
      client_id: "dynamic_agent_client",
      redirect_uri: callbackUri,
      state: "ui-test-state",
      response_type: "code",
    });
    return { url: url.href };
  },
  async callback(params) {
    if (
      params.get("state") !== "ui-test-state" ||
      params.get("code") !== "ui-test-code"
    ) {
      throw new Error("浏览器测试替身的回调参数不匹配。");
    }
    connected = true;
  },
  async disconnect() {
    connected = false;
    return { revoked: true };
  },
  async select(id) {
    if (id !== accountId) throw new Error("不存在这个测试账户。");
    connected = true;
  },
};

// The body reply contains only text; annotation is returned separately.
const ocrText = "僕が生まれた日の空は\n\n背中を撫でる\n用語（原文）\nアキックス：「ここで食べる。」";

function annotationWords(text) {
  const readings = { 僕: "ぼく", 生まれた: "うまれた", 日: "ひ", 空: "そら", 背中: "せなか", 撫でる: "なでる", 食べる: "たべる" };
  const words = [];
  let cursor = 0;
  const unknown = (gap) => {
    for (const match of gap.matchAll(/\p{Script=Han}+/gu)) words.push({ t: match[0], r: null });
  };
  for (const match of text.matchAll(/僕|生まれた|日|空|背中|撫でる|食べる/g)) {
    unknown(text.slice(cursor, match.index));
    words.push({ t: match[0], r: readings[match[0]] });
    cursor = match.index + match[0].length;
  }
  unknown(text.slice(cursor));
  return words;
}

const runtime = {
  status() {
    return { model: "UI-TEST-DOUBLE", busy, ready: connected, lastError: null };
  },
  stop() {
    busy = false;
  },
  async run({ schema, image, prompt, threadId, reasoningEffort, reasoning, webSearch, onEvent, signal }) {
    if (!connected) throw new Error("测试账户尚未连接。");
    busy = true;
    try {
      const id = threadId || `ui-test-thread-${randomUUID()}`;
      const phase = schema === SENTENCE_SCHEMA ? "sentences" : schema === ANNOTATION_SCHEMA ? "annotate" : schema ? "recognize" : "chat";
      runtimeCalls.push({ sequence: ++runtimeSequence, type: schema === SENTENCE_SCHEMA ? "sentences" : schema ? "image" : "chat", phase, prompt, threadId, webSearch, ...(reasoning ? { reasoning } : {}) });
      if (runtimeCalls.length > 100) runtimeCalls.shift();
      writeFileSync(new URL("../../artifacts/ai-e2e-data/runtime-calls.json", import.meta.url), JSON.stringify(runtimeCalls));
      if (phase === "recognize" || phase === "annotate") await imageFault(phase);
      if (schema === SENTENCE_SCHEMA) {
        await sentenceFault();
        const text = JSON.parse(prompt.split("\n输入正文：\n").at(-1));
        return { completed: true, text: JSON.stringify({ sentences: text.match(/[^。！？\n]+(?:[。！？][」』）]*)?|\n/g) || [text] }), model: "UI-TEST-DOUBLE", threadId: id };
      }
      if (schema === ANNOTATION_SCHEMA) {
        if (image) {
          if (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(image))
            throw new Error("注音参考原图无效。");
          const referencePixels = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
          const referenceMetadata = await sharp(referencePixels).metadata();
          if (!referenceMetadata.width || !referenceMetadata.height || (referenceMetadata.orientation !== undefined && referenceMetadata.orientation !== 1))
            throw new Error("注音参考原图未正确解码或按EXIF转正。");
        }
        const targets = JSON.parse(prompt.split("输入目标：\n").at(-1));
        return {
          completed: true,
          text: JSON.stringify({ blocks: targets.map(({ text }) => ({ words: annotationWords(text) })) }),
          model: "UI-TEST-DOUBLE",
          threadId: id,
          reasoningEffort: reasoningEffort ?? null,
        };
      }
      if (schema) {
        if (schema !== OCR_BODY_SCHEMA) throw new Error("正文测试替身仅接受纯文字Schema。");
        // Upload parsing, byte validation, orientation handling, and SQLite are
        // the real production implementations. Only the model output is fixed.
        if (
          typeof image !== "string" ||
          !/^data:image\/(png|jpeg|webp);base64,/.test(image)
        ) {
          throw new Error("真实图片未传到测试模型边界。");
        }
        const pixels = Buffer.from(
          image.slice(image.indexOf(",") + 1),
          "base64",
        );
        const metadata = await sharp(pixels).metadata();
        if (!metadata.width || !metadata.height)
          throw new Error("真实图片无法读取。");
        return {
          completed: true,
          text: JSON.stringify({ text: existsSync(imageControlsPath)
            ? JSON.parse(readFileSync(imageControlsPath, "utf8")).ocrText ?? ocrText : ocrText }),
          model: "UI-TEST-DOUBLE",
          threadId: id,
          reasoningEffort: reasoningEffort ?? null,
        };
      }
      const context = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
      const count = (turns.get(id) || 0) + 1;
      turns.set(id, count);
      const control = chatStreamControl;
      const text = control?.text || `【浏览器测试替身，不是真实 AI 回答】\n测试回合 ${count}。收到问题：${context.question}\n引用：${context.selectedText || context.quote || "无选区"}`;
      if (onEvent && control) {
        await onEvent({type:"status",phase:"searching"});
        const characters=Array.from(text), prefix=characters.slice(0,control.prefixLength || 45).join("");
        await onEvent({type:"delta",delta:prefix});
        if (control.hold) await new Promise((resolve,reject)=>{
          const release=()=>{chatStreamWaiters.delete(release);signal?.removeEventListener("abort",abort);resolve();};
          const abort=()=>{chatStreamWaiters.delete(release);reject(signal.reason);};
          chatStreamWaiters.add(release); signal?.addEventListener("abort",abort,{once:true});
          if(signal?.aborted) abort();
        });
        if (control.fail) throw Object.assign(new Error("测试：流式回答中途中断"),{status:502,expose:true});
        for(let i=Array.from(prefix).length;i<characters.length;i+=5) {
          await delay(8,undefined,{signal});
          await onEvent({type:"delta",delta:characters.slice(i,i+5).join("")});
        }
      }
      return {
        completed: true,
        threadId: id,
        model: "UI-TEST-DOUBLE",
        text,
        sources: webSearch ? [{ title: "日语学习测试来源", url: "https://www.jpf.go.jp/" }] : [],
        webSearch: { enabled: !!webSearch, performed: !!webSearch, queries: webSearch ? ["日语学习"] : [] },
      };
    } finally {
      busy = false;
    }
  },
};

// Role capability records belong to this explicit OpenAI test double only.
const openAIModelChecks = new Map();
const openAIModels = [
  { id: "UI-TEST-DOUBLE", name: "OpenAI 浏览器测试替身", reasoningOptions: { efforts: ["low", "medium", "high"] } },
  { id: "UI-REASONING-DOUBLE", name: "推理参数浏览器测试替身", reasoningOptions: {
    efforts: ["low", "medium", "high"], toggle: true, budget: { min: 1024, max: 8192 },
  } },
];
function validateFixtureReasoning(model, input) {
  const reasoning = normalizeReasoning(input) || {}, options = openAIModels.find((item) => item.id === model)?.reasoningOptions;
  if (!options || reasoning.effort && !options.efforts.includes(reasoning.effort) ||
      reasoning.enabled !== undefined && !options.toggle ||
      reasoning.budgetTokens !== undefined && (!options.budget || reasoning.budgetTokens < options.budget.min || reasoning.budgetTokens > options.budget.max))
    throw Object.assign(new Error("测试模型不支持此推理配置。"), { status: 400, expose: true });
  return reasoning;
}
const openAIService = {
  auth, runtime,
  credentialStatus: () => auth.status(),
  knownModels: () => openAIModels,
  models: async () => ({ models: openAIModels, source: "subscription" }),
  testReports: async () => connected ? [...openAIModelChecks.values()] : [],
  validateReasoning: validateFixtureReasoning,
  testModel: async (model, { role, referenceImage, reasoning: inputReasoning } = {}) => {
    if (!connected || !openAIModels.some((item) => item.id === model))
      throw Object.assign(new Error("测试账户或模型不可用。"), { status: 409, expose: true });
    const reasoning = validateFixtureReasoning(model, inputReasoning), key = JSON.stringify([model, reasoningKey(reasoning)]);
    const checkedAt = new Date().toISOString();
    const capabilities = role === "chat" ? ["streaming"]
      : role === "ocr" || (role === "annotation" && referenceImage) ? ["json", "image"] : ["json"];
    const checks = { ...openAIModelChecks.get(key)?.checks };
    for (const capability of capabilities) checks[capability] = {
      state: "supported", message: "浏览器能力测试替身通过。", elapsedMs: 1, checkedAt,
    };
    const report = { model, role, ...(Object.keys(reasoning).length ? { reasoning } : {}), checkedAt, passed: true, checks };
    openAIModelChecks.set(key, report);
    return report;
  },
};

const { app, close } = createApp({
  dataDir,
  callbackUri,
  aiServices: (ownerId, providerId) => providerId === "openai" ? openAIService
    : createProviderConnection({ providerId, storageDir: join(dataDir, "users", ownerId, "providers"),
      apiBaseOptions: { fetchImpl: (url, init) =>
        fetch(`http://127.0.0.1:4319/__test/api-base${new URL(url).pathname}`, init) },
    }),
  imageTaskOptions: { runnerOptions: { pollIntervalMs: 20, retryDelayMs: 20, blockedRetryMs: 100 } },
  // Every test case logs in from 127.0.0.1; the production limit (30 per 15 min) would 429 the suite.
  accountRateLimit: false,
});
const harness=express();
harness.get("/__test/api-base/v1/models", (_req, res) => res.json({ data: [
  { id: "codiX-agent" }, { id: "Qwen/Qwen3.6-35B", reasoningOptions: { efforts: ["none", "low", "medium", "high"] } }, { id: "Zai/GLM-5.2" },
  { id: "Qwen/Qwen3-Embedding-8B" }, { id: "codiX-embedding" }, { id: "codiX-autocomplete" },
] }));
harness.post("/__test/api-base/v1/chat/completions", express.json({ limit: "1mb" }), (req, res) => {
  const body = req.body;
  const image = Array.isArray(body.messages?.at(-1)?.content);
  if (image && ["codiX-agent", "Zai/GLM-5.2"].includes(body.model))
    return res.status(400).json({ error: { message: "Test fixture: not a multimodal model" } });
  if (body.stream) {
    res.set("Content-Type", "text/event-stream");
    res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`);
    return;
  }
  res.json({ model: body.model, choices: [{ message: { role: "assistant", content: image ? "42" : '{"ok":true}' }, finish_reason: "stop" }] });
});
harness.post("/__test/chat-stream",express.json(),(req,res)=>{
  for (const release of [...chatStreamWaiters]) release();
  if (req.body.action !== "release") chatStreamControl=req.body.action === "reset" ? null : {...req.body};
  res.json({ok:true});
});
harness.use(app);
const server = harness.listen(4319, "127.0.0.1", () => {
  console.log(
    "余白 UI 集成测试服务：http://127.0.0.1:4319（OAuth / AI 为明确测试替身）",
  );
});
server.on("error", (error) => {
  console.error(error.message);
  close();
  process.exitCode = 1;
});
let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  server.close(() => {
    close();
    process.exitCode = 0;
  });
  server.closeIdleConnections();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
