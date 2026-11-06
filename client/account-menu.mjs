// Items of the account menu at the bottom of the sidebar, in display order.
// AI 设置 and 角色配置 stay separate until step 5 merges them into one AI page.
export const isAdminUser = (user) => user?.role === "admin" || user?.isAdmin === true;

export function accountMenuItems(user) {
  return [
    ...(isAdminUser(user) ? [
      { id: "settings", label: "AI 设置", panel: "settings" },
      { id: "roles", label: "角色配置", panel: "roles" },
      { id: "errors", label: "错误记录", panel: "errors" },
      { id: "invite", label: "邀请朋友" },
    ] : []),
    { id: "logout", label: "退出" },
  ];
}
