import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, rename, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { generateKeyPair, SignJWT } from "jose";
import { createChatGPTAuth } from "../server/providers/openai/auth.mjs";

const issuer = "https://auth.openai.com";
const planScope =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const { privateKey, publicKey } = await generateKeyPair("ES256");
const { privateKey: wrongKey } = await generateKeyPair("ES256");

async function fixture(t) {
  const storageDir = await mkdtemp(join(tmpdir(), "yohaku-auth-test-"));
  t.after(() => rm(storageDir, { recursive: true, force: true }));
  let currentTime = Date.now(),
    tokenPayload,
    refreshCount = 0,
    revokeCount = 0;
  let refreshHandler = async () => ({
    access_token: "rotated-access",
    refresh_token: "rotated-refresh",
    token_type: "Bearer",
    expires_in: 3600,
  });
  let revokeStatus = 200;
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith("/.well-known/openid-configuration"))
      return Response.json({
        issuer,
        jwks_uri: `${issuer}/.well-known/jwks.json`,
        revocation_endpoint: `${issuer}/oauth/revoke`,
      });
    if (url.endsWith("/api/accounts/oauth/token")) {
      const body = new URLSearchParams(options.body);
      if (body.get("grant_type") === "refresh_token") {
        refreshCount++;
        const result = await refreshHandler(body);
        return result instanceof Response ? result : Response.json(result);
      }
      return Response.json(tokenPayload);
    }
    if (url.endsWith("/oauth/revoke")) {
      revokeCount++;
      return new Response(null, { status: revokeStatus });
    }
    throw new Error("Unexpected test URL");
  };
  const options = {
    storageDir,
    callbackUri: "http://127.0.0.1:4317/auth/callback",
    fetchImpl,
    jwks: publicKey,
    now: () => currentTime,
  };
  const auth = createChatGPTAuth(options);
  async function prepare({
    newAccount = false,
    clientId = "oaiapp_test",
    subject = "subject-1",
    email = "first@example.test",
    claims = {},
    key = privateKey,
    token = {},
  } = {}) {
    const url = new URL((await auth.start({ newAccount })).url);
    const registeredClient = url.searchParams.get("client_id");
    const chosenClient =
      registeredClient === "dynamic_agent_client" ? clientId : registeredClient;
    const jwt = await new SignJWT({
      sub: subject,
      email,
      nonce: url.searchParams.get("nonce"),
      ...claims,
    })
      .setProtectedHeader({ alg: "ES256" })
      .setIssuer(claims.iss || issuer)
      .setAudience(claims.aud || chosenClient)
      .setIssuedAt(Math.floor(currentTime / 1000))
      .setExpirationTime(claims.exp ?? Math.floor(currentTime / 1000) + 3600)
      .sign(key);
    tokenPayload = {
      access_token: "initial-access",
      refresh_token: "initial-refresh",
      id_token: jwt,
      token_type: "Bearer",
      expires_in: 3600,
      scope: planScope,
      ...token,
    };
    const params = new URLSearchParams({
      state: url.searchParams.get("state"),
      code: "test-code",
      client_id: chosenClient,
    });
    return { url, params, chosenClient };
  }
  return {
    auth,
    options,
    storageDir,
    calls,
    prepare,
    setTime: (value) => {
      currentTime = value;
    },
    advance: (ms) => {
      currentTime += ms;
    },
    setRefresh: (handler) => {
      refreshHandler = handler;
    },
    setRevoke: (status) => {
      revokeStatus = status;
    },
    get refreshCount() {
      return refreshCount;
    },
    get revokeCount() {
      return revokeCount;
    },
  };
}

