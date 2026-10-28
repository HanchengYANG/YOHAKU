// Credential records and OAuth backends in this file are test fixtures only.
// No user's Codex credentials are read and no real inference is performed.
import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { createApp } from "../server/app.mjs";
import { cookieFromResponse, ensureSession } from "./helpers/session.mjs";

async function start(dataDir, aiServices) {
  const { app, close } = createApp({ dataDir, aiServices });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  let stopped = false;
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    async stop() {
      if (stopped) return;
      stopped = true;
      const done = new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await done;
      close();
    },
  };
}

async function request(
  url,
  cookie,
  path,
  method = "GET",
  body,
  { redirect = "follow" } = {},
) {
  const response = await fetch(`${url}${path}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    redirect,
    signal: AbortSignal.timeout(10000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: response.status, headers: response.headers, data, text };
}

async function friendSession(url, ownerCookie) {
  const invite = await request(
    url,
    ownerCookie,
    "/api/invitations",
    "POST",
    {},
  );
  assert.equal(invite.status, 201);
  const response = await fetch(`${url}/api/accounts/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: "binding_friend",
      password: "fixture-friend-password",
      inviteToken: invite.data.token,
    }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 201);
  const cookie = cookieFromResponse(response);
  return { cookie, user: (await response.json()).user };
}

const fixtureTokens = Object.freeze({
  access_token: "TEST-ONLY-SIWC-ACCESS-NEVER-REAL",
  refresh_token: "TEST-ONLY-SIWC-REFRESH-NEVER-REAL",
  id_token: "TEST-ONLY-SIWC-ID-NEVER-REAL",
});

function noCredentials(response) {
  for (const value of Object.values(fixtureTokens))
    assert.ok(!response.text.includes(value));
  assert.doesNotMatch(
    response.text,
    /"(?:access_token|refresh_token|id_token)"/,
  );
}

function bindingRows(dataDir) {
  const database = new DatabaseSync(join(dataDir, "yohaku.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        "SELECT provider_id,subject,user_id FROM provider_bindings ORDER BY user_id,subject",
      )
      .all()
      .map((row) => ({ ...row }));
  } finally {
    database.close();
  }
}

async function credentialFixture(directory, host) {
  await mkdir(join(directory, "runtime"), { recursive: true, mode: 0o700 });
  const registration = {
    schemaVersion: 1,
    activeId: "legacy-fixture-registration",
    accounts: [
      {
        id: "legacy-fixture-registration",
        client_id: "fixture-only-issued-client",
        subject: "fixture-only-chatgpt-subject",
        issuer: "https://auth.openai.com",
        email: "fixture@example.test",
        ...fixtureTokens,
        token_type: "Bearer",
        scopes: [
          "openid",
          "profile",
          "email",
          "offline_access",
          "resource.invoke",
          "chatgpt.tokens.use.direct",
        ],
        expires_at: Date.now() + 60 * 60_000,
        saved_at: new Date().toISOString(),
      },
    ],
  };
  await writeFile(join(directory, "chatgpt-host.json"), JSON.stringify(host), {
    mode: 0o600,
  });
  await writeFile(
    join(directory, "chatgpt-accounts.json"),
    JSON.stringify(registration),
    { mode: 0o600 },
  );
  await writeFile(
    join(directory, "runtime", "fixture-history.txt"),
    "fixture-only-thread-history",
    { mode: 0o600 },
  );
  return registration;
}

