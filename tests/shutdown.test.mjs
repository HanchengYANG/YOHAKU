import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "./helpers/session.mjs";

test("停服先停止后台工作，再等待正在验证密码的HTTP请求完成后关闭数据库", async () => {
  const directory = await mkdtemp(join(tmpdir(), "yohaku-shutdown-"));
  const originalScrypt = crypto.scrypt;
  let hold = null, release = null, server, application, login, stopping;
  crypto.scrypt = (...args) => {
    const callback = args.pop();
    originalScrypt(...args, (error, result) => {
      const finish = () => callback(error, result);
      if (hold) hold(finish); else finish();
    });
  };
  syncBuiltinESMExports();
  try {
    // Import after installing the gate: accounts.mjs promisifies scrypt once.
    const { createApp } = await import("../server/app.mjs");
    application = createApp({ dataDir:directory });
    server = application.app.listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}`;
    await ensureSession(url);
    let entered;
    const paused = new Promise((resolve) => { entered = resolve; });
    hold = (finish) => { release = finish; entered(); };
    login = fetch(`${url}/api/session/login`, { method:"POST",
      headers:{ "Content-Type":"application/json", Connection:"close" },
      body:JSON.stringify({ username:"test_owner", password:"fixture-only-password" }),
      signal:AbortSignal.timeout(10000) });
    await paused;
    const httpClosed = new Promise((resolve) => server.close(resolve));
    server.closeIdleConnections();
    stopping = application.shutdown({ beforeClose:httpClosed });
    await new Promise((resolve) => setImmediate(resolve));
    release(); release = null;
    const response = await login;
    assert.equal(response.status, 200, "异步密码验证完成后仍须能写入登录会话");
    assert.equal((await response.json()).user.username, "test_owner");
    await stopping;
  } finally {
    hold = null; release?.();
    await login?.catch(() => {});
    await stopping?.catch(() => {});
    server?.closeAllConnections();
    application?.close();
    crypto.scrypt = originalScrypt;
    syncBuiltinESMExports();
    await rm(directory, { recursive:true, force:true });
  }
});
