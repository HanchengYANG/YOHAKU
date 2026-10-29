import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
async function fixture(t, extra = "") {
  const dir = await mkdtemp(join(tmpdir(), "yohaku-deploy-config-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, ".nvmrc"), "24.14.0\n");
  const config = join(dir, "instance.env");
  await writeFile(config, `APP_USER=${userInfo().username}\nAPP_DIR=${project}\nPUBLIC_ORIGIN=https://reader.example\n${extra}`, { mode: 0o600 });
  t.after(() => rm(dir, { recursive: true, force: true }));
  return { config, project };
}
function run(config, script) {
  return execFileSync("bash", ["-euc", 'source "$1/scripts/pi-config.sh"; load_deploy_config "$2"; ' + script, "bash", root, config], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

test("部署模板使用实例中的路径、端口与来源，运行环境不包含 SSH 设置", async (t) => {
  const { config, project } = await fixture(t, "PORT=5321\nHTTPS_PORT=9443\nPUBLIC_ORIGINS=https://outside.example:8443\nGIT_BRANCH=release\nDEPLOY_KEY=/private/example-key\n");
  const nginx = run(config, 'render_deploy_template "$1/deploy/nginx.conf"');
  assert.match(nginx, /listen 9443 ssl/);
  assert.match(nginx, /server_name reader\.example outside\.example;/);
  assert.match(nginx, /127\.0\.0\.1:5321/);
  assert.match(nginx, /Host \$http_host/);
  assert.match(nginx, /location = \/yohaku\.crt/);
  assert.match(nginx, /alias \/var\/lib\/yohaku\/certificates\/yohaku\.crt;/);
  assert.match(nginx, /default_type application\/x-x509-ca-cert;/);
  assert.match(nginx, /add_header Content-Disposition \$yohaku_certificate_disposition;/);
  assert.match(nginx, /limit_except GET \{ deny all; \}/);
  const service = run(config, 'render_deploy_template "$1/deploy/yohaku.service"');
  assert.ok(service.includes(`WorkingDirectory=${project}`));
  assert.match(service, /EnvironmentFile=\/etc\/yohaku\/runtime.env/);
  const runtime = run(config, 'render_deploy_template "$1/deploy/runtime.env"');
  assert.ok(runtime.includes(`DATA_DIR="${project}/data"`));
  assert.match(runtime, /PORT="5321"/);
  assert.match(runtime, /PUBLIC_ORIGINS="https:\/\/outside.example:8443"/);
  assert.doesNotMatch(nginx + service + runtime, /@[A-Z_]+@/);
  assert.doesNotMatch(runtime, /DEPLOY_KEY|GIT_BRANCH|example-key/);
  assert.equal(run(config, 'printf "%s" "$CERT_SAN"'), "DNS:reader.example,DNS:outside.example");
  assert.equal(run(config, 'printf "%s" "$TLS_CA_CERT"'), "/etc/nginx/yohaku/tls.crt");
});

test("部署配置在系统变更前拒绝不安全路径、无效端口和来源", async (t) => {
  for (const extra of ["PORT=0", "PORT=65536", "PORT=443\nHTTPS_PORT=443", "PUBLIC_ORIGINS=https://outside.example/path", "TLS_KEY='/tmp/key with spaces'", "TLS_CA_CERT='/tmp/root with spaces'", "TLS_MODE=local-ca", "TLS_MODE=auto", "TLS_CERT_DAYS=0", "TLS_CERT=/same\nTLS_KEY=/same", "PUBLIC_ORIGIN=http://reader.example"]) {
    const { config } = await fixture(t, extra + "\n");
    assert.throws(() => run(config, ":"), /Deployment configuration/);
  }
  assert.throws(() => run(join(root, "deploy/config.env.example"), ":"), /private untracked instance/);
});

test("私有实例和默认选择器被忽略，通用示例与渲染模板可提交", () => {
  for (const file of ["deploy/instances/example.env", ".env.deploy"]) {
    execFileSync("git", ["check-ignore", "--quiet", file], { cwd: root });
  }
  for (const file of ["deploy/config.env.example", "deploy/runtime.env"]) {
    const result = spawnSync("git", ["check-ignore", "--no-index", file], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
  }
});
