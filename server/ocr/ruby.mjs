import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalWorkerPool } from './worker-pool.mjs';

const python = fileURLToPath(new URL("../../.venv-documents/bin/python", import.meta.url));
const worker = fileURLToPath(new URL("./ruby-worker.py", import.meta.url));
const failure = (message, status = 502) => Object.assign(new Error(message), { status, expose: true });
const installation = "请运行 bash scripts/install-document-runtime.sh 安装本地注音依赖，或配置 LOCAL_RUBY_PYTHON。";
const han = /^[\p{Script=Han}々〆〇]+$/u;
const kana = /^[ぁ-ゖー]+$/u;

function validResult(result, text) {
  if (!Array.isArray(result?.annotations) || typeof result.engine !== "string") return false;
  let previousEnd = 0;
  return result.annotations.every((annotation) => {
    if (!Number.isInteger(annotation?.start) || !Number.isInteger(annotation.end)
      || annotation.start < previousEnd || annotation.end <= annotation.start || annotation.end > text.length
      || typeof annotation.surface !== "string" || text.slice(annotation.start, annotation.end) !== annotation.surface
      || !han.test(annotation.surface) || typeof annotation.reading !== "string" || !kana.test(annotation.reading)) return false;
    previousEnd = annotation.end;
    return true;
  });
}

/** Local-only ruby annotations use exact input surfaces and JavaScript UTF-16 offsets. */
export function createLocalRuby(options={}) {
  return createLocalWorkerPool({create:()=>createLocalRubyWorker(options),method:'annotate',
    workers:options.workers??process.env.LOCAL_RUBY_WORKERS??1,label:'本地注音'});
}

function createLocalRubyWorker({
  pythonPath = process.env.LOCAL_RUBY_PYTHON || python,
  workerPath = worker,
  timeoutMs = 120000,
} = {}) {
  let child = null, pending = null, sequence = 0, closed = false;
  const queue = [];

  function terminate(process) {
    if (process.exitCode !== null || process.signalCode !== null) return;
    process.kill("SIGTERM");
    const timer = setTimeout(() => {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGKILL");
    }, 1000);
    timer.unref();
    process.once("exit", () => clearTimeout(timer));
  }

  function stop(process, error) {
    if (child !== process) return;
    child = null;
    if (pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      pending = null;
    }
    terminate(process);
    queueMicrotask(pump);
  }

  function start() {
    const process = spawn(pythonPath, ["-u", workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...globalThis.process.env, PYTHONNOUSERSITE: "1", HF_HUB_OFFLINE: "1", TRANSFORMERS_OFFLINE: "1" },
    });
    child = process;
    let buffer = "";
    process.stdout.setEncoding("utf8");
    process.stdout.on("data", (chunk) => {
      if (child !== process) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
        stop(process, failure("本地注音返回内容过大，请分段重试。"));
        return;
      }
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        if (!line.trim()) continue;
        let reply;
        try { reply = JSON.parse(line); } catch {
          stop(process, failure("本地注音返回了无效结果，请重试。"));
          return;
        }
        if (!pending || reply?.id !== pending.id) {
          stop(process, failure("本地注音请求与返回结果不匹配，请重试。"));
          return;
        }
        if (!reply.error && !validResult(reply.result, pending.text)) {
          stop(process, failure("本地注音返回了无效的原文偏移或读音，请重试。"));
          return;
        }
        const error = reply.error ? failure(reply.error.message || "本地注音失败，请重试。",
          [400, 503].includes(reply.error.status) ? reply.error.status : 502) : null;
        if (error?.status === 503) {
          // A repaired/replaced venv needs a fresh interpreter and import paths.
          stop(process, error);
          return;
        }
        const request = pending;
        pending = null;
        clearTimeout(request.timer);
        if (error) request.reject(error);
        else request.resolve(reply.result);
        queueMicrotask(pump);
      }
    });
    process.stderr.on("data", (chunk) => globalThis.process.stderr.write(chunk));
    process.stdin.on("error", () => stop(process, failure("本地注音进程无法接收文字，请重试。")));
    process.on("error", () => stop(process, failure(`本地注音 Python 环境不可用。${installation}`, 503)));
    process.on("exit", () => stop(process, failure("本地注音进程已退出，未返回完整结果，请重试。")));
    return process;
  }

  function pump() {
    if (closed || pending || !queue.length) return;
    const request = queue.shift();
    pending = request;
    let process;
    try { process = child || start(); } catch {
      pending = null;
      request.reject(failure(`本地注音 Python 环境不可用。${installation}`, 503));
      queueMicrotask(pump);
      return;
    }
    request.id = ++sequence;
    request.timer = setTimeout(() => stop(process, failure("本地注音超时，请分段重试。", 504)), timeoutMs);
    process.stdin.write(`${JSON.stringify({ id: request.id, text: request.text })}\n`);
  }

  return {
    annotate(text) {
      if (closed) return Promise.reject(failure("本地注音服务已关闭。", 503));
      if (typeof text !== "string" || text.length > 200000)
        return Promise.reject(failure("本地注音需要不超过200000字的原文字符串。", 400));
      return new Promise((resolve, reject) => {
        queue.push({ text, resolve, reject });
        pump();
      });
    },
    close() {
      closed = true;
      const error = failure("本地注音服务已关闭。", 503);
      for (const request of queue.splice(0)) request.reject(error);
      if (child) stop(child, error);
    },
  };
}
