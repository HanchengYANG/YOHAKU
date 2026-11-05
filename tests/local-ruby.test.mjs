import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod, rm, access } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalRuby } from "../server/ocr/ruby.mjs";

const workerPath = fileURLToPath(new URL("../server/ocr/ruby-worker.py", import.meta.url));

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-ruby-"));
  const pythonPath = join(directory, "fake-python");
  const marker = join(directory, "crashed");
  await writeFile(pythonPath, `#!${process.execPath}
const readline = require('node:readline');
const fs = require('node:fs');
process.on('SIGTERM', () => {});
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const { id, text } = JSON.parse(line);
  if (text === 'crash' && !fs.existsSync(${JSON.stringify(marker)})) {
    fs.writeFileSync(${JSON.stringify(marker)}, '1');
    process.exit(17);
  }
  if (text === 'hang') return;
  if (text === 'malformed') return console.log('{broken');
  if (text === 'dependency-error') return console.log(JSON.stringify({ id, error: { message: 'install-document-runtime.sh', status: 503 } }));
  const annotations = text === 'bad-surface' ? [{ start: 0, end: 1, surface: '字', reading: 'じ' }]
    : text === '𠮷bad-offset' ? [{ start: 0, end: 1, surface: '𠮷', reading: 'よし' }]
    : text === '𠮷野' ? [{ start: 0, end: 3, surface: '𠮷野', reading: 'よしの' }]
    : [];
  console.log(JSON.stringify({ id, result: { annotations, engine: 'fixture:' + process.pid, elapsedMs: 0 } }));
});
`);
  await chmod(pythonPath, 0o700);
  const ruby = createLocalRuby({ pythonPath, workerPath: "unused", timeoutMs: 5000, ...options });
  t.after(async () => { ruby.close(); await rm(directory, { recursive: true, force: true }); });
  return ruby;
}

test("本地注音复用进程，串行处理并发请求且返回UTF-16偏移", async (t) => {
  const ruby = await fixture(t);
  const [first, second, empty] = await Promise.all([ruby.annotate("𠮷野"), ruby.annotate("かな"), ruby.annotate("")]);
  assert.deepEqual(first.annotations, [{ start: 0, end: 3, surface: "𠮷野", reading: "よしの" }]);
  assert.deepEqual(second.annotations, []);
  assert.deepEqual(empty.annotations, []);
  assert.equal(first.engine, second.engine);
  assert.equal(second.engine, empty.engine);
});

test("本地注音拒绝非字符串和超限输入，尚未创建worker也能关闭", async () => {
  const ruby = createLocalRuby({ pythonPath: "/does-not-exist" });
  for (const text of [null, {}, 1, "字".repeat(200001)]) {
    await assert.rejects(ruby.annotate(text), { status: 400 });
  }
  ruby.close();
  ruby.close();
  await assert.rejects(ruby.annotate("東京"), { status: 503 });
});

test("worker异常退出后当前请求失败，后续请求可重启成功", async (t) => {
  const ruby = await fixture(t);
  await assert.rejects(ruby.annotate("crash"), /进程已退出/);
  const result = await ruby.annotate("crash");
  assert.deepEqual(result.annotations, []);
});

test("worker坏JSON与不匹配原文的annotation不会进入正文，之后可重试", async (t) => {
  const ruby = await fixture(t);
  await assert.rejects(ruby.annotate("malformed"), /无效/);
  await assert.rejects(ruby.annotate("bad-surface"), /无效/);
  await assert.rejects(ruby.annotate("𠮷bad-offset"), /无效/);
  assert.equal((await ruby.annotate("𠮷野")).annotations[0].end, 3);
});

test("本地注音超时后可以重试，close拒绝当前及排队请求并终止顽固worker", async (t) => {
  const ruby = await fixture(t, { timeoutMs: 2000 });
  await assert.rejects(ruby.annotate("hang"), { status: 504 });
  const result = await ruby.annotate("かな");
  const pid = Number(result.engine.split(":")[1]);
  const active = assert.rejects(ruby.annotate("hang"), /服务已关闭/);
  const queued = assert.rejects(ruby.annotate("かな"), /服务已关闭/);
  ruby.close();
  await Promise.all([active, queued]);
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); } catch (error) {
      assert.equal(error.code, "ESRCH");
      return;
    }
    await delay(25);
  }
  assert.fail("close left the local ruby worker alive");
});

