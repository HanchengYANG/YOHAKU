// Items of the account menu at the bottom of the sidebar, in display order.
export const isAdminUser = (user) => user?.role === "admin" || user?.isAdmin === true;

export function accountMenuItems(user, { installable = false } = {}) {
  return [
    ...(isAdminUser(user) ? [
      { id: "ai", label: "AI", panel: "ai" },
      { id: "errors", label: "错误记录", panel: "errors" },
      { id: "invite", label: "邀请朋友" },
    ] : []),
    ...(installable ? [{ id: "install", label: "安装为 App" }] : []),
    { id: "logout", label: "退出" },
  ];
}
