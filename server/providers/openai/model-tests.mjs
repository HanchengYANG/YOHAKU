import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { digitTestImage } from "../test-image.mjs";
import { requiredCapabilities, roleReport, normalizeReasoning, reasoningKey } from "../../../shared/ai-roles.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const schema = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

export function createOpenAIModelTests({ directory, credentialStatus, runtime }) {
  const filename = join(directory, "model-checks.json");
  let loaded, records = [];
  const load = () => loaded ||= (async () => {
    try {
      const saved = JSON.parse(await readFile(filename, "utf8"));
      if (Array.isArray(saved.checks)) records = saved.checks;
    } catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw fail(503, "无法读取模型测试记录。"); }
  })();
  async function reports() {
    await load();
    const credential = await credentialStatus();
    return records.filter((record) => record.credentialId === credential.credentialId)
      .map(({ credentialId, ...report }) => report);
  }
  async function test(model, { role, referenceImage = false, signal, reasoning } = {}) {
    await load();
    if (typeof model !== "string" || !model || model.length > 300 || /\s/.test(model)) throw fail(400, "请选择有效的待测试模型。");
    const credential = await credentialStatus();
    if (!credential.connected) throw fail(503, "请先连接 ChatGPT 授权，再测试角色。");
    const selectedReasoning = normalizeReasoning(reasoning), key = reasoningKey(selectedReasoning);
    const previous = records.find((item) => item.credentialId === credential.credentialId && item.model === model && reasoningKey(item.reasoning) === key);
    const checks = { ...previous?.checks }, checkedAt = new Date().toISOString();
    const required = role ? requiredCapabilities(role, referenceImage) : ["json", "image", "streaming"];
    for (const capability of required) {
      signal?.throwIfAborted();
      const started = performance.now();
      try {
        const input = { model, signal, ...(selectedReasoning ? { reasoning: selectedReasoning } : {}), expectedAccountId: credential.activeAccountId,
          expectedSubject: credential.subject };
        if (capability === "streaming") {
          let streamed = "";
          const result = await runtime.run({ ...input, webSearch: true,
            prompt: '选区：日本語。句子：日本語を勉強しています。历史：[]。请简短解释选区。',
            onEvent: async (event) => { if (event.type === "delta") streamed += event.delta; else if (event.type === "text") streamed = event.text; } });
          if (!result.completed || !result.text?.trim() || !streamed.trim()) throw new Error("流式输出未完成。");
        } else if (capability === "json") {
          const result = await runtime.run({ ...input, schema,
            prompt: '正文：日本語を勉強しています。语境：日语学习。只返回 JSON 对象 {"ok":true}。' });
          if (!result.completed || JSON.parse(result.text)?.ok !== true) throw new Error("JSON 输出无效。");
        } else {
          const pixels = await digitTestImage();
          const result = await runtime.run({ ...input, image: `data:image/png;base64,${pixels.toString("base64")}`,
            prompt: "读取图片中的数字，只回复数字，不要解释。" });
          if (!result.completed || result.text?.replace(/\s/g, "") !== "42") throw new Error("图片输出无效。");
        }
        checks[capability] = { state: "supported", message: "测试通过。", checkedAt };
      } catch (error) {
        if (signal?.aborted) throw fail(409, "模型测试已取消。");
        checks[capability] = { state: "failed", message: "测试未通过，请检查授权、模型能力或服务状态后重试。", checkedAt };
      }
      checks[capability].elapsedMs = Math.round(performance.now() - started);
    }
    signal?.throwIfAborted();
    if ((await credentialStatus()).credentialId !== credential.credentialId) throw fail(409, "授权已变化，请重新测试。");
    const report = { credentialId: credential.credentialId, model, ...(selectedReasoning ? { reasoning: selectedReasoning } : {}), checkedAt, checks,
      passed: ["json", "image", "streaming"].every((name) => checks[name]?.state === "supported") };
    const next = [...records.filter((item) => item.credentialId !== credential.credentialId || item.model !== model || reasoningKey(item.reasoning) !== key), report].slice(-200);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify({ checks: next }, null, 2), { mode: 0o600, flag: "wx" });
      await rename(temporary, filename); records = next;
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    const { credentialId, ...publicReport } = report;
    return role ? roleReport([publicReport], model, role, referenceImage, selectedReasoning) : publicReport;
  }
  return { reports, test };
}
