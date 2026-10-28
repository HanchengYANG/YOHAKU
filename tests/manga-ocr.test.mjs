import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createMangaOcr } from "../server/ocr/manga.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-manga-worker-"));
  const executable = join(directory, "worker.mjs");
  // A Node executable mimics Python's JSONL protocol without optional OCR dependencies.
  await writeFile(executable, `#!${process.execPath}
import { createInterface } from "node:readline";
let calls = 0;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, path } = JSON.parse(line);
  calls++;
  if (path === "hang") continue;
  if (path === "exit") process.exit(1);
  if (path === "malformed") { console.log("model diagnostic on wrong stream"); continue; }
  if (path === "null") { console.log("null"); continue; }
  if (path === "large") { console.log("x".repeat(4 * 1024 * 1024 + 1)); continue; }
  if (path === "error") { console.log(JSON.stringify({ id, error: { message: "测试识别失败" } })); continue; }
  console.log(JSON.stringify({ id, result: { calls, regions: [{ text: "日本語", sourcePage: "unknown" }] } }));
}
`, { mode: 0o700 });
  const service = createMangaOcr({ pythonPath: executable, workerPath: "ignored", timeoutMs: 5000, ...options });
  t.after(async () => { service.close(); await rm(directory, { recursive: true, force: true }); });
  return service;
}

test("MangaOCR bridge reuses one worker and returns complete JSONL results", async (t) => {
  const service = await fixture(t);
  assert.deepEqual(service.status(), { running: false, busy: false });
  assert.equal((await service.recognize("first")).calls, 1);
  assert.equal((await service.recognize("second")).calls, 2);
  assert.deepEqual(service.status(), { running: true, busy: false });
});

test("MangaOCR bridge rejects concurrent work and closes pending request", async (t) => {
  const service = await fixture(t);
  const pending = assert.rejects(service.recognize("hang"), /服务已关闭/);
  await assert.rejects(service.recognize("second"), { status: 409 });
  service.close();
  await pending;
  await assert.rejects(service.recognize("third"), { status: 503 });
});

test("MangaOCR request error does not corrupt the next request", async (t) => {
  const service = await fixture(t);
  await assert.rejects(service.recognize("error"), /测试识别失败/);
  assert.equal((await service.recognize("next")).calls, 2);
});

for (const [path, message] of [
  ["exit", /进程已退出/],
  ["malformed", /无效结果/],
  ["null", /不匹配/],
  ["large", /返回内容过大/],
]) {
  test(`MangaOCR bridge rejects ${path} and can restart`, async (t) => {
    const service = await fixture(t);
    await assert.rejects(service.recognize(path), message);
    assert.equal((await service.recognize("next")).calls, 1);
  });
}

test("MangaOCR timeout stops the worker and clears busy state", async (t) => {
  const service = await fixture(t, { timeoutMs: 25 });
  await assert.rejects(service.recognize("hang"), { status: 504 });
  assert.deepEqual(service.status(), { running: false, busy: false });
});

test("MangaOCR missing interpreter returns a configuration error without its path", async (t) => {
  const service = await fixture(t, { pythonPath: "/missing/private-path/python" });
  await assert.rejects(service.recognize("image"), (error) =>
    error.status === 503 && /Python 环境不可用/.test(error.message) && !error.message.includes("private-path"));
});
