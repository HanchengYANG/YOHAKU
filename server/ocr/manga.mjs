import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const python = fileURLToPath(new URL("../../.venv-mangaocr/bin/python", import.meta.url));
const worker = fileURLToPath(new URL("./manga-worker.py", import.meta.url));
const failure = (message, status = 502) => Object.assign(new Error(message), { status, expose: true });

export function createMangaOcr({
  pythonPath = process.env.MANGA_OCR_PYTHON || python,
  workerPath = worker,
  timeoutMs = 180000,
  label = "MangaOCR",
} = {}) {
  let child = null, pending = null, sequence = 0, closed = false;

  function stop(process, error) {
    if (child !== process) return;
    child = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
    process.kill("SIGTERM");
  }

  function start() {
    const process = spawn(pythonPath, ["-u", workerPath], { stdio: ["pipe", "pipe", "pipe"] });
    child = process;
    let buffer = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      if (child !== process) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 4 * 1024 * 1024) {
        stop(process, failure(`${label} 返回内容过大，识别已停止。`));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let reply;
        try { reply = JSON.parse(line); } catch {
          stop(process, failure(`${label} 返回了无效结果，请检查服务日志。`));
          return;
        }
        if (!pending || reply?.id !== pending.id) {
          stop(process, failure(`${label} 请求与返回结果不匹配。`));
          return;
        }
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (reply.error) request.reject(failure(reply.error.message || `${label} 本地识别失败。`));
        else if (!Array.isArray(reply.result?.regions) || !reply.result.regions.length)
          request.reject(failure(`${label} 没有返回文字区域。`));
        else request.resolve(reply.result);
      }
    });
    // Consume stderr without retaining it in memory; model diagnostics stay in server logs.
    process.stderr.on("data", (chunk) => globalThis.process.stderr.write(chunk));
    process.stdin.on("error", () => stop(process, failure(`${label} 进程无法接收图片，请重试。`)));
    process.on("error", () => stop(process, failure(`${label} Python 环境不可用，请先完成本机安装。`, 503)));
    process.on("exit", () => stop(process, failure(`${label} 进程已退出，未返回完整识别结果。`)));
    return process;
  }

  return {
    recognize(path) {
      if (closed) return Promise.reject(failure(`${label} 服务已关闭。`, 503));
      if (pending) return Promise.reject(failure(`${label} 正在处理另一张图片，请稍后重试。`, 409));
      if (typeof path !== "string" || !path) return Promise.reject(failure("需要有效的本地图片。", 400));
      const process = child || start();
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => stop(process, failure(`${label} 本地识别超时，请重试。`, 504)), timeoutMs);
        pending = { id, resolve, reject, timer };
        process.stdin.write(`${JSON.stringify({ id, path })}\n`);
      });
    },
    status: () => ({ running: !!child, busy: !!pending }),
    close() {
      closed = true;
      if (child) stop(child, failure(`${label} 服务已关闭。`, 503));
    },
  };
}
