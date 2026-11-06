import test from "node:test";
import assert from "node:assert/strict";
import { accountMenuItems, isAdminUser } from "../client/account-menu.mjs";

test("管理员菜单依次为 AI 设置、角色配置、错误记录、邀请朋友、退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: true }).map((item) => item.label),
    ["AI 设置", "角色配置", "错误记录", "邀请朋友", "退出"]);
  assert.deepEqual(accountMenuItems({ role: "admin" }).filter((item) => item.panel).map((item) => item.panel),
    ["settings", "roles", "errors"]);
});

test("普通账号只有退出", () => {
  assert.deepEqual(accountMenuItems({ isAdmin: false }).map((item) => item.label), ["退出"]);
  assert.deepEqual(accountMenuItems(null).map((item) => item.label), ["退出"]);
  assert.equal(isAdminUser({ role: "member" }), false);
});
