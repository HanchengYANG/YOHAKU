import test from "node:test";
import assert from "node:assert/strict";
import { createInstallChoices, installChoiceCookie, installChoiceScope } from "../client/pwa-choice.mjs";

function fixture() {
  let clock = 1_800_000_000_000;
  let cookie = "";
  let legacy = false;
  const writes = [];
  const session = (id = "reader-a", startedAt = clock) => ({
    user: { id }, loginSession: { startedAt, expiresAt: clock + 7 * 24 * 60 * 60_000 },
  });
  const options = {
    getCookie: () => cookie,
    setCookie: value => { writes.push(value); cookie = value.includes("Max-Age=0") ? "" : value.split(";")[0]; },
    readLegacy: () => legacy,
    removeLegacy: () => { legacy = false; },
    secure: true,
    now: () => clock,
  };
  return {
    options, writes, session,
    advance: value => { clock += value; },
    setLegacy: () => { legacy = true; },
    get cookie() { return cookie; },
    get legacy() { return legacy; },
    create: () => createInstallChoices(options),
  };
}

test("登录尚在加载或缺少期限时不显示安装提示", () => {
  const f = fixture(), store = f.create();
  assert.deepEqual(store.sync(null), { scope: null, decided: false });
  assert.equal(installChoiceScope({ user: { id: "a" } }), null);
  assert.equal(f.writes.length, 0);
});

for (const choice of ["later", "ios", "accepted", "dismissed"]) {
  test(`${choice} 选择在刷新和重开页面后仍有效，期限不因刷新延长`, () => {
    const f = fixture(), store = f.create(), session = f.session();
    assert.equal(store.sync(session).decided, false);
    assert.equal(store.choose(choice).decided, true);
    assert.match(f.writes[0], new RegExp(`^${installChoiceCookie}=`));
    assert.match(f.writes[0], /Path=\/; SameSite=Strict/);
    assert.match(f.writes[0], /; Secure$/);
    assert.ok(f.writes[0].includes(`Expires=${new Date(session.loginSession.expiresAt).toUTCString()}`));
    assert.doesNotMatch(f.writes[0], /Max-Age/);
    f.advance(60_000);
    assert.equal(store.sync(session).decided, true);
    assert.equal(f.create().sync(session).decided, true);
    assert.equal(f.writes.length, 1);
  });
}

test("访客使用浏览器会话Cookie，登录时承接访客选择并对齐服务端期限", () => {
  const f = fixture(), store = f.create();
  store.sync({ user: null });
  store.choose("later");
  assert.doesNotMatch(f.writes[0], /Expires|Max-Age/);
  assert.equal(f.create().sync({ user: null }).decided, true);
  const session = f.session();
  assert.equal(store.sync(session).decided, true);
  assert.equal(f.writes.length, 2);
  assert.ok(f.writes[1].includes(`Expires=${new Date(session.loginSession.expiresAt).toUTCString()}`));
  assert.equal(store.sync(session).decided, true);
  assert.equal(f.writes.length, 2);
});

test("退出、到期、切换账号和同账号的新登录会话重新评估", () => {
  for (const next of ["logout", "expiry", "account", "session"]) {
    const f = fixture(), store = f.create(), session = f.session();
    store.sync(session); store.choose("later");
    if (next === "expiry") f.advance(7 * 24 * 60 * 60_000);
    const nextSession = next === "logout" ? { user: null } : next === "account" ? f.session("reader-b") : next === "session" ? f.session("reader-a", session.loginSession.startedAt + 1) : session;
    assert.equal(store.sync(nextSession).decided, false, next);
    assert.match(f.writes.at(-1), /Max-Age=0/);
  }
});

test("Cookie不可用时同一页面仍记住选择，切换账号后不会串用", () => {
  const f = fixture();
  const store = createInstallChoices({ ...f.options, getCookie: () => { throw new Error("blocked"); }, setCookie: () => { throw new Error("blocked"); } });
  const session = f.session();
  store.sync(session); store.choose("dismissed");
  assert.equal(store.sync(session).decided, true);
  assert.equal(store.sync(f.session("reader-b")).decided, false);
});

test("兼容旧iOS关闭记录并只迁移一次，之后的新会话可再次评估", () => {
  const f = fixture(), store = f.create();
  f.setLegacy();
  const session = f.session();
  assert.equal(store.sync(session).decided, true);
  assert.equal(f.legacy, false);
  assert.equal(f.writes.length, 1);
  assert.equal(store.sync({ user: null }).decided, false);
  assert.equal(store.sync(session).decided, false);
});

test("无效Cookie不会阻止新选择", () => {
  const f = fixture();
  const store = createInstallChoices({ ...f.options, getCookie: () => `${installChoiceCookie}=%broken` });
  store.sync(f.session());
  assert.equal(store.choose("later").decided, true);
});

test("切换账号后才返回的原生弹窗结果不会记到新账号", () => {
  const f = fixture(), store = f.create();
  const oldScope = store.sync(f.session()).scope;
  store.sync(f.session("reader-b"));
  assert.equal(store.choose("dismissed", oldScope).decided, false);
  assert.equal(f.writes.length, 0);
});
