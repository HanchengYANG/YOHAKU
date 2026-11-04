import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { generateText, streamText, Output } from "ai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
const scopeFor = ({ baseURL, apiKey }) => createHash("sha256").update(JSON.stringify([baseURL, apiKey])).digest("hex");
const publicReport = ({ scope, ...report }) => report;

function checkFailure(error, capability, timedOut) {
  if (timedOut) return { state: "failed", message: "请求超时，暂时无法确认能力。" };
  if ([401, 403].includes(error.statusCode)) return { state: "failed", message: "密钥无效或没有使用此模型的权限。" };
  if (error.statusCode === 429) return { state: "failed", message: "服务限流或配额不足，请稍后重试。" };
  const patterns = {
    image: /not (?:a )?(?:multi.?modal|vision)|does not support (?:image|vision)|image.*(?:not supported|unsupported)|(?:unsupported|not supported).*image/i,
    json: /(?:response_format|json).*(?:not supported|unsupported)|does not support.*(?:response_format|json)/i,
    streaming: /stream.*(?:not supported|unsupported)|does not support.*stream/i,
  };
  if ([400, 422].includes(error.statusCode) && patterns[capability].test(error.message || ""))
    return { state: "unsupported", message: "服务端明确表示不支持此能力。" };
  return { state: "failed", message: "请求失败、输出不完整或未符合测试要求，请重新测试。" };
}

export function createModelTests({ directory, fetchImpl, timeoutMs = 60000 }) {
  const filename = join(directory, "model-checks.json");
  let initialized, records = [];
  const load = () => initialized ||= (async () => {
    try {
      const value = JSON.parse(await readFile(filename, "utf8"));
      if (Array.isArray(value.checks)) records = value.checks;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw fail(503, "无法读取模型测试记录，请检查服务器文件权限。");
    }
  })();
  async function reports(configuration) {
    await load();
    const scope = scopeFor(configuration);
    return records.filter((record) => record.scope === scope).map(publicReport);
  }
  async function test(configuration, model, { signal } = {}) {
    await load();
    const provider = createOpenAICompatible({ name: "api_base", baseURL: configuration.baseURL,
      apiKey: configuration.apiKey, fetch: fetchImpl });
    const checks = {}, scope = scopeFor(configuration);
    let denied = false;
    async function check(capability, work) {
      if (denied) { checks[capability] = { state: "failed", message: "前一步鉴权失败，未继续发送请求。", elapsedMs: 0 }; return; }
      signal?.throwIfAborted();
      const timeout = AbortSignal.timeout(timeoutMs);
      const abortSignal = AbortSignal.any([timeout, ...(signal ? [signal] : [])]);
      const start = performance.now();
      try {
        await work({ model: provider(model), maxRetries: 0, maxOutputTokens: 2048, abortSignal });
        checks[capability] = { state: "supported", message: "测试通过。" };
      } catch (error) {
        if (signal?.aborted) throw fail(409, "模型测试已取消。");
        denied = [401, 403].includes(error.statusCode);
        checks[capability] = checkFailure(error, capability, timeout.aborted);
      }
      checks[capability].elapsedMs = Math.round(performance.now() - start);
    }
    await check("streaming", async (options) => {
      const result = streamText({ ...options, prompt: "请只回复 OK，不要解释。", onError: () => {} });
      let text = "";
      for await (const event of result.fullStream) {
        if (event.type === "error") throw event.error;
        if (event.type === "text-delta") text += event.text;
      }
      if (await result.finishReason !== "stop" || !text.trim()) throw new Error("不完整的文本响应。");
    });
    await check("json", async (options) => {
      const result = await generateText({ ...options, prompt: '只返回 JSON 对象 {"ok":true}。', output: Output.json() });
      if (result.finishReason !== "stop" || result.output?.ok !== true) throw new Error("JSON 测试未通过。");
    });
    await check("image", async (options) => {
      const pixels = await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160"><rect width="240" height="160" fill="white"/><text x="50" y="115" font-family="sans-serif" font-size="100" fill="black">42</text></svg>')).png().toBuffer();
      const result = await generateText({ ...options, messages: [{ role: "user", content: [
        { type: "text", text: "读取图片中的数字，只回复数字，不要解释。" },
        { type: "file", data: pixels, mediaType: "image/png" },
      ] }] });
      if (result.finishReason !== "stop" || result.text.replace(/\s/g, "") !== "42") throw new Error("图片测试未通过。");
    });
    signal?.throwIfAborted();
    const report = { scope, model, checkedAt: new Date().toISOString(),
      passed: Object.values(checks).every((result) => result.state === "supported"), checks };
    const next = [...records.filter((record) => record.scope !== scope || record.model !== model), report].slice(-200);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify({ checks: next }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
      await rename(temporary, filename);
      records = next;
    } finally { await unlink(temporary).catch((error) => { if (error.code !== "ENOENT") throw error; }); }
    return publicReport(report);
  }
  return { reports, test };
}