test("SIWC 首次注册校验 PKCE、scope、身份并持久保存，安全摘要不含凭据", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.auth.status()).connected, false);
  const { url, params, chosenClient } = await f.prepare();
  assert.equal(url.origin, issuer);
  assert.equal(url.searchParams.get("client_id"), "dynamic_agent_client");
  assert.equal(url.searchParams.get("agent_name_hint"), "yohaku_reader");
  assert.equal(url.searchParams.get("redirect_uri"), f.options.callbackUri);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.match(url.searchParams.get("ext_agent_host_id"), /^urn:uuid:/);
  const result = await f.auth.callback(params);
  assert.equal(result.connected, true);
  assert.equal(result.requiresLogin, false);
  assert.equal(result.clientId, chosenClient);
  assert.equal(result.subject, "subject-1");
  assert.equal(result.activeAccountId, result.id);
  assert.equal((await f.auth.accounts()).accounts.length, 1);
  for (const value of [result, await f.auth.accounts()]) {
    const text = JSON.stringify(value);
    assert.equal(text.includes("initial-access"), false);
    assert.equal(text.includes("initial-refresh"), false);
    assert.equal(/id_token|access_token|refresh_token/.test(text), false);
  }
  const exchange = f.calls.find((call) =>
    call.url.endsWith("/api/accounts/oauth/token"),
  );
  const exchanged = new URLSearchParams(exchange.options.body);
  assert.equal(exchanged.get("client_id"), chosenClient);
  assert.equal(exchanged.get("redirect_uri"), f.options.callbackUri);
  assert.equal(
    createHash("sha256")
      .update(exchanged.get("code_verifier"))
      .digest("base64url"),
    url.searchParams.get("code_challenge"),
  );
  assert.equal((await stat(f.storageDir)).mode & 0o777, 0o700);
  assert.equal(
    (await stat(join(f.storageDir, "chatgpt-accounts.json"))).mode & 0o777,
    0o600,
  );
  const reopened = createChatGPTAuth(f.options);
  assert.equal((await reopened.status()).activeAccountId, result.id);
  assert.equal(await reopened.accessToken(), "initial-access");
  const next = new URL((await reopened.start()).url);
  assert.equal(next.searchParams.get("client_id"), chosenClient);
  assert.equal(
    next.searchParams.get("ext_agent_host_id"),
    url.searchParams.get("ext_agent_host_id"),
  );
  assert.equal(next.searchParams.has("agent_name_hint"), false);
});

test("错误、重复、过期 state 和拒绝授权不会启动 token 交换或替换原账户", async (t) => {
  const f = await fixture(t);
  const first = await f.prepare();
  const incorrect = new URLSearchParams(first.params);
  incorrect.set("state", "错误的状态");
  await assert.rejects(f.auth.callback(incorrect), /登录校验/);
  assert.equal(f.calls.length, 0);
  const success = await f.auth.callback(first.params);
  await assert.rejects(f.auth.callback(first.params), /过期/);
  const repeated = await f.prepare();
  repeated.params.append("state", repeated.params.get("state"));
  await assert.rejects(f.auth.callback(repeated.params), /登录校验/);
  const denied = await f.prepare({ newAccount: true });
  denied.params.set("error", "access_denied");
  const before = f.calls.length;
  await assert.rejects(f.auth.callback(denied.params), /未完成/);
  assert.equal(f.calls.length, before);
  assert.equal((await f.auth.status()).id, success.id);
  const expired = await f.prepare();
  f.advance(11 * 60_000);
  await assert.rejects(f.auth.callback(expired.params), /过期/);
  assert.equal((await f.auth.status()).id, success.id);
});

test("JWT 签名、issuer、audience、nonce、expiry 和 scope 分别验证", async (t) => {
  const invalidCases = [
    { name: "signature", options: { key: wrongKey } },
    {
      name: "issuer",
      options: { claims: { iss: "https://attacker.example" } },
    },
    { name: "audience", options: { claims: { aud: "another-client" } } },
    { name: "nonce", options: { claims: { nonce: "another-nonce" } } },
    { name: "expiry", options: { claims: { exp: 100 } } },
    { name: "scope", options: { token: { scope: "openid profile email" } } },
  ];
  for (const item of invalidCases)
    await t.test(item.name, async (t) => {
      const f = await fixture(t);
      const { params } = await f.prepare(item.options);
      await assert.rejects(f.auth.callback(params), /身份|权限/);
      assert.equal((await f.auth.status()).connected, false);
      assert.equal((await f.auth.accounts()).accounts.length, 0);
    });
});

test("重登必须匹配已选身份，多个注册分开保存和切换", async (t) => {
  const f = await fixture(t);
  const one = await f.prepare();
  const accountOne = await f.auth.callback(one.params);
  const mismatch = await f.prepare({ subject: "different-subject" });
  await assert.rejects(f.auth.callback(mismatch.params), /账户.*不一致/);
  assert.equal((await f.auth.status()).id, accountOne.id);
  const changedClient = await f.prepare();
  changedClient.params.set("client_id", "oaiapp_attacker");
  await assert.rejects(f.auth.callback(changedClient.params), /注册校验/);
  const two = await f.prepare({
    newAccount: true,
    clientId: "oaiapp_other-workspace",
    subject: "subject-1",
  });
  const accountTwo = await f.auth.callback(two.params);
  assert.notEqual(accountOne.id, accountTwo.id);
  assert.equal((await f.auth.accounts()).accounts.length, 2);
  assert.equal((await f.auth.select(accountOne.id)).clientId, "oaiapp_test");
  assert.equal(
    (await f.auth.select(accountTwo.id)).clientId,
    "oaiapp_other-workspace",
  );
  await assert.rejects(f.auth.select("missing"), /找不到/);
});

