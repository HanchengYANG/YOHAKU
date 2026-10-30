// Explicit live checks through the website owner's existing subscription.
// Materials stay untouched; CLI state and reports use a separate artifact dir.
import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import sharp from "sharp";
import { createChatGPTAuth } from "../server/providers/openai/auth.mjs";
import { createCodexRuntime } from "../server/providers/openai/runtime.mjs";
import { createWebRuntime } from "../server/providers/openai/web-runtime.mjs";
import { selectVerificationUser } from "./verify-ai.mjs";
import { OCR_BODY_SCHEMA, OCR_TRANSCRIPTION_PROMPT } from "../shared/ocr.mjs";
import { SENTENCE_SCHEMA, sentencePrompt, validateSentences } from "../shared/sentences.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run verify:stage3 -- [--user=网站拥有者用户名] [--image=图片路径] [--search-only]\n使用网站已有共享订阅，验证真实图片识别（可选）、文章与歌词分句及实时联网来源；不会创建或修改网站材料。");
  process.exit(0);
}
if (args.some((arg) => !arg.startsWith("--image=") && !arg.startsWith("--user=") && arg !== "--search-only"))
  throw new Error("参数支持 --user=网站拥有者用户名、--image=图片路径、--search-only。");
const imagePath = args.find((arg) => arg.startsWith("--image="))?.slice(8);
const searchOnly = args.includes("--search-only");
const dataDir = resolve(process.env.DATA_DIR || "data");
const user = selectVerificationUser(dataDir, args.filter((arg) => arg.startsWith("--user=")));
const auth = createChatGPTAuth({
  storageDir: join(dataDir, "users", user.id, "providers", "openai"),
  callbackUri: "http://127.0.0.1:4317/auth/callback",
});
const output = resolve("artifacts", "stage3-live", randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const cli = createCodexRuntime({ auth, storageDir: join(output, "runtime"), turnTimeoutMs: 180000 });
const web = createWebRuntime({ auth });
const report = { startedAt: new Date().toISOString(), sentences: [], search: null, passed: false };
const save = (name, value) => writeFile(join(output, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
try {
  const account = await auth.status();
  if (!account.connected || !user.subjects.includes(account.subject)) throw new Error("当前共享订阅未连接或不匹配既有绑定。");
  const identity = { expectedAccountId: account.activeAccountId || account.id, expectedSubject: account.subject };
  if (!searchOnly) {
    let ocrBody = null;
    if (imagePath) {
      const image = await readFile(resolve(imagePath));
      const { format } = await sharp(image).metadata();
      const mime = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[format];
      if (!mime) throw new Error("验证图片仅支持 PNG、JPEG 和 WebP。");
      const ocr = await cli.run({ ...identity, image: `data:${mime};base64,${image.toString("base64")}`, schema: OCR_BODY_SCHEMA, prompt: OCR_TRANSCRIPTION_PROMPT });
      ocrBody = JSON.parse(ocr.text).text;
      report.ocr = { imagePath: resolve(imagePath), completed: ocr.completed, text: ocrBody, model: ocr.model, passed: ocr.completed && typeof ocrBody === "string" && ocrBody.trim().length > 10 };
    }
    const samples = [
      ...(ocrBody ? [ocrBody] : []),
      "すべての日本人が名字を持つようになったのは、明治時代になってからです。当時の政府が、すべての国民が名字を持つことを法律で決めました。",
      "君の声が聞こえる\n遠い空を見上げて\n今日も歩いてゆく",
    ];
    for (const text of samples) {
      const result = await cli.run({ ...identity, prompt: sentencePrompt(text), schema: SENTENCE_SCHEMA });
      await save(`sentence-${report.sentences.length}.json`, { input: text, result });
      const fragments = validateSentences(JSON.parse(result.text), text);
      report.sentences.push({ text, fragments, completed: result.completed, model: result.model, passed: result.completed && fragments.length > 1 });
    }
  }
  const { model } = await cli.prepare(identity);
  const result = await web.run({ ...identity, model, prompt: "学习选区「国立国会図書館」，所在句子「国立国会図書館を利用します。」。请现在实际联网搜索国立国会图书馆的官方利用指南，给出东京本馆利用者登记要求。必须用网页搜索工具核实，区分这句原文与检索背景，用中文简短回答并附可点击 Markdown 格式官方来源链接。若联网失败请明确说明。" });
  report.search = { ...result, passed: result.completed && result.webSearch?.performed && result.sources?.some((source) => new URL(source.url).hostname.endsWith("ndl.go.jp")) };
  report.passed = (searchOnly || (!imagePath || report.ocr?.passed) && report.sentences.every((item) => item.passed)) && report.search.passed;
} catch (error) {
  report.error = String(error.message).replace(/Bearer\s+\S+/gi, "Bearer [hidden]").slice(0, 1000);
} finally {
  cli.stop(); web.stop();
  report.runtime = { ...cli.status(), web: web.status() };
  report.finishedAt = new Date().toISOString();
  await save("report.json", report);
}
console.log(JSON.stringify({ output, passed: report.passed, sentences: report.sentences.map(({ passed, fragments }) => ({ passed, count: fragments.length })), search: report.search ? { passed: report.search.passed, performed: report.search.webSearch?.performed, sources: report.search.sources } : null, error: report.error }));
process.exitCode = report.passed ? 0 : 1;
