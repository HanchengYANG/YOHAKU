// Opt-in live verification. Only the owner's existing shared authorization is
// read from DATA_DIR; all website accounts, images, task state and runtime files
// created by this check live in a fresh private artifacts directory.
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import sharp from "sharp";
import { createApp } from "../server/app.mjs";
import { createChatGPTAuth } from "../server/providers/openai/auth.mjs";
import { createCodexRuntime } from "../server/providers/openai/runtime.mjs";
import { selectVerificationUser } from "./verify-ai.mjs";
import { OCR_BODY_SCHEMA } from "../shared/ocr.mjs";
import { ANNOTATION_SCHEMA } from "../shared/ocr-correction.mjs";
import { plainText } from "../shared/document.mjs";
import { bodyText } from "../shared/article-html.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("npm run verify:image-tasks -- --image=/绝对路径/原图.png [--user=网站拥有者用户名]\n使用已有共享订阅真实识别、注音一张原图，并验证提交连接关闭、跨登录会话读取及服务重开恢复。所有验证数据写入 artifacts/image-tasks-live/，不创建或修改现有网站文章，不需要 API key。");
  process.exit(0);
}

const output = join(root, "artifacts", "image-tasks-live", randomUUID());
await mkdir(output, { recursive: true, mode: 0o700 });
const report = { startedAt: new Date().toISOString(), stage: "preflight", preflightPassed: false,
  realInference: false, inferenceCalls: { recognize: 0, annotate: 0 }, checks: {}, passed: false };
const save = () => writeFile(join(output, "report.json"), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
const safeMessage = (error) => String(error?.message || "验证未完成")
  .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
  .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[已隐藏]")
  .replace(/(?:access_token|refresh_token|id_token|password|cookie)\s*[:=]\s*[^\s,}]+/gi, "[凭据已隐藏]")
  .slice(0, 1000);
const check = (condition, message) => { if (!condition) throw new Error(message); };
const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
const credentials = { username: `verify_${randomBytes(6).toString("hex")}`, password: randomBytes(32).toString("base64url") };
const isolatedData = join(output, "data");
let current = null, cli = null;

