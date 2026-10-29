import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { DatabaseSync } from "node:sqlite";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { attachAccountRoutes } from "../server/accounts.mjs";

const password = "example-password-for-tests-only";
const requestTimeoutMs = Number(process.env.YOHAKU_TEST_HTTP_TIMEOUT_MS || 5000);
const hash = (value) => createHash("sha256").update(value).digest("hex");

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "yohaku-accounts-"));
  let database, server, url;
  async function start() {
    database = new DatabaseSync(join(dir, "accounts.sqlite"));
    options.beforeAttach?.(database);
    const app = express();
    app.use(express.json());
    const { requireUser } = attachAccountRoutes({
      app,
      database,
      onFirstUser: (id) => options.onFirstUser?.(id, database),
    });
    app.get("/api/protected", requireUser, (req, res) =>
      res.json({ user: req.user }),
    );
    app.use((error, _req, res, _next) =>
      res
        .status(error.status || 500)
        .json({
          error: error.status ? error.message : "服务器暂时无法完成操作。",
        }),
    );
    server = app.listen(0, "127.0.0.1");
    await once(server, "listening");
    url = `http://127.0.0.1:${server.address().port}`;
  }
  async function stop() {
    if (server) {
      await new Promise((resolve) => server.close(resolve));
      server = null;
    }
    if (database) {
      database.close();
      database = null;
    }
  }
  await start();
  t.after(async () => {
    await stop();
    await rm(dir, { recursive: true, force: true });
  });
  async function request(path, { method = "GET", body, cookie } = {}) {
    const response = await fetch(`${url}${path}`, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const setCookie = response.headers.get("set-cookie");
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
      setCookie,
      cookie: setCookie?.split(";")[0],
    };
  }
  const setup = () =>
    request("/api/accounts/setup", {
      method: "POST",
      body: { username: "ReaderAdmin", password },
    });
  return {
    request,
    setup,
    get database() {
      return database;
    },
    restart: async () => {
      await stop();
      await start();
    },
  };
}

test("首次管理员设置只执行一次，旧资料归属与管理员创建在同一事务", async (t) => {
  let migrations = 0;
  const f = await fixture(t, {
    beforeAttach: (database) => {
      database.exec(
        "CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, owner_id TEXT)",
      );
      database
        .prepare("INSERT OR IGNORE INTO legacy (id) VALUES (?)")
        .run("old");
    },
    onFirstUser: (id, database) => {
      migrations++;
      database.prepare("UPDATE legacy SET owner_id = ?").run(id);
    },
  });
  const initial = await f.request("/api/session");
  assert.deepEqual(initial.data, { user: null, needsSetup: true });
  assert.equal((await f.request("/api/protected")).status, 401);
  const admin = await f.setup();
  assert.equal(admin.status, 201);
  assert.equal(admin.data.user.isAdmin, true);
  assert.equal(migrations, 1);
  assert.equal(
    f.database.prepare("SELECT owner_id FROM legacy").get().owner_id,
    admin.data.user.id,
  );
  assert.match(admin.setCookie, /HttpOnly/);
  assert.match(admin.setCookie, /SameSite=Strict/);
  assert.match(admin.setCookie, /Path=\//);
  assert.match(admin.setCookie, /Max-Age=604800/);
  const session = await f.request("/api/session", { cookie: admin.cookie });
  assert.deepEqual(session.data, { user: admin.data.user, needsSetup: false });
  const again = await f.setup();
  assert.equal(again.status, 409);
  assert.equal(migrations, 1);
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM users").get().count,
    1,
  );
  const stored = f.database.prepare("SELECT * FROM users").get();
  assert.equal(stored.password_hash.includes(password), false);
  assert.match(stored.password_hash, /^scrypt\$32768\$8\$3\$/);
  const rawSession = admin.cookie.slice(admin.cookie.indexOf("=") + 1);
  const storedSession = f.database.prepare("SELECT * FROM sessions").get();
  assert.equal(storedSession.token_hash === rawSession, false);
  assert.equal(storedSession.token_hash === hash(rawSession), true);
  assert.equal(stored.owner_id, stored.id);
  assert.equal(stored.issuer_id, stored.id);
});

