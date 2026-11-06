// tests/error-log-api.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../server/app.mjs";
import { cookieFromResponse, ensureSession, sessionHeaders } from "./helpers/session.mjs";

async function start(t) {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-error-log-"));
  const created = createApp({ dataDir });
  const server = created.app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    created.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  return { ...created, url: `http://127.0.0.1:${server.address().port}` };
}

test("管理员可以浏览、按代码查找并展开错误记录", async (t) => {
  const { url, errorLog } = await start(t);
  const { user } = await ensureSession(url);
  const code = errorLog.record(new Error("磁盘已满\nat write"), { userId: user.id, scope: "http", location: "GET /api/example" });
  const get = (path) => fetch(`${url}${path}`, { headers: sessionHeaders(url) });
  const list = await (await get("/api/admin/errors")).json();
  assert.equal(list.items[0].code, code);
  assert.equal(list.items[0].summary, "磁盘已满");
  assert.equal(list.items[0].username, "test_owner");
  const found = await (await get(`/api/admin/errors?query=${code.toLowerCase()}`)).json();
  assert.deepEqual(found.items.map((item) => item.code), [code]);
  const detail = await get(`/api/admin/errors/${code}`);
  assert.equal(detail.status, 200);
  assert.equal((await detail.json()).location, "GET /api/example");
  assert.equal((await get("/api/admin/errors/ZZZZZZ")).status, 404);
});

test("未登录不能读取错误记录", async (t) => {
  const { url } = await start(t);
  assert.equal((await fetch(`${url}/api/admin/errors`)).status, 401);
});

test("非管理员不能读取错误记录", async (t) => {
  const { url, errorLog } = await start(t);
  const { user } = await ensureSession(url);
  const code = errorLog.record(new Error("磁盘已满"), { userId: user.id });
  const invitation = await fetch(`${url}/api/invitations`, { method: "POST", headers: sessionHeaders(url) });
  assert.equal(invitation.status, 201);
  // The session helper caches one cookie per origin, so the member's cookie is kept here.
  const registered = await fetch(`${url}/api/accounts/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "test_member", password: "fixture-only-password", inviteToken: (await invitation.json()).token }),
  });
  assert.equal(registered.status, 201);
  const member = { Cookie: cookieFromResponse(registered) };
  for (const path of ["/api/admin/errors", `/api/admin/errors/${code}`]) {
    const response = await fetch(`${url}${path}`, { headers: member });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error, "只有管理员可以查看错误记录。");
  }
});
