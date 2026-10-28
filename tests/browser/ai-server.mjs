// Browser integration harness only. OAuth and model replies below are explicit
// test doubles; the production server never imports this module.
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createApp } from "../../server/app.mjs";
import { ANNOTATION_SCHEMA } from "../../shared/ocr-correction.mjs";
import { OCR_BODY_SCHEMA } from "../../shared/ocr.mjs";

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
  async run({ schema, image, prompt, threadId, reasoningEffort }) {
    if (!connected) throw new Error("测试账户尚未连接。");
    busy = true;
    try {
      const id = threadId || `ui-test-thread-${randomUUID()}`;
      if (schema === ANNOTATION_SCHEMA) {
        if (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,/.test(image))
          throw new Error("独立注音未收到参考原图。");
        const referencePixels = Buffer.from(image.slice(image.indexOf(",") + 1), "base64");
        const referenceMetadata = await sharp(referencePixels).metadata();
        if (!referenceMetadata.width || !referenceMetadata.height || referenceMetadata.orientation !== undefined)
          throw new Error("注音参考原图未正确解码或按EXIF转正。");
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
          text: JSON.stringify({ text: ocrText }),
          model: "UI-TEST-DOUBLE",
          threadId: id,
          reasoningEffort: reasoningEffort ?? null,
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