test("真实provider与网站会话：拥有者认领旧SIWC后全站共享，重启保留绑定并忽略成员旧授权", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-legacy-bindings-"));
  const host = { ext_agent_host_id: `urn:uuid:${randomUUID()}` };
  const legacyDir = join(dataDir, "ai");
  const registration = await credentialFixture(legacyDir, host);
  const invocationMarker = join(dataDir, "forbidden-runtime-invoked");
  const forbiddenCLI = join(dataDir, "forbidden-runtime.mjs");
  await writeFile(
    forbiddenCLI,
    `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(invocationMarker)}, 'called');\nprocess.exit(1);\n`,
    { mode: 0o700 },
  );
  const previousCLI = process.env.YOHAKU_CODEX_PATH;
  process.env.YOHAKU_CODEX_PATH = forbiddenCLI;
  const previousFetch = globalThis.fetch;
  let externalRequests = 0;
  globalThis.fetch = (input, options) => {
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
      externalRequests++;
      throw new Error("该磁盘迁移测试禁止外部网络");
    }
    return previousFetch(input, options);
  };
  let running;
  t.after(async () => {
    if (running) await running.stop();
    globalThis.fetch = previousFetch;
    if (previousCLI === undefined) delete process.env.YOHAKU_CODEX_PATH;
    else process.env.YOHAKU_CODEX_PATH = previousCLI;
    await rm(dataDir, { recursive: true, force: true });
  });
  running = await start(dataDir);
  const owner = await ensureSession(running.url);
  const friend = await friendSession(running.url, owner.cookie);
  const initial = await request(running.url, owner.cookie, "/api/ai/status");
  assert.equal(initial.status, 200);
  assert.equal(initial.data.canClaimExisting, true);
  assert.equal(initial.data.connected, false);
  noCredentials(initial);
  const friendInitial = await request(
    running.url,
    friend.cookie,
    "/api/ai/status",
  );
  assert.equal(friendInitial.data.connected, false);
  assert.equal(friendInitial.data.canClaimExisting, false);
  assert.equal(
    (
      await request(
        running.url,
        friend.cookie,
        "/api/ai/claim-existing",
        "POST",
        {},
      )
    ).status,
    403,
  );
  await access(join(legacyDir, "chatgpt-accounts.json"));

  const claimed = await request(
    running.url,
    owner.cookie,
    "/api/ai/claim-existing",
    "POST",
    {},
  );
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.connected, true);
  assert.equal(claimed.data.canClaimExisting, false);
  assert.equal(claimed.data.subject, registration.accounts[0].subject);
  assert.equal(claimed.data.activeAccountId, registration.activeId);
  noCredentials(claimed);
  const target = join(dataDir, "users", owner.user.id, "providers", "openai");
  assert.deepEqual(
    JSON.parse(await readFile(join(target, "chatgpt-host.json"), "utf8")),
    host,
  );
  assert.deepEqual(
    JSON.parse(await readFile(join(target, "chatgpt-accounts.json"), "utf8")),
    registration,
  );
  assert.equal(
    await readFile(join(target, "runtime", "fixture-history.txt"), "utf8"),
    "fixture-only-thread-history",
  );
  await assert.rejects(access(legacyDir), (error) => error.code === "ENOENT");
  const expectedBinding = [
    {
      provider_id: "openai",
      subject: registration.accounts[0].subject,
      user_id: owner.user.id,
    },
  ];
  assert.deepEqual(bindingRows(dataDir), expectedBinding);
  const friendAfter = await request(
    running.url,
    friend.cookie,
    "/api/ai/status",
  );
  assert.equal(friendAfter.data.connected, true);
  assert.equal(friendAfter.data.canManageAI, false);
  for (const key of ["email", "subject", "clientId", "accounts", "activeAccountId"])
    assert.equal(friendAfter.data[key], undefined);
  noCredentials(friendAfter);
  const document = await request(
    running.url,
    friend.cookie,
    "/api/documents",
    "POST",
    {
      title: "朋友自己的资料",
      kind: "article",
      orientation: "horizontal",
      content: "友だちの文章。",
    },
  );
  assert.equal(document.status, 201);

  await running.stop();
  assert.deepEqual(bindingRows(dataDir), expectedBinding);
  // A member's old credential file is retained but never selected as shared AI.
  // These are exclusively test credentials, never a copy of any real session.
  await credentialFixture(
    join(dataDir, "users", friend.user.id, "providers", "openai"),
    { ext_agent_host_id: `urn:uuid:${randomUUID()}` },
  );
  const oldDatabase = new DatabaseSync(join(dataDir, "yohaku.sqlite"));
  oldDatabase.prepare("INSERT INTO user_providers(user_id,provider_id) VALUES(?,?)")
    .run(friend.user.id, "claude");
  // The owner's verified grant takes precedence over an obsolete member binding.
  oldDatabase.prepare("UPDATE provider_bindings SET user_id=?").run(friend.user.id);
  oldDatabase.close();
  running = await start(dataDir);
  assert.deepEqual(
    (await request(running.url, owner.cookie, "/api/session")).data.user,
    owner.user,
  );
  assert.deepEqual(
    (await request(running.url, friend.cookie, "/api/session")).data.user,
    friend.user,
  );
  const ownerReopened = await request(
    running.url,
    owner.cookie,
    "/api/ai/status",
  );
  assert.equal(ownerReopened.data.connected, true);
  assert.deepEqual(bindingRows(dataDir), expectedBinding);
  noCredentials(ownerReopened);
  const collision = await request(running.url, friend.cookie, "/api/ai/status");
  assert.equal(collision.data.connected, true);
  assert.equal(collision.data.email, undefined);
  noCredentials(collision);
  assert.equal(externalRequests, 0);
  await assert.rejects(
    access(invocationMarker),
    (error) => error.code === "ENOENT",
  );
});

