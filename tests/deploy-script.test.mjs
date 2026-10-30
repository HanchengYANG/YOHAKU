import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, copyFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

// Execute the real deploy script in an isolated folder. External commands only
// record their calls; filesystem work (including the backup) stays in this folder.
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-deploy-script-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const project = join(directory, "project"), bin = join(directory, "bin"), home = join(directory, "home");
  for (const path of [project, bin, home, join(project, "data"), join(project, "tests")]) await mkdir(path, { recursive: true });
  await writeFile(join(project, "data", "preserved"), "backup fixture");
  await writeFile(join(project, "tests", "sentinel.test.mjs"), "");
  await writeFile(join(bin, "node"), "#!/bin/sh\nexit 1\n", { mode: 0o700 });
  const script = join(directory, "pi-deploy.sh"), log = join(directory, "calls.log"), environment = join(directory, "environment.sh");
  await copyFile(new URL("../scripts/pi-deploy.sh", import.meta.url), script);
  await writeFile(join(directory, "pi-config.sh"), `load_deploy_config() {
    APP_USER=deploy_test
    APP_DIR="$DEPLOY_FIXTURE/project"
    APP_HOME="$DEPLOY_FIXTURE/home"
    DATA_DIR="$APP_DIR/data"
    NODE_BIN="$DEPLOY_FIXTURE/bin"
    DEPLOY_CONFIG=\${1:-$DEPLOY_FIXTURE/default.env}
    GIT_BRANCH=main GIT_REMOTE=origin DEPLOY_KEY= TLS_CA_CERT=
    PUBLIC_ORIGIN=https://reader.example
    DEPLOY_TEST_HTTP_TIMEOUT_MS=45000
    printf 'config:%s\\n' "$DEPLOY_CONFIG" >> "$DEPLOY_CALL_LOG"
  }
  deploy_error() { echo "$*" >&2; exit 1; }
`);
  await writeFile(environment, `id() { case "$1" in -u) echo 1000 ;; -un) echo deploy_test ;; esac; }
    git() { case "$1" in status) ;; branch) echo main ;; pull) printf 'git:%s\\n' "$*" >> "$DEPLOY_CALL_LOG" ;; rev-parse) echo fixture-commit ;; *) return 1 ;; esac; }
    sudo() { printf 'sudo:%s\\n' "$*" >> "$DEPLOY_CALL_LOG"; }
    npm() { printf 'npm:%s\\n' "$*" >> "$DEPLOY_CALL_LOG"; }
    node() { printf 'node:%s:%s\\n' "\${YOHAKU_TEST_HTTP_TIMEOUT_MS:-unset}" "$*" >> "$DEPLOY_CALL_LOG"; }
    curl() { printf 'curl:%s\\n' "$*" >> "$DEPLOY_CALL_LOG"; }
`);
  async function run(args) {
    await writeFile(log, "");
    const result = spawnSync("bash", [script, ...args], { env: { ...process.env, BASH_ENV: environment, DEPLOY_FIXTURE: directory, DEPLOY_CALL_LOG: log }, encoding: "utf8" });
    return { ...result, calls: (await readFile(log, "utf8")).trim().split("\n").filter(Boolean) };
  }
  return { directory, project, home, run };
}

for (const mode of ["default", "config", "test", "test-before-config", "test-after-config"]) {
  test(`部署参数 ${mode} 仅显式--test时运行完整测试，保留备份构建与健康检查`, async (t) => {
    const f = await fixture(t), config = join(f.directory, "private.env");
    const args = mode === "default" ? [] : mode === "config" ? [config] : mode === "test" ? ["--test"] : mode === "test-before-config" ? ["--test", config] : [config, "--test"];
    const result = await f.run(args);
    assert.equal(result.status, 0, result.stderr);
    const expectedConfig = args.includes(config) ? config : join(f.directory, "default.env");
    assert.deepEqual(result.calls.filter((line) => line.startsWith("config:")), [`config:${expectedConfig}`, `config:${expectedConfig}`]);
    const tests = result.calls.filter((line) => line.startsWith("node:"));
    assert.deepEqual(tests, mode.includes("test") ? ["node:45000:--test --test-concurrency=1 tests/sentinel.test.mjs"] : []);
    assert.ok(result.calls.includes("npm:ci"));
    assert.ok(result.calls.includes("npm:run build"));
    if (tests.length) assert.ok(result.calls.indexOf(tests[0]) > result.calls.indexOf("npm:ci") && result.calls.indexOf(tests[0]) < result.calls.indexOf("npm:run build"));
    assert.ok(result.calls.includes("sudo:systemctl stop yohaku.service"));
    assert.ok(result.calls.some((line) => line.includes("pi-certificates.sh")));
    assert.ok(result.calls.some((line) => line.includes("pi-setup-system.sh")));
    assert.ok(result.calls.some((line) => line.startsWith("curl:") && line.includes("https://reader.example/api/health")));
    const backups = join(f.home, ".local/state/yohaku/backups");
    const entries = await readdir(backups);
    assert.equal(entries.length, 1);
    assert.equal(await readFile(join(backups, entries[0], "data/preserved"), "utf8"), "backup fixture");
  });
}

test("部署拒绝未知选项和多余实例参数，显示用法且不启动部署", async (t) => {
  const f = await fixture(t);
  for (const args of [["--unknown"], ["--test=true"], ["-t"], ["first.env", "second.env"], ["--test", "first.env", "second.env"], ["first.env", "--unknown"], ["", "second.env"]]) {
    const result = await f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage: bash scripts\/pi-deploy\.sh \[--test\] \[CONFIG_FILE\]/);
    assert.deepEqual(result.calls, [], JSON.stringify(args));
  }
});
