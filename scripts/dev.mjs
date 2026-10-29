import { X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir, networkInterfaces } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Load the local .env (ignored by Git) so a single `npm run dev` brings up the
// configured HTTP or HTTPS environment without repeating variables. Real
// environment variables passed on the command line are never overridden, while
// later lines in .env override earlier defaults in the same file.
function loadDotEnv() {
  const path = new URL("../.env", import.meta.url);
  if (!existsSync(path)) return false;
  const home = homedir();
  const initialEnv = new Set(Object.keys(process.env));
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(entry);
    if (!match) continue;
    const [, key, raw] = match;
    if (initialEnv.has(key)) continue;
    let value = raw.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )
      value = value.slice(1, -1);
    if (value.startsWith("~/") || value === "~") value = home + value.slice(1);
    process.env[key] = value;
  }
  return true;
}

function detectLanIp() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return null;
}

function certificateCoversHost(certPath, targetHost) {
  if (!existsSync(certPath)) return false;
  const host = targetHost === "[::1]" ? "::1" : targetHost;
  try {
    const cert = new X509Certificate(readFileSync(certPath));
    return Boolean(
      /^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")
        ? cert.checkIP(host)
        : cert.checkHost(host),
    );
  } catch {
    return false;
  }
}

const loadedDotEnv = loadDotEnv();
const forceHttps = process.argv.includes("--https");
const defaultCertDir = resolve(homedir(), ".local/share/yohaku/dev");

const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const wildcardHosts = new Set(["0.0.0.0", "::", "[::]"]);

if (
  process.env.HOST === "lan" ||
  (forceHttps && (!process.env.HOST || loopbackHosts.has(process.env.HOST)))
) {
  process.env.HOST = detectLanIp() || "127.0.0.1";
}

if (forceHttps && !process.env.TLS_KEY && !process.env.TLS_CERT) {
  process.env.TLS_KEY = join(defaultCertDir, "key.pem");
  process.env.TLS_CERT = join(defaultCertDir, "cert.pem");
}

const tlsKey = process.env.TLS_KEY;
const tlsCert = process.env.TLS_CERT;
if (Boolean(tlsKey) !== Boolean(tlsCert))
  fail("TLS_KEY 与 TLS_CERT 必须同时配置才能启用 HTTPS。");

const host = process.env.HOST || "127.0.0.1";
const publicHost = wildcardHosts.has(host) ? detectLanIp() || "127.0.0.1" : host;
if (tlsKey) {
  const resolvedKey = resolve(tlsKey);
  const resolvedCert = resolve(tlsCert);
  const certDir = dirname(resolvedCert);
  const standardPair =
    resolvedKey === join(certDir, "key.pem") &&
    resolvedCert === join(certDir, "cert.pem");
  const missingBoth = !existsSync(resolvedKey) && !existsSync(resolvedCert);
  const staleManagedCert =
    certDir === defaultCertDir &&
    standardPair &&
    (!existsSync(resolvedKey) || !certificateCoversHost(resolvedCert, publicHost));
  if ((missingBoth && standardPair) || staleManagedCert) {
    const certHost = loopbackHosts.has(publicHost)
      ? detectLanIp() || "127.0.0.1"
      : publicHost;
    const args = [fileURLToPath(new URL("./dev-tls.sh", import.meta.url))];
    if (staleManagedCert) args.push("--force");
    args.push(certHost, certDir);
    const result = spawnSync("bash", args, { stdio: "inherit" });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
for (const file of [tlsKey, tlsCert])
  if (file && !existsSync(file))
    fail(`找不到证书文件 ${file}，请先运行 bash scripts/dev-tls.sh <局域网IP>。`);

const scheme = tlsKey ? "https" : "http";
const urlHost =
  publicHost.includes(":") && !publicHost.startsWith("[")
    ? `[${publicHost}]`
    : publicHost;
if (!loopbackHosts.has(publicHost) && !process.env.PUBLIC_ORIGIN)
  process.env.PUBLIC_ORIGIN = `${scheme}://${urlHost}:5173`;

console.log(
  `开发环境：${scheme}://${urlHost}:5173  （.env${loadedDotEnv ? " 已加载" : " 未配置"}）`,
);

const server = spawn(process.execPath, ["--watch", "server/index.mjs"], {
  stdio: "inherit",
});
const client = spawn(process.execPath, ["node_modules/vite/bin/vite.js"], {
  stdio: "inherit",
});
let stopping = false;
function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill("SIGTERM");
  client.kill("SIGTERM");
  process.exitCode = code;
}
for (const child of [server, client]) {
  child.on("error", (e) => {
    console.error(e.message);
    stop(1);
  });
  child.on("exit", (code, signal) => {
    if (!stopping) stop(code ?? (signal ? 1 : 0));
  });
}
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