test("并发请求串行刷新一次，原子替换 rotating refresh token 并能重启恢复", async (t) => {
  const f = await fixture(t);
  const one = await f.prepare();
  await f.auth.callback(one.params);
  f.advance(3590_000);
  f.setRefresh(async (body) => {
    assert.equal(body.get("refresh_token"), "initial-refresh");
    assert.equal(body.get("client_id"), "oaiapp_test");
    assert.equal(body.has("scope"), false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    return {
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      token_type: "Bearer",
      expires_in: 3600,
    };
  });
  const results = await Promise.all([
    f.auth.accessToken(),
    f.auth.accessToken(),
    f.auth.accessToken(),
  ]);
  assert.equal(
    results.every((token) => token === "rotated-access"),
    true,
  );
  assert.equal(f.refreshCount, 1);
  const reopened = createChatGPTAuth(f.options);
  assert.equal(await reopened.accessToken(), "rotated-access");
  const data = JSON.parse(
    await readFile(join(f.storageDir, "chatgpt-accounts.json"), "utf8"),
  );
  assert.equal(data.accounts[0].refresh_token === "rotated-refresh", true);
  assert.equal(
    data.accounts[0].scopes.includes("chatgpt.tokens.use.direct"),
    true,
  );
});

test("失效刷新不泄漏上游错误，注销撤销远端会话并清除本地 token 保留注册", async (t) => {
  const f = await fixture(t);
  const one = await f.prepare();
  await f.auth.callback(one.params);
  f.advance(3590_000);
  f.setRefresh(async () =>
    Response.json(
      {
        error: "invalid_grant",
        error_description: "SECRET upstream diagnostic",
      },
      { status: 400 },
    ),
  );
  await assert.rejects(
    f.auth.accessToken(),
    (error) => error.status === 401 && !error.message.includes("SECRET"),
  );
  assert.equal((await f.auth.status()).requiresLogin, true);
  const again = await f.prepare();
  await f.auth.callback(again.params);
  const result = await f.auth.disconnect();
  assert.equal(result.revoked, true);
  assert.equal(f.revokeCount, 1);
  assert.equal((await f.auth.status()).connected, false);
  const data = JSON.parse(
    await readFile(join(f.storageDir, "chatgpt-accounts.json"), "utf8"),
  );
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].client_id, "oaiapp_test");
  assert.equal(
    Object.keys(data.accounts[0]).some((key) => key.endsWith("_token")),
    false,
  );
  const url = new URL((await f.auth.start()).url);
  assert.equal(url.searchParams.get("client_id"), "oaiapp_test");
  assert.equal(url.searchParams.has("id_token_hint"), false);
});

test("远端注销失败也清本地凭据，并明确告知未确认撤销", async (t) => {
  const f = await fixture(t);
  const one = await f.prepare();
  await f.auth.callback(one.params);
  f.setRevoke(503);
  const result = await f.auth.disconnect();
  assert.equal(result.revoked, false);
  assert.equal(result.requiresManualRevocation, true);
  assert.equal(f.revokeCount, 2);
  assert.equal((await f.auth.status()).connected, false);
  assert.match((await f.auth.status()).lastError, /远端撤销/);
  await assert.rejects(f.auth.accessToken(), /先.*授权/);
});

test("未能持久保存新授权时，原有账户保持活动且新账户不进入摘要", async (t) => {
  const f = await fixture(t);
  const one = await f.prepare();
  const original = await f.auth.callback(one.params);
  const two = await f.prepare({
    newAccount: true,
    clientId: "oaiapp_not-saved",
    subject: "subject-2",
  });
  const path = join(f.storageDir, "chatgpt-accounts.json");
  await rename(path, `${path}.preserved`);
  await mkdir(path);
  await assert.rejects(f.auth.callback(two.params), /无法保存/);
  assert.equal((await f.auth.status()).id, original.id);
  assert.equal((await f.auth.accounts()).accounts.length, 1);
});