async function stop() {
  if (!current) return;
  const closing = current;
  current = null;
  await closing.application.shutdown();
  await new Promise((resolveStop) => {
    closing.server.close(resolveStop);
    closing.server.closeAllConnections();
  });
}
async function request(path, { method = "GET", body, cookie } = {}) {
  const multipart = body instanceof FormData;
  const response = await fetch(`${current.url}/api${path}`, { method,
    headers: { Connection: "close", ...(cookie ? { Cookie: cookie } : {}),
      ...(body !== undefined && !multipart ? { "Content-Type": "application/json" } : {}) },
    ...(body !== undefined ? { body: multipart ? body : JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  const payload = response.status === 204 ? null : await response.json();
  if (!response.ok) throw new Error(`验证接口 ${path.replace(/[0-9a-f-]{36}/g, "[id]")} 返回 ${response.status}：${payload?.error || "请求失败"}`);
  return { response, data: payload };
}
function sessionCookie(response) {
  const cookie = response.headers.getSetCookie().find((value) => value.startsWith("yohaku_session="));
  check(cookie, "真实网站登录接口没有返回会话 Cookie。");
  return cookie.split(";", 1)[0];
}

try {
  check(args.length > 0 && args.every((arg) => arg.startsWith("--image=") || arg.startsWith("--user=")), "参数仅支持 --image=图片路径 和可选 --user=网站拥有者用户名。");
  const imageArgs = args.filter((arg) => arg.startsWith("--image="));
  check(imageArgs.length === 1 && imageArgs[0].slice(8).trim(), "必须提供一个 --image=图片路径；尚未发送推理请求。");
  const imagePath = resolve(imageArgs[0].slice(8));
  const pixels = await readFile(imagePath);
  const metadata = await sharp(pixels, { limitInputPixels: 40000000 }).metadata();
  const mimeType = { png: "image/png", jpeg: "image/jpeg", webp: "image/webp" }[metadata.format];
  check(mimeType && pixels.length <= 12 * 1024 * 1024 && (metadata.pages || 1) === 1,
    "验证图片需要是 12 MB 以内的静态 PNG、JPEG 或 WebP；尚未发送推理请求。");
  const realData = resolve(process.env.DATA_DIR || join(root, "data"));
  const user = selectVerificationUser(realData, args.filter((arg) => arg.startsWith("--user=")));
  const originalAuth = createChatGPTAuth({ storageDir: join(realData, "users", user.id, "providers", "openai"),
    callbackUri: "http://127.0.0.1:4317/auth/callback" });
  const account = await originalAuth.status();
  check(account.connected && user.subjects.includes(account.subject), "当前拥有者共享订阅未连接或不匹配既有绑定；尚未发送推理请求。");
  const identity = { expectedAccountId: account.activeAccountId || account.id, expectedSubject: account.subject };
  const auth = { ...originalAuth, status: async () => {
    const status = await originalAuth.status();
    check(status.connected && status.subject === identity.expectedSubject &&
      (status.activeAccountId || status.id) === identity.expectedAccountId, "共享授权身份已变化，真实验证已停止。");
    return status;
  } };
  function makeRuntime(directory) {
    const instance = createCodexRuntime({ auth, storageDir: join(output, directory), turnTimeoutMs: 180000 });
    cli = instance;
    return { ...instance, run: async (input) => {
      check(input.schema === OCR_BODY_SCHEMA || input.schema === ANNOTATION_SCHEMA, "验证范围仅允许真实识别与注音。");
      check(input.expectedAccountId === identity.expectedAccountId && input.expectedSubject === identity.expectedSubject,
        "运行时授权身份不匹配，真实验证已停止。");
      report.realInference = true;
      report.inferenceCalls[input.schema === OCR_BODY_SCHEMA ? "recognize" : "annotate"]++;
      await save();
      return instance.run(input);
    } };
  }
  let runtime = makeRuntime("runtime");
  const prepared = await runtime.prepare(identity);
  report.model = prepared.model;
  report.preflightPassed = true;
  report.image = { filename: basename(imagePath), bytes: pixels.length, sha256: sha256(pixels) };
  async function start() {
    const application = createApp({ dataDir: isolatedData, aiServices: { auth, runtime },
      imageTaskOptions: { runnerOptions: { maxAutomaticRetries: 0, pollIntervalMs: 100 } } });
    const server = application.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    current = { application, server, url: `http://127.0.0.1:${server.address().port}` };
  }
  await start();
  const setup = await request("/accounts/setup", { method: "POST", body: credentials });
  const deviceA = sessionCookie(setup.response);
  let task = (await request("/image-tasks", { method: "POST", cookie: deviceA,
    body: { idempotencyKey: randomUUID(), title: "真实任务隔离验证" } })).data;
  const itemId = randomUUID();
  task = (await request(`/image-tasks/${task.id}/items`, { method: "POST", cookie: deviceA,
    body: { version: task.version, items: [{ id: itemId, name: basename(imagePath) }] } })).data;
  const upload = new FormData(); upload.append("image", new Blob([pixels], { type: mimeType }), basename(imagePath));
  task = (await request(`/image-tasks/${task.id}/items/${itemId}/image`, { method: "POST", cookie: deviceA, body: upload })).data;
  report.stage = "submitted";
  const submission = await request(`/image-tasks/${task.id}/submit`, { method: "POST", cookie: deviceA, body: { version: task.version } });
  task = submission.data;
  report.taskId = task.id;
  report.checks.submissionConnectionClosed = submission.response.headers.get("connection")?.toLowerCase() === "close";
  await request("/session/logout", { method: "POST", cookie: deviceA, body: {} });
  const login = await request("/session/login", { method: "POST", body: credentials });
  const deviceB = sessionCookie(login.response);
  check(deviceA !== deviceB, "第二设备未获得独立登录会话。");
  report.checks.independentLoginSession = true;
  await save();
  const deadline = Date.now() + 10 * 60 * 1000;
  let lastVersion = -1;
  while (Date.now() < deadline) {
    task = (await request(`/image-tasks/${task.id}`, { cookie: deviceB })).data;
    if (task.version !== lastVersion) {
      lastVersion = task.version;
      report.stage = task.state;
      report.task = { state: task.state, counts: task.counts, resultVersion: task.resultVersion };
      await save();
    }
    if (task.state === "ready") break;
    if (["needs_attention", "blocked", "cancelled"].includes(task.state))
      throw new Error(`真实图片任务未成功：${task.lastError || task.blockedReason || task.state}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 1000));
  }
  check(task.state === "ready", "真实任务等待超时，未把未完成状态当作验收通过。");
  const result = (await request(`/image-tasks/${task.id}/result`, { cookie: deviceB })).data;
  const source = result.sourceImages[0];
  const recognized = source?.recognition?.blocks;
  const annotated = source?.recognition?.annotation?.blocks;
  report.checks.taskReady = true;
  report.checks.ocrNonempty = Array.isArray(recognized) && plainText(recognized).trim().length > 0;
  report.checks.annotationExactBody = Array.isArray(annotated) && plainText(annotated) === plainText(recognized);
  report.checks.resultExactBody = bodyText(result.bodyHtml) === plainText(recognized);
  report.checks.crossSessionResult = result.taskId === task.id && result.sourceImages.length === 1;
  report.text = { characters: Array.isArray(recognized) ? plainText(recognized).length : 0,
    readings: Array.isArray(annotated) ? annotated.flatMap((block) => block.segments).filter((segment) => segment.reading).length : 0 };
  const raw = await fetch(`${current.url}/api/images/${source.id}/raw`, {
    headers: { Cookie: deviceB, Connection: "close" }, signal: AbortSignal.timeout(30000),
  });
  check(raw.ok, "无法读取隔离上传原图。");
  report.checks.uploadedBytesMatch = sha256(Buffer.from(await raw.arrayBuffer())) === sha256(pixels);
  await writeFile(join(output, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  await stop();
  runtime = makeRuntime("runtime-reopened");
  await start();
  const restored = (await request(`/image-tasks/${task.id}`, { cookie: deviceB })).data;
  const restoredResult = (await request(`/image-tasks/${task.id}/result`, { cookie: deviceB })).data;
  report.checks.restartPersisted = restored.state === "ready" && restored.resultVersion === task.resultVersion &&
    restoredResult.content === result.content && restoredResult.sourceImages[0]?.id === source.id;
  const database = new DatabaseSync(join(isolatedData, "yohaku.sqlite"), { readOnly: true });
  try { report.checks.noFormalArticles = database.prepare("SELECT count(*) AS count FROM documents").get().count === 0; }
  finally { database.close(); }
  report.checks.onlyExpectedInference = report.inferenceCalls.recognize === 1 && report.inferenceCalls.annotate === 1;
  report.passed = Object.values(report.checks).every((value) => value === true);
  report.stage = report.passed ? "passed" : "failed";
} catch (error) {
  report.error = safeMessage(error);
  report.stage = report.preflightPassed ? "failed" : "preflight_failed";
} finally {
  try { await stop(); } catch (error) { report.shutdownError = safeMessage(error); report.passed = false; }
  cli?.stop();
  report.finishedAt = new Date().toISOString();
  await save();
}
console.log(JSON.stringify({ output, passed: report.passed, stage: report.stage,
  realInference: report.realInference, inferenceCalls: report.inferenceCalls, checks: report.checks,
  ...(report.text ? { text: report.text } : {}), ...(report.error ? { error: report.error } : {}) }));
process.exitCode = report.passed ? 0 : report.stage === "preflight_failed" ? 2 : 1;
