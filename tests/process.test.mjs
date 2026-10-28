import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = fileURLToPath(new URL("../", import.meta.url));

async function availablePort() {
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

function startProcess(dataDir, port, children) {
  const child = spawn(process.execPath, ["server/index.mjs"], {
    cwd: rootDir,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = {
    child,
    exited: new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
      child.once("error", (error) => resolve({ error: error.message }));
    }),
  };
  children.add(record);
  const ready = new Promise((resolve, reject) => {
    let output = "";
    const finish = (error) => {
      clearTimeout(timer);
      child.stdout.off("data", onOutput);
      child.stderr.off("data", onErrorOutput);
      child.off("exit", onExit);
      child.off("error", onError);
      if (error) reject(error);
      else resolve(record);
    };
    const onOutput = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
      if (output.includes("余白已启动：")) finish();
    };
    const onErrorOutput = (chunk) => {
      output = (output + chunk.toString()).slice(-8000);
    };
    const onExit = (code, signal) =>
      finish(new Error(`服务启动前退出：${code ?? signal}\n${output}`));
    const onError = (error) => finish(error);
    const timer = setTimeout(
      () => finish(new Error(`服务启动超时。\n${output}`)),
      5000,
    );
    child.stdout.on("data", onOutput);
    child.stderr.on("data", onErrorOutput);
    child.once("exit", onExit);
    child.once("error", onError);
  });
  return ready;
}

async function waitForExit(record) {
  let timer;
  try {
    return await Promise.race([
      record.exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("服务未按时退出。")), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test(
  "整个 Node 服务进程停止并重启后，真实文件数据库仍保留正文与注音",
  { timeout: 20_000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "yohaku-process-"));
    const children = new Set();
    t.after(async () => {
      for (const record of children) {
        if (record.child.exitCode === null && record.child.signalCode === null)
          record.child.kill("SIGKILL");
        await waitForExit(record);
      }
      await rm(dataDir, { recursive: true, force: true });
    });
    const port = await availablePort();
    const url = `http://127.0.0.1:${port}`;
    const first = await startProcess(dataDir, port, children);
    const input = {
      title: "进程重启持久性检查",
      kind: "lyrics",
      orientation: "horizontal",
      content: "{僕|ぼく}が{生|う}まれた{日|ひ}\n\n{背中|せなか}を撫でる\n",
    };
    const response = await fetch(`${url}/api/documents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(response.status, 201);
    const saved = await response.json();
    assert.equal(saved.content, input.content);
    assert.equal(saved.revision, 1);
    assert.equal(saved.blocks.length, 4);
    assert.equal(saved.blocks[1].segments.length, 0);
    assert.equal(saved.blocks[3].segments.length, 0);
    assert.equal(
      saved.blocks[0].segments.find((segment) => segment.text === "生").reading,
      "う",
    );

    first.child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(first), { code: 0, signal: null });
    children.delete(first);

    const second = await startProcess(dataDir, port, children);
    const reopened = await fetch(`${url}/api/documents/${saved.id}`, {
      signal: AbortSignal.timeout(4000),
    });
    assert.equal(reopened.status, 200);
    assert.deepEqual(await reopened.json(), saved);
    const list = await fetch(`${url}/api/documents`, {
      signal: AbortSignal.timeout(4000),
    }).then((result) => result.json());
    assert.equal(list.documents.length, 1);
    assert.equal(list.documents[0].rubyCount, 4);

    second.child.kill("SIGTERM");
    assert.deepEqual(await waitForExit(second), { code: 0, signal: null });
    children.delete(second);
  },
);