test("首次迁移失败完整回滚，不留下管理员或会话，之后可以重新建立", async (t) => {
  let fail = true;
  const f = await fixture(t, {
    beforeAttach: (database) => {
      database.exec(
        "CREATE TABLE IF NOT EXISTS legacy (id TEXT PRIMARY KEY, owner_id TEXT); INSERT OR IGNORE INTO legacy (id) VALUES ('old')",
      );
    },
    onFirstUser: (id, database) => {
      database.prepare("UPDATE legacy SET owner_id = ?").run(id);
      if (fail) throw new Error("migration failed");
    },
  });
  const rejected = await f.setup();
  assert.equal(rejected.status, 500);
  assert.equal(rejected.cookie, undefined);
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM users").get().count,
    0,
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM sessions").get().count,
    0,
  );
  assert.equal(
    f.database.prepare("SELECT owner_id FROM legacy").get().owner_id,
    null,
  );
  assert.equal((await f.request("/api/session")).data.needsSetup, true);
  fail = false;
  assert.equal((await f.setup()).status, 201);
});

test("并发首次设置仍只能建立一个管理员，并只迁移一次资料", async (t) => {
  let migrations = 0;
  const f = await fixture(t, {
    onFirstUser: () => {
      migrations++;
    },
  });
  const result = await Promise.all(
    ["OwnerOne", "OwnerTwo"].map((username) =>
      f.request("/api/accounts/setup", {
        method: "POST",
        body: { username, password },
      }),
    ),
  );
  assert.deepEqual(result.map((item) => item.status).sort(), [201, 409]);
  assert.equal(migrations, 1);
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM users").get().count,
    1,
  );
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM sessions").get().count,
    1,
  );
});

test("错误登录统一返回401，成功登录轮换会话；大小写归一且不接受伪造Cookie", async (t) => {
  const f = await fixture(t);
  const admin = await f.setup();
  const incorrect = await f.request("/api/session/login", {
    method: "POST",
    body: { username: "readeradmin", password: "incorrect-password" },
  });
  const absent = await f.request("/api/session/login", {
    method: "POST",
    body: { username: "nonexistent", password: "incorrect-password" },
  });
  assert.equal(incorrect.status, 401);
  assert.equal(absent.status, 401);
  assert.deepEqual(incorrect.data, absent.data);
  const login = await f.request("/api/session/login", {
    method: "POST",
    body: { username: "readeradmin", password },
    cookie: admin.cookie,
  });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, admin.data.user.id);
  assert.equal(login.cookie === admin.cookie, false);
  assert.equal(
    (await f.request("/api/protected", { cookie: admin.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/protected", { cookie: login.cookie })).status,
    200,
  );
  assert.equal(
    (await f.request("/api/protected", { cookie: "yohaku_session=invalid" }))
      .status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/protected", {
        cookie: `${login.cookie}; ${login.cookie}`,
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await f.request("/api/protected", {
        cookie: `yohaku_session=${"a".repeat(43)}`,
      })
    ).status,
    401,
  );
});

test("只有管理员可生成邀请，朋友以独立会话注册且不能提升权限", async (t) => {
  const f = await fixture(t);
  const admin = await f.setup();
  assert.equal(
    (await f.request("/api/invitations", { method: "POST" })).status,
    401,
  );
  const invitation = await f.request("/api/invitations", {
    method: "POST",
    cookie: admin.cookie,
  });
  assert.equal(invitation.status, 201);
  const expiresIn = Date.parse(invitation.data.expiresAt) - Date.now();
  assert.ok(expiresIn > 6.99 * 86400_000 && expiresIn <= 7 * 86400_000);
  const storedInvite = f.database.prepare("SELECT * FROM invitations").get();
  assert.equal(storedInvite.token_hash === invitation.data.token, false);
  assert.equal(storedInvite.token_hash === hash(invitation.data.token), true);
  assert.equal(storedInvite.owner_id, admin.data.user.id);
  assert.equal(storedInvite.issuer_id, admin.data.user.id);
  const friend = await f.request("/api/accounts/register", {
    method: "POST",
    body: {
      username: "ReaderFriend",
      password,
      inviteToken: invitation.data.token,
      isAdmin: true,
    },
  });
  assert.equal(friend.status, 201);
  assert.equal(friend.data.user.isAdmin, false);
  assert.notEqual(friend.data.user.id, admin.data.user.id);
  assert.equal(
    (await f.request("/api/session", { cookie: friend.cookie })).data.user.id,
    friend.data.user.id,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: admin.cookie })).data.user.id,
    admin.data.user.id,
  );
  assert.equal(
    (
      await f.request("/api/invitations", {
        method: "POST",
        cookie: friend.cookie,
      })
    ).status,
    403,
  );
  assert.equal(
    (await f.request("/api/accounts", { cookie: friend.cookie })).status,
    403,
  );
  const listing = await f.request("/api/accounts", { cookie: admin.cookie });
  assert.equal(listing.status, 200);
  assert.equal(listing.data.users.length, 2);
  assert.equal(JSON.stringify(listing.data).includes("password_hash"), false);
  const storedFriend = f.database
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(friend.data.user.id);
  assert.equal(storedFriend.owner_id, friend.data.user.id);
  assert.equal(storedFriend.issuer_id, admin.data.user.id);
  const storedAdmin = f.database
    .prepare("SELECT * FROM users WHERE id = ?")
    .get(admin.data.user.id);
  assert.equal(storedAdmin.password_hash === storedFriend.password_hash, false);
});

