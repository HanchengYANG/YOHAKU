// Opt-in real inference using the owner's saved iliad codix configuration.
// Never reads a key from arguments or prints credentials; leaves website data intact.
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import { createProviderConnection } from "../server/providers/index.mjs";
import { SENTENCE_SCHEMA, sentencePrompt, validateSentences } from "../shared/sentences.mjs";
import { OCR_BODY_SCHEMA, OCR_TRANSCRIPTION_PROMPT, expandOcrBody, validateOcr } from "../shared/ocr.mjs";
import { ANNOTATION_SCHEMA, buildOcrAnnotationPrompt, applyOcrAnnotations } from "../shared/ocr-correction.mjs";
import { plainText } from "../shared/document.mjs";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("先由网站拥有者在 AI 设置保存 iliad codix 的 API key、测试并启用模型，再执行 npm run verify:api-base [-- --image=/绝对路径/图片.png]。默认使用合成日语文字图片验证，不修改网站材料。");
  process.exit(0);
}
const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
const reportDir = join(root, "artifacts", "api-base-live");
const fail = (message) => Object.assign(new Error(message), { expose: true });
let connection;
const report = { startedAt: new Date().toISOString(), steps: [] };
try {
  if (args.length > 1 || args.some((arg) => !arg.startsWith("--image=") || !arg.slice(8)))
    throw fail("参数仅支持 --image=/绝对路径/图片.png。");
  let database, owner, active;
  try {
    database = new DatabaseSync(join(dataDir, "yohaku.sqlite"), { readOnly: true });
    owner = database.prepare("SELECT id FROM users WHERE is_admin=1 ORDER BY created_at,id LIMIT 1").get();
    active = database.prepare("SELECT provider_id FROM user_providers WHERE user_id=?").get(owner?.id || "");
  } finally { database?.close(); }
  if (!owner || active?.provider_id !== "api_base")
    throw fail("请先由网站拥有者在 AI 设置中选择 iliad codix 并保存 API key；尚未发送请求。");
  connection = createProviderConnection({ providerId: "api_base", storageDir: join(dataDir, "users", owner.id, "providers") });
  const status = await connection.status();
  if (!status.connected) throw fail("请先在 AI 设置保存 API key、测试并启用模型；尚未发送请求。");
  report.model = status.configuration.model;
  const account = status.authentication;
  const expected = { expectedAccountId: account.activeAccountId, expectedSubject: account.subject };
  const check = async (name, input, verify) => {
    const start = performance.now();
    console.log(`${name}：正在验证…`);
    const result = await connection.runtime.run({ ...input, ...expected });
    assert.equal(result.completed, true);
    verify(result);
    report.steps.push({ name, passed: true, elapsedMs: Math.round(performance.now() - start), model: result.model });
    console.log(`${name}：通过`);
    return result;
  };
  let streamed = "";
  await check("流式问答", { prompt: "请用一句简短中文解释日语「余白」的意思。", webSearch: true,
    onEvent: async (event) => { if (event.type === "delta") streamed += event.delta; } }, (result) => {
    assert.ok(streamed.trim());
    assert.equal(streamed, result.text);
    assert.equal(result.webSearch.performed, false);
  });
  const text = "日本語を読む。余白に書く。";
  await check("JSON 分句", { prompt: sentencePrompt(text), schema: SENTENCE_SCHEMA },
    (result) => validateSentences(JSON.parse(result.text), text));
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  const customImage = args[0]?.slice(8);
  const pixels = customImage ? await sharp(await readFile(resolve(customImage))).rotate().png().toBuffer()
    : await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="960" height="240"><rect width="960" height="240" fill="white"/><text x="60" y="145" font-family="Noto Sans CJK JP" font-size="72" fill="black">日本語を読む。</text></svg>')).png().toBuffer();
  if (!customImage) await writeFile(join(reportDir, "fixture.png"), pixels, { mode: 0o600 });
  const image = `data:image/png;base64,${pixels.toString("base64")}`;
  let draft;
  await check("图片正文识别", { prompt: OCR_TRANSCRIPTION_PROMPT, schema: OCR_BODY_SCHEMA, image }, (result) => {
    draft = validateOcr(expandOcrBody(JSON.parse(result.text)));
    if (!customImage) assert.equal(plainText(draft.blocks).replace(/\s/g, ""), "日本語を読む。");
  });
  await check("参考原图注音", { prompt: buildOcrAnnotationPrompt(draft.blocks), schema: ANNOTATION_SCHEMA, image }, (result) => {
    const blocks = applyOcrAnnotations(JSON.parse(result.text), draft.blocks);
    assert.equal(plainText(blocks), plainText(draft.blocks));
    if (!customImage) assert.ok(blocks.some((block) => block.segments.some((segment) => segment.reading)));
  });
  report.passed = true;
  console.log("四项真实调用验证完成。真实书页的识别与特殊读音质量仍需另行核对。");
} catch (error) {
  report.passed = false;
  // SDK/network errors are already sanitized by the provider adapter.
  const message = error.expose
    ? error.message : "验证未通过；请检查已配置模型是否支持图片、流式和 JSON 输出。";
  console.error(message);
  process.exitCode = 1;
} finally {
  connection?.close();
  if (connection) {
    await mkdir(reportDir, { recursive: true, mode: 0o700 });
    await writeFile(join(reportDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  }
}
