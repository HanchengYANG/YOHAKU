import test from "node:test";
import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm, readdir, stat } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
async function fixture(t, mode = "local-ca") {
  const dir = await mkdtemp(join(tmpdir(), "yohaku-certificates-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, ".nvmrc"), "24.14.0\n");
  const paths = {
    dir, config: join(dir, "instance.env"), certificate: join(dir, "server.crt"),
    key: join(dir, "server.key"), ca: join(dir, "ca.crt"), caKey: join(dir, "ca.key"),
    download: join(dir, "public/yohaku.crt"),
  };
  const base = `APP_USER=${userInfo().username}\nAPP_DIR=${project}\nPUBLIC_ORIGIN=https://reader.example:9443\nPUBLIC_ORIGINS=https://192.0.2.44\nTLS_CERT=${paths.certificate}\nTLS_KEY=${paths.key}\n`;
  const settings = `TLS_MODE=${mode}\n${mode === "local-ca" ? `TLS_CA_CERT=${paths.ca}\nTLS_CA_KEY=${paths.caKey}\n` : ""}`;
  await writeFile(paths.config, base + settings, { mode: 0o600 });
  return { ...paths, base, settings };
}
function configure(f, renew = false) {
  return execFileSync("bash", ["-euc", `
    source "$1/scripts/pi-config.sh"
    load_deploy_config "$2"
    source "$1/scripts/pi-certificates.sh"
    configure_certificates "$4"
    export_public_certificate "$3"
  `, "bash", root, f.config, f.download, String(renew)], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000,
  });
}
async function certificate(path) {
  return new X509Certificate(await readFile(path));
}

test("配置驱动的 CA 签发覆盖指定域名和 IP，下载仅含根证书，显式续期保留信任", async (t) => {
  const f = await fixture(t);
  configure(f);
  const ca = await certificate(f.ca);
  const server = await certificate(f.certificate);
  assert.equal(ca.ca, true);
  assert.equal(server.ca, false);
  assert.equal(server.verify(ca.publicKey), true);
  assert.equal(server.checkHost("reader.example"), "reader.example");
  assert.equal(server.checkIP("192.0.2.44"), "192.0.2.44");
  assert.equal(server.checkHost("localhost"), undefined);
  assert.equal(server.checkIP("127.0.0.1"), undefined);
  assert.deepEqual(await readFile(f.download), ca.raw);
  assert.equal((await stat(f.key)).mode & 0o777, 0o600);
  assert.equal((await stat(f.caKey)).mode & 0o777, 0o600);
  assert.equal((await stat(f.download)).mode & 0o777, 0o644);
  configure(f);
  assert.equal((await certificate(f.certificate)).fingerprint256, server.fingerprint256);
  await writeFile(f.config, f.base + f.settings + "PUBLIC_ORIGINS=https://192.0.2.44,https://new.example:8443\n");
  assert.throws(() => configure(f), /does not cover the configured origins/);
  assert.equal((await certificate(f.certificate)).fingerprint256, server.fingerprint256);
  configure(f, true);
  const renewed = await certificate(f.certificate);
  assert.notEqual(renewed.fingerprint256, server.fingerprint256);
  assert.equal(renewed.checkHost("new.example"), "new.example");
  assert.equal((await certificate(f.ca)).fingerprint256, ca.fingerprint256);
  assert.deepEqual(await readFile(f.download), ca.raw);
  const backup = (await readdir(f.dir)).find((name) => name.startsWith("backup."));
  assert.equal((await certificate(join(f.dir, backup, "server.crt"))).fingerprint256, server.fingerprint256);
});

test("旧实例的单张自签证书可复用并导出，缺少配对私钥时拒绝重建", async (t) => {
  const f = await fixture(t, "self-signed");
  configure(f);
  const server = await certificate(f.certificate);
  assert.equal(server.ca, true);
  assert.deepEqual(await readFile(f.download), server.raw);
  configure(f);
  assert.equal((await certificate(f.certificate)).fingerprint256, server.fingerprint256);
  await rm(f.key);
  assert.throws(() => configure(f), /Both certificate and private key must exist/);
  assert.equal((await certificate(f.certificate)).fingerprint256, server.fingerprint256);
});

test("已有证书模式从不签发，允许关闭根证书下载并拒绝不匹配私钥", async (t) => {
  const f = await fixture(t);
  configure(f);
  const server = await certificate(f.certificate);
  await writeFile(f.config, f.base + "TLS_MODE=existing\n");
  configure(f);
  await assert.rejects(readFile(f.download), { code: "ENOENT" });
  assert.throws(() => configure(f, true), /Existing mode never generates certificates/);
  assert.equal((await certificate(f.certificate)).fingerprint256, server.fingerprint256);
  await writeFile(f.config, f.base + `TLS_MODE=existing\nTLS_KEY=${f.caKey}\n`);
  assert.throws(() => configure(f), /Certificate and private key do not match/);
});