function oauthService(userId, records) {
  const state = {
    connected: false,
    pending: null,
    callbacks: [],
    runs: 0,
    stopped: 0,
  };
  const account = {
    id: `fixture-registration-${userId}`,
    subject: `fixture-oauth-subject-${userId}`,
    clientId: `fixture-client-${userId}`,
    email: `${userId}@example.test`,
  };
  const auth = {
    status: async () => ({
      ...account,
      connected: state.connected,
      activeAccountId: state.connected ? account.id : null,
      pending: !!state.pending,
      lastError: null,
    }),
    accounts: async () => ({
      accounts: state.connected ? [account] : [],
      activeId: state.connected ? account.id : null,
    }),
    start: async () => {
      state.pending = randomUUID();
      return {
        url: `https://auth.openai.com/authorize?state=${state.pending}`,
      };
    },
    callback: async (params) => {
      assert.equal(params.get("state"), state.pending);
      assert.equal(params.get("code"), "TEST-ONLY-OAUTH-CODE");
      state.callbacks.push(params.get("state"));
      state.pending = null;
      state.connected = true;
    },
    accessToken: async () => {
      throw new Error("该OAuth路由测试禁止推理");
    },
  };
  const runtime = {
    status: () => ({
      running: false,
      busy: false,
      model: null,
      lastError: null,
    }),
    stop: () => {
      state.stopped++;
    },
    run: async () => {
      state.runs++;
      throw new Error("该OAuth路由测试禁止推理");
    },
  };
  records.set(userId, { state, auth, runtime });
  return records.get(userId);
}

test("真实登录与OAuth替身：无Cookie回调按pending state绑定发起账号，拒绝重放并隐藏code", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "yohaku-callback-bindings-"));
  const records = new Map();
  const factory = (userId) =>
    records.get(userId) || oauthService(userId, records);
  const running = await start(dataDir, factory);
  t.after(async () => {
    await running.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const owner = await ensureSession(running.url);
  const friend = await friendSession(running.url, owner.cookie);
  const ownerLogin = await request(
    running.url,
    owner.cookie,
    "/api/ai/login",
    "POST",
    { newAccount: true },
  );
  const friendLogin = await request(
    running.url,
    friend.cookie,
    "/api/ai/login",
    "POST",
    { newAccount: true },
  );
  assert.equal(ownerLogin.status, 200);
  assert.equal(friendLogin.status, 403);
  const ownerState = new URL(ownerLogin.data.url).searchParams.get("state");
  assert.equal(records.size, 1);
  const callbackPath = `/auth/callback?state=${encodeURIComponent(ownerState)}&code=TEST-ONLY-OAUTH-CODE`;
  // No Cookie deliberately simulates SameSite=Strict on an external redirect.
  const callback = await request(
    running.url,
    null,
    callbackPath,
    "GET",
    undefined,
    { redirect: "manual" },
  );
  assert.equal(callback.status, 303);
  assert.equal(callback.headers.get("location"), "/?chatgpt=connected");
  assert.equal(callback.headers.get("referrer-policy"), "no-referrer");
  assert.ok(!callback.text.includes("TEST-ONLY-OAUTH-CODE"));
  assert.deepEqual(records.get(owner.user.id).state.callbacks, [ownerState]);
  assert.equal(records.has(friend.user.id), false);
  const ownerStatus = await request(
    running.url,
    owner.cookie,
    "/api/ai/status",
  );
  const friendStatus = await request(
    running.url,
    friend.cookie,
    "/api/ai/status",
  );
  assert.equal(ownerStatus.data.connected, true);
  assert.equal(friendStatus.data.connected, true);
  assert.equal(friendStatus.data.canManageAI, false);
  assert.equal(friendStatus.data.pending, undefined);
  assert.equal(friendStatus.data.email, undefined);
  assert.deepEqual(bindingRows(dataDir), [
    {
      provider_id: "openai",
      subject: `fixture-oauth-subject-${owner.user.id}`,
      user_id: owner.user.id,
    },
  ]);
  for (const path of [
    callbackPath,
    "/auth/callback?state=unknown&code=TEST-ONLY-OAUTH-CODE",
    "/auth/callback?code=TEST-ONLY-OAUTH-CODE",
  ]) {
    const rejected = await request(running.url, null, path);
    assert.equal(rejected.status, 400);
    assert.ok(!rejected.text.includes("TEST-ONLY-OAUTH-CODE"));
  }
  for (const providerId of ["claude", "api_base"]) {
    assert.equal(
      (
        await request(
          running.url,
          owner.cookie,
          "/api/providers/active",
          "POST",
          { providerId },
        )
      ).status,
      501,
    );
  }
  assert.equal(records.get(owner.user.id).state.runs, 0);
  assert.equal(records.has(friend.user.id), false);
  assert.deepEqual(records.get(owner.user.id).state.callbacks, [ownerState]);
});