test("邀请码过期后失效，同一个邀请并发注册也只能使用一次", async (t) => {
  const f = await fixture(t);
  const admin = await f.setup();
  const expired = await f.request("/api/invitations", {
    method: "POST",
    cookie: admin.cookie,
  });
  f.database
    .prepare("UPDATE invitations SET expires_at = ?")
    .run(Date.now() - 1);
  const old = await f.request("/api/accounts/register", {
    method: "POST",
    body: { username: "OldInvite", password, inviteToken: expired.data.token },
  });
  assert.equal(old.status, 400);
  const invite = await f.request("/api/invitations", {
    method: "POST",
    cookie: admin.cookie,
  });
  const results = await Promise.all(
    ["FriendOne", "FriendTwo"].map((username) =>
      f.request("/api/accounts/register", {
        method: "POST",
        body: { username, password, inviteToken: invite.data.token },
      }),
    ),
  );
  assert.deepEqual(results.map((result) => result.status).sort(), [201, 400]);
  assert.equal(
    f.database.prepare("SELECT count(*) AS count FROM users").get().count,
    2,
  );
  const reuse = await f.request("/api/accounts/register", {
    method: "POST",
    body: { username: "FriendThree", password, inviteToken: invite.data.token },
  });
  assert.equal(reuse.status, 400);
  assert.deepEqual(old.data, reuse.data);
});

test("过期和注销会话不能访问受保护接口，另一个账户仍可正常访问", async (t) => {
  const f = await fixture(t);
  const admin = await f.setup();
  const invite = await f.request("/api/invitations", {
    method: "POST",
    cookie: admin.cookie,
  });
  const friend = await f.request("/api/accounts/register", {
    method: "POST",
    body: {
      username: "ReaderFriend",
      password,
      inviteToken: invite.data.token,
    },
  });
  f.database
    .prepare("UPDATE sessions SET expires_at = ? WHERE owner_id = ?")
    .run(Date.now() - 1, friend.data.user.id);
  assert.equal(
    (await f.request("/api/protected", { cookie: friend.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/protected", { cookie: admin.cookie })).status,
    200,
  );
  const logout = await f.request("/api/session/logout", {
    method: "POST",
    cookie: admin.cookie,
  });
  assert.equal(logout.status, 204);
  assert.match(logout.setCookie, /Max-Age=0/);
  assert.equal(
    (await f.request("/api/protected", { cookie: admin.cookie })).status,
    401,
  );
  assert.equal(
    (await f.request("/api/session", { cookie: admin.cookie })).data.user,
    null,
  );
});

test("网站账户和已登录会话经服务重启仍有效", async (t) => {
  const f = await fixture(t);
  const admin = await f.setup();
  await f.restart();
  const result = await f.request("/api/session", { cookie: admin.cookie });
  assert.equal(result.data.user.id, admin.data.user.id);
  assert.equal(result.data.needsSetup, false);
  assert.equal(
    (await f.request("/api/protected", { cookie: admin.cookie })).status,
    200,
  );
});

test("用户名和密码边界校验，连续错误登录会限速", async (t) => {
  const f = await fixture(t);
  for (const body of [
    { username: "ab", password },
    { username: "valid-user", password: "short" },
    { username: "valid-user", password: "x".repeat(129) },
    { username: "bad name", password },
  ]) {
    assert.equal(
      (await f.request("/api/accounts/setup", { method: "POST", body })).status,
      400,
    );
  }
  const admin = await f.setup();
  assert.equal(admin.status, 201);
  for (let i = 0; i < 8; i++)
    assert.equal(
      (
        await f.request("/api/session/login", {
          method: "POST",
          body: { username: "ReaderAdmin", password: "incorrect-password" },
        })
      ).status,
      401,
    );
  const limited = await f.request("/api/session/login", {
    method: "POST",
    body: { username: "ReaderAdmin", password },
  });
  assert.equal(limited.status, 429);
  assert.match(limited.data.error, /15 分钟/);
});
