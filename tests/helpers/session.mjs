import assert from "node:assert/strict";

const cookies = new Map();
const credentials = Object.freeze({
  username: "test_owner",
  password: "fixture-only-password",
});

export function cookieFromResponse(response) {
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith("yohaku_session="));
  assert.ok(cookie, "真实账户端点必须设置会话Cookie");
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
  return cookie.split(";", 1)[0];
}

export function sessionHeaders(url) {
  const cookie = cookies.get(new URL(url).origin);
  return cookie ? { Cookie: cookie } : {};
}

export async function ensureSession(url, input = credentials) {
  const current = await fetch(`${url}/api/session`, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(current.status, 200, "网站必须提供真实会话状态接口");
  const session = await current.json();
  const response = await fetch(
    `${url}${session.needsSetup ? "/api/accounts/setup" : "/api/session/login"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(10000),
    },
  );
  assert.equal(
    response.status,
    session.needsSetup ? 201 : 200,
    "测试应通过真实setup/login登录，不能绕过认证",
  );
  const cookie = cookieFromResponse(response);
  const result = await response.json();
  assert.equal(result.user.username, input.username);
  cookies.set(new URL(url).origin, cookie);
  return { cookie, user: result.user };
}
