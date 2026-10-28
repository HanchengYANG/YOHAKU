// Opt-in live provider verification. This CLI uses only this app's already-bound
// SIWC connection; it neither logs in nor creates/changes website materials.
import {
  readFile,
  writeFile,
  mkdir,
  chmod,
  rename,
  unlink,
} from "node:fs/promises";
import { createConnection } from "node:net";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import sharp from "sharp";
import { createProviderConnection } from "../server/providers/index.mjs";
import {
  OCR_SCHEMA, OCR_PROMPT, validateOcr, normalizeNewOcrDraft,
} from "../shared/ocr.mjs";
import { plainText } from "../shared/document.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dataDir = resolve(process.env.DATA_DIR || join(root, "data"));
const args = process.argv.slice(2);
class PreflightError extends Error {}
const prerequisite = (message) => {
  throw new PreflightError(`${message} 尚未发送推理请求。`);
};
const safeMessage = (error) =>
  String(error?.message || "验证未完成")
    .replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]")
    .replace(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[已隐藏]")
    .slice(0, 1000);

export function selectVerificationUser(dataDirectory, requestedArgs = []) {
  const values = requestedArgs.filter((arg) => arg.startsWith("--user="));
  if (
    values.length > 1 ||
    requestedArgs.some(
      (arg) =>
        arg !== "--resume" && arg !== "--help" && !arg.startsWith("--user="),
    )
  )
    prerequisite("参数仅支持 --user=网站用户名、--resume 或 --help。");
  const username = values[0]?.slice(7).trim().normalize("NFKC");
  if (values.length && !username)
    prerequisite("--user 需要填写自己的站内用户名。");
  let database;
  try {
    database = new DatabaseSync(join(dataDirectory, "yohaku.sqlite"), {
      readOnly: true,
    });
    const names = database
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((row) => row.name);
    if (
      !["users", "app_settings", "provider_bindings"].every((name) =>
        names.includes(name),
      )
    )
      prerequisite("请先打开网站完成账号设置和 AI 绑定。");
    const legacyOwner = database
      .prepare("SELECT value FROM app_settings WHERE key='legacy_owner'")
      .get()?.value;
    const user = username
      ? database
          .prepare("SELECT id,username FROM users WHERE username_key=?")
          .get(username.toLowerCase())
      : database
          .prepare("SELECT id,username FROM users WHERE id=?")
          .get(legacyOwner || "");
    if (
      !user ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        user.id,
      )
    )
      prerequisite(
        "未找到已完成设置的网站账号；先设置账号，或用 --user=自己的用户名选择。",
      );
    const providerId = names.includes("user_providers")
      ? database
          .prepare("SELECT provider_id FROM user_providers WHERE user_id=?")
          .get(user.id)?.provider_id || "openai"
      : "openai";
    if (providerId !== "openai")
      prerequisite("当前验证仅支持已实现的 OpenAI 订阅连接。");
    const subjects = database
      .prepare(
        "SELECT subject FROM provider_bindings WHERE user_id=? AND provider_id='openai'",
      )
      .all(user.id)
      .map((row) => row.subject);
    if (!subjects.length)
      prerequisite(
        "请先登录该网站账号，在 AI 设置完成自己的订阅授权或显式认领。",
      );
    return { ...user, subjects, providerId };
  } catch (error) {
    if (error instanceof PreflightError) throw error;
    prerequisite(
      "无法读取网站账号设置；请先在当前 DATA_DIR 完成网站账号和订阅绑定。",
    );
  } finally {
    database?.close();
  }
}

