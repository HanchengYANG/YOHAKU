import test from "node:test";
import assert from "node:assert/strict";
import { accountMenuItems, isAdminUser } from "../client/account-menu.mjs";

test("管理员菜单依次为 AI、错误记录、邀请朋友、退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: true }).map((item) => item.label),
    ["AI", "错误记录", "邀请朋友", "退出"]);
  assert.deepEqual(accountMenuItems({ role: "admin" }).filter((item) => item.panel).map((item) => item.panel),
    ["ai", "errors"]);
});

test("普通账号只有退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: false }).map((item) => item.label), ["退出"]);
  assert.deepEqual(accountMenuItems(null).map((item) => item.label), ["退出"]);
  assert.equal(isAdminUser({ role: "member" }), false);
});

test("可安装时在退出前提供安装为 App", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: false }, { installable: true }).map((item) => item.label), ["安装为 App", "退出"]);
  assert.deepEqual(accountMenuItems({ isAdmin: true }, { installable: true }).map((item) => item.id),
    ["ai", "errors", "invite", "install", "logout"]);
});