test("缺失Python环境或worker依赖给出可操作安装错误", async (t) => {
  const missing = createLocalRuby({ pythonPath: "/does-not-exist" });
  t.after(() => missing.close());
  await assert.rejects(missing.annotate("東京"), (error) => error.status === 503 && /install-document-runtime.sh/.test(error.message));
  const ruby = await fixture(t);
  const before = await ruby.annotate("かな");
  await assert.rejects(ruby.annotate("dependency-error"), { status: 503 });
  const after = await ruby.annotate("かな");
  assert.deepEqual(after.annotations, []);
  assert.notEqual(after.engine, before.engine, "dependency retry must start a new interpreter after runtime installation");
});

test("worker仅唯一对齐Han读音，保留送假名、扩展汉字与原始空白坐标", () => {
  execFileSync("python3", ["-c", `
import importlib.util, sys
spec = importlib.util.spec_from_file_location("ruby_worker_test", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
assert worker.align_reading("食べる", "たべる") == [{"start": 0, "end": 1, "surface": "食", "reading": "た"}]
assert worker.align_reading("取り戻す", "とりもどす") == [
    {"start": 0, "end": 1, "surface": "取", "reading": "と"},
    {"start": 2, "end": 3, "surface": "戻", "reading": "もど"}]
assert worker.align_reading("実は", "じつわ") == []
assert worker.align_reading("漢あ字", "かんああじ") == []
text = " 😀𠮷野で食べる\\r\\n"
nodes = [{"char_span": [2, 4], "pron": "ヨシノ"}, {"char_span": [5, 8], "pron": "タベル"}]
assert worker.annotations_for_nodes(text, nodes) == [
    {"start": 3, "end": 6, "surface": "𠮷野", "reading": "よしの"},
    {"start": 7, "end": 8, "surface": "食", "reading": "た"}]
assert worker.annotations_for_nodes("日本語", [
    {"char_span": [0, 2], "pron": "ニホン"}, {"char_span": [2, 3], "pron": "ゴ"}]) == [
    {"start": 0, "end": 3, "surface": "日本語", "reading": "にほんご"}]
assert worker.annotations_for_nodes("日本語", [{"char_span": [0, 2], "pron": "ニホン"}]) == []
assert worker.annotations_for_nodes("東京", [{"char_span": [0, 2], "pron": "東京"}]) == []
assert worker.annotations_for_nodes("二〇二四年。食べる。", [
    {"char_span": [0, 1], "pron": "ニ"}, {"char_span": [1, 2], "pron": "セン"},
    {"char_span": [2, 3], "pron": "ニ"}, {"char_span": [0, 0], "pron": "ジュウ"},
    {"char_span": [3, 4], "pron": "ヨ"}, {"char_span": [4, 5], "pron": "ネン"},
    {"char_span": [5, 6], "pron": "、"}, {"char_span": [6, 9], "pron": "タベル"}]) == [
    {"start": 6, "end": 7, "surface": "食", "reading": "た"}]
tokyo = {"char_span": [0, 2], "pron": "トウキョウ"}
for sound in ("", "、"):
    unanchored = {"char_span": [0, 0], "pron": sound}
    expected = [{"start": 0, "end": 2, "surface": "東京", "reading": "とうきょう"}]
    assert worker.annotations_for_nodes("東京", [unanchored, tokyo]) == expected
    assert worker.annotations_for_nodes("東京", [tokyo, unanchored]) == expected
unanchored = {"char_span": [0, 0], "pron": "ジュウ"}
assert worker.annotations_for_nodes("東京", [unanchored, tokyo]) == []
assert worker.annotations_for_nodes("東京", [tokyo, unanchored]) == []
for connect in (worker.socket.socket.connect, worker.socket.socket.connect_ex, worker.socket.create_connection):
    try: connect(None, ("127.0.0.1", 1))
    except RuntimeError as error: assert "Network blocked" in str(error)
    else: raise AssertionError("worker must deny network connections")
`, workerPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
});

test("真实worker逐请求返回依赖错误，坏请求和引擎异常不会中断下一行", () => {
  execFileSync("python3", ["-S", "-c", `
import importlib.util, io, json, sys
spec = importlib.util.spec_from_file_location("ruby_worker_test", sys.argv[1])
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)
try:
    worker.annotate("東京")
except worker.RuntimeUnavailable as error:
    assert "install-document-runtime.sh" in str(error)
else:
    raise AssertionError("a Python without site-packages must report missing dependencies")
class Engine:
    def g2p_mapping(self, text, **options):
        assert options == {**worker.OPTIONS, "predict_nani": True}
        if text == "error": raise RuntimeError("recoverable inference failure")
        return [{"char_span": [0, 2], "pron": "トウキョウ"}]
worker.get_engine = lambda: Engine()
worker._versions = worker.VERSIONS
sys.stdin = io.StringIO('not JSON\\n' + '\\n'.join(json.dumps(value) for value in [
    {"id": 1, "text": None}, {"id": 2, "text": "error"}, {"id": 3, "text": "東京"}]) + '\\n')
output = io.StringIO()
with worker.redirect_stdout(output): worker.main()
replies = [json.loads(line) for line in output.getvalue().splitlines()]
assert [reply["error"]["status"] for reply in replies[:3]] == [400, 400, 502]
assert replies[3]["id"] == 3
assert replies[3]["result"]["annotations"] == [{"start": 0, "end": 2, "surface": "東京", "reading": "とうきょう"}]
`, workerPath], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
});

const runtimePython = process.env.LOCAL_RUBY_TEST_PYTHON || fileURLToPath(new URL("../.venv-documents/bin/python", import.meta.url));
const hasRuntime = await access(runtimePython).then(() => true, () => false);
test("真实CPU本地注音使用固定rules/dictionary/nani，保留原文及扩展汉字UTF-16坐标", { skip: !hasRuntime && "run scripts/install-document-runtime.sh to install local ruby runtime" }, async (t) => {
  const ruby = createLocalRuby({ pythonPath: runtimePython, timeoutMs: 60000 });
  t.after(() => ruby.close());
  const text = " 😀𠮷野で食べる。何を食べる？\r\n実はそうです。 ";
  const result = await ruby.annotate(text);
  assert.equal(result.engine, "pyopenjtalk-plus");
  assert.equal(result.versions["pyopenjtalk-plus"], "0.4.1.post10");
  assert.equal(result.versions.SudachiPy, "0.6.11");
  assert.equal(result.versions["SudachiDict-core"], "20260723");
  assert.deepEqual(result.annotations.find((annotation) => annotation.surface === "𠮷野"), { start: 3, end: 6, surface: "𠮷野", reading: "よしの" });
  assert.deepEqual(result.annotations.filter((annotation) => annotation.surface === "食").map((annotation) => annotation.reading), ["た", "た"]);
  assert.equal(result.annotations.find((annotation) => annotation.surface === "何")?.reading, "なに");
  for (const annotation of result.annotations) assert.equal(text.slice(annotation.start, annotation.end), annotation.surface);
  assert.deepEqual((await ruby.annotate("")).annotations, []);
  assert.deepEqual((await ruby.annotate("かな カナ\r\n")).annotations, []);
  assert.deepEqual((await ruby.annotate("二〇二四年。食べる。東京。2011年。"))
    .annotations.map(({ surface, reading }) => ({ surface, reading })), [
    { surface: "食", reading: "た" }, { surface: "東京", reading: "とうきょう" },
    { surface: "年", reading: "ねん" },
  ]);
  assert.deepEqual((await ruby.annotate("西暦2024年。東京。"))
    .annotations.map(({ surface, reading }) => ({ surface, reading })), [
    { surface: "西暦", reading: "せいれき" }, { surface: "年", reading: "ねん" },
    { surface: "東京", reading: "とうきょう" },
  ]);
});
