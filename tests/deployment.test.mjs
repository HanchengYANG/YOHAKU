import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { request } from "node:http";
import { createApp } from "../server/app.mjs";

test("部署站点允许指定 Host 与 HTTPS 来源，拒绝其它来源并设置 Secure cookie", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "yohaku-deployment-"));
  const { app, close } = createApp({
    dataDir: dir,
    publicOrigin: "https://reader.example",
    publicOrigins: "https://outside.example:8443",
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    close();
    await rm(dir, { recursive: true, force: true });
  });
  function send(path, { host = "reader.example", origin, method = "GET", body } = {}) {
    return new Promise((resolve, reject) => {
      const req = request({
        host: "127.0.0.1", port: server.address().port, path, method,
        headers: { Host: host, "X-Forwarded-Proto": "https",
          ...(origin ? { Origin: origin } : {}),
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
      }, (res) => {
        res.resume();
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers }));
      });
      req.on("error", reject);
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  assert.equal((await send("/api/health")).status, 200);
  assert.equal((await send("/api/health", { host: "outside.example:8443" })).status, 200);
  for (const host of ["attacker.example", "reader.example.attacker.example", "user@reader.example", "outside.example", "outside.example:8444"]) {
    assert.equal((await send("/api/health", { host })).status, 403);
  }
  for (const origin of ["https://attacker.example", "http://reader.example", "https://reader.example:444", "https://reader.example/path", "http://localhost:5173", "https://outside.example", "http://outside.example:8443", "https://outside.example:8444"]) {
    assert.equal((await send("/api/accounts/setup", { method: "POST", origin })).status, 403);
  }
  const setup = await send("/api/accounts/setup", {
    method: "POST", origin: "https://reader.example",
    body: { username: "pi_admin", password: "deployment-test-password" },
  });
  assert.equal(setup.status, 201);
  assert.match(setup.headers["set-cookie"].join(";"), /; Secure/);
  const login = await send("/api/session/login", {
    host: "outside.example:8443", origin: "https://outside.example:8443", method: "POST",
    body: { username: "pi_admin", password: "deployment-test-password" },
  });
  assert.equal(login.status, 200);
  assert.match(login.headers["set-cookie"].join(";"), /; Secure/);
});

test("附加站点来源拒绝通配符、路径、凭据与非 HTTP 协议", () => {
  for (const publicOrigins of ["*", "https://reader.example/path", "https://user:password@reader.example", "ftp://reader.example"]) {
    assert.throws(() => createApp({ publicOrigins }));
  }
});
