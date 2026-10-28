// Browser integration harness only. OAuth and model replies below are explicit
// test doubles; the production server never imports this module.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createApp } from "../../server/app.mjs";

const dataDir = fileURLToPath(
  new URL("../../artifacts/ai-e2e-data/", import.meta.url),
);
await rm(dataDir, { recursive: true, force: true });
const callbackUri = "http://127.0.0.1:4319/auth/callback";
const accountId = "ui-test-account";
let connected = false;
let busy = false;
const turns = new Map();

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

const ocrDouble = {
  title: "界面测试草稿（OCR 为测试替身）",
  kind: "article",
  orientation: "vertical",
  readingOrder: "测试替身：来源竖排，原文整理为段落与学习条目，不代表真实 OCR 结论。",
  blocks: [
    {
      type: "paragraph",
      confidence: "high",
      sourcePage: "single",
      segments: [
        { text: "僕", reading: "ぼく", origin: "source" },
        { text: "が", reading: null, origin: null },
        { text: "生まれた", reading: "うまれた", origin: "generated" },
        { text: "日", reading: "ひ", origin: "source" },
        { text: "の", reading: null, origin: null },
        { text: "空", reading: "そら", origin: "generated" },
        { text: "は", reading: null, origin: null },
      ],
    },
    { type: "paragraph", confidence: "high", sourcePage: "single", segments: [] },
    {
      type: "paragraph",
      confidence: "uncertain",
      sourcePage: "single",
      segments: [
        { text: "背中", reading: "せなか", origin: "source" },
        { text: "を", reading: null, origin: null },
        { text: "撫でる", reading: "なでる", origin: "generated" },
      ],
    },
    {
      type: "heading",
      confidence: "high",
      sourcePage: "single",
      segments: [{ text: "用語（原文）", reading: null, origin: null }],
    },
    {
      type: "list_item",
      confidence: "high",
      sourcePage: "single",
      segments: [
        // Deliberately redundant model output: the real new-draft normalizer
        // must remove kana-only readings before the UI or database sees them.
        { text: "アキックス", reading: "あきっくす", origin: "generated" },
        { text: "：「ここで", reading: null, origin: null },
        { text: "食べる", reading: "たべる", origin: "generated" },
        { text: "。」", reading: null, origin: null },
      ],
    },
  ],
  warnings: [
    { blockIndex: 2, message: "测试替身：请对照原图核对这一行。" },
    {
      blockIndex: null,
      message: "此识别结果来自浏览器测试替身，不是真实 OCR。",
    },
  ],
  nonBody: [
    { type: "handwriting", text: "测试替身：绿色手写批注", page: "single" },
    { type: "page_number", text: "62", page: "single" },
  ],
};

const runtime = {
  status() {
    return { model: "UI-TEST-DOUBLE", busy, ready: connected, lastError: null };
  },
  stop() {
    busy = false;
  },
  async run({ schema, image, prompt, threadId }) {
    if (!connected) throw new Error("测试账户尚未连接。");
    busy = true;
    try {
      const id = threadId || `ui-test-thread-${randomUUID()}`;
      if (schema) {
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
          text: JSON.stringify(ocrDouble),
          model: "UI-TEST-DOUBLE",
          threadId: id,
        };
      }
      const context = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
      const count = (turns.get(id) || 0) + 1;
      turns.set(id, count);
      return {
        completed: true,
        threadId: id,
        model: "UI-TEST-DOUBLE",
        text: `【浏览器测试替身，不是真实 AI 回答】\n测试回合 ${count}。收到问题：${context.question}\n引用：${context.quote || "全文"}`,
      };
    } finally {
      busy = false;
    }
  },
};

const { app, close } = createApp({
  dataDir,
  callbackUri,
  aiServices: { auth, runtime },
});
const server = app.listen(4319, "127.0.0.1", () => {
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