async function websiteIsRunning() {
  return new Promise((resolveResult) => {
    const socket = createConnection({ host: "127.0.0.1", port: 4317 });
    const finish = (running) => {
      socket.destroy();
      resolveResult(running);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(1000, () => finish(false));
  });
}

async function savePrivate(directory, filename, value) {
  const target = join(directory, filename),
    temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, value, { mode: 0o600, flag: "wx" });
    await rename(temporary, target);
    await chmod(target, 0o600);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
const saveJSON = (directory, filename, value) =>
  savePrivate(directory, filename, `${JSON.stringify(value, null, 2)}\n`);
const initialPassed = (report) =>
  report.chat?.passed === true &&
  report.images?.length === 4 &&
  report.images.every(
    (image) => image.completed === true && image.anchorsPassed === true,
  );

async function completed(runtime, input) {
  const result = await runtime.run(input);
  if (
    result?.completed !== true ||
    typeof result.text !== "string" ||
    !result.text.trim() ||
    typeof result.threadId !== "string" ||
    !result.threadId
  )
    throw new Error("AI 没有返回完整成功结果，未把部分输出当作验收通过。");
  return result;
}

export function checkImage(name, draft) {
  const text = plainText(draft.blocks).replace(/\s/g, "");
  const segments = draft.blocks.flatMap((block) => block.segments);
  const readings = segments.filter((segment) => segment.reading);
  const validOrigins =
    readings.length > 0 &&
    readings.every((segment) => ["source", "generated"].includes(segment.origin));
  const phonetic = segments
    .map((segment) => segment.reading || segment.text)
    .join("")
    .replace(/\s/g, "");
  if (name === "01-lyrics")
    return [
      validOrigins,
      text.includes("僕が生まれた日の空"),
      text.includes("背中を撫でる声"),
      phonetic.includes("せなか"),
      phonetic.includes("うまれた"),
    ];
  if (name === "02-textbook")
    return [
      validOrigins,
      text.includes("中国語"),
      text.includes("明治時代"),
      phonetic.includes("めいじじだい"),
      draft.nonBody.some((item) => item.type === "handwriting"),
      draft.nonBody.some(
        (item) => item.type === "page_number" && item.text.includes("62"),
      ),
    ];
  if (name === "03-vertical")
    return [
      validOrigins,
      draft.orientation === "vertical",
      text.indexOf("お花見") >= 0 &&
        text.indexOf("お花見") < text.indexOf("梅雨"),
      draft.blocks.some((block) => block.sourcePage === "right"),
      draft.blocks.some((block) => block.sourcePage === "left"),
    ];
  return [
    validOrigins,
    text === "今日は図書館で日本語を勉強します。",
    phonetic.includes("としょかん"),
    phonetic.includes("にほんご"),
  ];
}

async function main() {
  const user = selectVerificationUser(dataDir, args);
  if (await websiteIsRunning())
    prerequisite(
      "检测到本机 4317 服务仍在运行。请先停止网站，再运行此 CLI，避免并发刷新同一授权；--resume 也需要先停网站。",
    );
  const provider = createProviderConnection({
    providerId: "openai",
    storageDir: join(dataDir, "users", user.id, "providers"),
    callbackUri: "http://127.0.0.1:4317/auth/callback",
  });
  try {
    const status = await provider.auth.status();
    if (
      !status.connected ||
      !status.subject ||
      !user.subjects.includes(status.subject)
    )
      prerequisite(
        "此网站账号尚未连接自己的已绑定 OpenAI 订阅。请先回网站完成绑定，勿向聊天提供密码或 Cookie。",
      );
    const identity = createHash("sha256")
      .update(
        JSON.stringify([
          user.id,
          "openai",
          status.subject,
          status.clientId,
          status.activeAccountId,
        ]),
      )
      .digest("hex");
    const output = join(
      root, "artifacts", "ai-verification", user.id, "image-first-context-fallback",
    );
    await mkdir(output, { recursive: true, mode: 0o700 });
    await chmod(output, 0o700);
    console.log(
      `验证站内账号：${user.username}；提供方：OpenAI；路径：本应用 SIWC + Codex app-server。`,
    );
    console.log(
      `本轮报告目录：artifacts/ai-verification/${user.id}/image-first-context-fallback/。`,
    );

    if (args.includes("--resume")) {
      let state, report;
      try {
        state = JSON.parse(await readFile(join(output, "state.json"), "utf8"));
        report = JSON.parse(
          await readFile(join(output, "report.json"), "utf8"),
        );
      } catch {
        prerequisite("没有可恢复的验证记录，请先运行 npm run verify:ai。");
      }
      if (
        state.identity !== identity ||
        state.userId !== user.id ||
        state.providerId !== "openai" ||
        state.readingPolicy !== "image_first_context_fallback" ||
        report.readingPolicy !== "image_first_context_fallback" ||
        state.runId !== report.runId ||
        typeof state.threadId !== "string" ||
        !state.threadId ||
        typeof state.code !== "string" ||
        !/^月灯-[0-9a-f]{10}$/.test(state.code) ||
        state.processId === process.pid
      )
        prerequisite(
          "验证记录与当前账号或注音策略不符，或不是新的 CLI 进程；请重新执行初次验证。",
        );
      try {
        const result = await completed(provider.runtime, {
          threadId: state.threadId,
          prompt:
            "刚才为这次讨论约定的代号是什么？请原样回答代号，再用中文简短说明我们讨论过的词形。",
        });
        report.resume = {
          checkedAt: new Date().toISOString(),
          completed: true,
          freshCLIProcess: true,
          sameThread: result.threadId === state.threadId,
          model: result.model,
          answer: result.text,
          passed:
            result.threadId === state.threadId &&
            result.text.includes(state.code),
        };
      } catch (error) {
        report.resume = {
          checkedAt: new Date().toISOString(),
          completed: false,
          passed: false,
          error: safeMessage(error),
        };
      }
      report.allChecksPassed =
        initialPassed(report) && report.resume.passed === true;
      await saveJSON(output, "report.json", report);
      process.exitCode = report.allChecksPassed ? 0 : 1;
      console.log(
        report.resume.passed
          ? "新 CLI 进程恢复原线程并复述随机代号：通过。"
          : "新 CLI 续聊未通过，请查看 report.json。没有把失败或部分输出标为通过。",
      );
      if (!report.allChecksPassed)
        console.log(
          "完整能力核对仍有未通过项；请逐项检查报告，不能据此宣称全部完成。",
        );
      return;
    }

    const report = {
      runId: randomUUID(),
      startedAt: new Date().toISOString(),
      userId: user.id,
      username: user.username,
      providerId: "openai",
      readingPolicy: "image_first_context_fallback",
      authPath: "本应用独立 SIWC + Codex app-server",
      realInference: false,
      scope:
        "真实 provider、模型、多轮、OCR 和新 CLI 线程恢复；本脚本不验证 HTTP、SQLite 或 UI 的真实模型流程。",
      requiresHumanImageReview: true,
      chat: null,
      images: [],
      resume: null,
      allChecksPassed: false,
    };
    await saveJSON(output, "report.json", report);
    const code = `月灯-${randomBytes(5).toString("hex")}`;
    try {
      const first = await completed(provider.runtime, {
        prompt: `原文：「僕が生まれた日」「背中を撫でる声」。请用中文解释「生まれた」的词形，说明辞书形与た形，并记住这次讨论的代号是「${code}」。代号只用于随后验证多轮上下文。`,
      });
      report.realInference = true;
      await saveJSON(output, "state.json", {
        runId: report.runId,
        userId: user.id,
        providerId: "openai",
        readingPolicy: "image_first_context_fallback",
        identity,
        threadId: first.threadId,
        code,
        processId: process.pid,
        createdAt: new Date().toISOString(),
      });
      const second = await completed(provider.runtime, {
        threadId: first.threadId,
        prompt:
          "刚才约定的讨论代号是什么？请原样写出来，再给出一个不同的日语例句。",
      });
      const grammarAnchorsPassed =
        first.text.includes("生まれる") &&
        /过去|过去式|过去形|动词|词形|た形/.test(first.text);
      report.chat = {
        completedTurns: 2,
        model: first.model,
        threadId: first.threadId,
        firstAnswer: first.text,
        followupAnswer: second.text,
        grammarAnchorsPassed,
        contextPassed: second.text.includes(code),
        sameThread: second.threadId === first.threadId,
        passed:
          grammarAnchorsPassed &&
          second.text.includes(code) &&
          second.threadId === first.threadId,
      };
    } catch (error) {
      report.chat = { passed: false, error: safeMessage(error) };
    }
    await saveJSON(output, "report.json", report);

    const fresh = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="220"><rect width="100%" height="100%" fill="white"/><text x="40" y="120" font-family="Noto Sans CJK JP" font-size="48">今日は図書館で日本語を勉強します。</text></svg>',
      ),
    )
      .png()
      .toBuffer();
    await savePrivate(output, "04-unseen-text.png", fresh);
    const samples = [
      [
        "01-lyrics",
        join(root, "fixtures/images/01-lyrics-ruby.png"),
        "image/png",
      ],
      [
        "02-textbook",
        join(root, "fixtures/images/02-horizontal-book-photo.jpg"),
        "image/jpeg",
      ],
      [
        "03-vertical",
        join(root, "fixtures/images/03-vertical-book-spread.jpg"),
        "image/jpeg",
      ],
      ["04-unseen", join(output, "04-unseen-text.png"), "image/png"],
    ];
    for (const [name, filename, mime] of samples) {
      try {
        const original = await readFile(filename);
        const metadata = await sharp(original, {
          limitInputPixels: 40000000,
        }).metadata();
        const pixels =
          metadata.orientation && metadata.orientation !== 1
            ? await sharp(original, { limitInputPixels: 40000000 })
                .rotate()
                .toBuffer()
            : original;
        const result = await completed(provider.runtime, {
          prompt: OCR_PROMPT,
          schema: OCR_SCHEMA,
          image: `data:${mime};base64,${pixels.toString("base64")}`,
        });
        report.realInference = true;
        const draft = normalizeNewOcrDraft(validateOcr(JSON.parse(result.text)));
        const anchors = checkImage(name, draft);
        await saveJSON(output, `${name}.json`, {
          ...draft,
          completed: true,
          model: result.model,
          readingPolicy: "image_first_context_fallback",
        });
        report.images.push({
          name,
          completed: true,
          model: result.model,
          anchorsPassed: anchors.every(Boolean),
          anchors,
          warnings: draft.warnings,
          readingOrder: draft.readingOrder,
        });
        console.log(
          `${name}：真实识别完成，核对点 ${anchors.filter(Boolean).length}/${anchors.length}；仍需逐图人工校对。`,
        );
      } catch (error) {
        const failure = {
          name,
          completed: false,
          anchorsPassed: false,
          error: safeMessage(error),
        };
        report.images.push(failure);
        await saveJSON(output, `${name}.json`, failure);
        console.error(`${name}：${failure.error}`);
      }
      await saveJSON(output, "report.json", report);
    }
    report.initialChecksPassed = initialPassed(report);
    report.finishedInitialAt = new Date().toISOString();
    await saveJSON(output, "report.json", report);
    process.exitCode = report.initialChecksPassed ? 0 : 1;
    console.log(
      `结果保存在 artifacts/ai-verification/${user.id}/image-first-context-fallback/。网站保持停止，用新的 CLI 进程运行 npm run verify:ai -- --resume${args.find((arg) => arg.startsWith("--user=")) ? ` ${args.find((arg) => arg.startsWith("--user="))}` : ""} 验证续聊。`,
    );
    console.log(
      "本报告只证明对应 provider 能力与核对点；HTTP、SQLite、UI 的证据来自独立测试，不等于完整网站真模型流程已验收。",
    );
  } finally {
    provider.close();
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (args.includes("--help")) {
    console.log(
      "npm run verify:ai -- [--user=自己的站内用户名] [--resume]\n默认验证首次站内owner。先在网站完成自己的OpenAI订阅绑定，再停止本机4317服务。--resume必须在新的CLI进程运行。不会创建或删除网站材料，不需要密码或Cookie。",
    );
  } else {
    try {
      await main();
    } catch (error) {
      console.error(safeMessage(error));
      process.exitCode = error instanceof PreflightError ? 2 : 1;
    }
  }
}
