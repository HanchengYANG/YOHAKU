// Sidebar helpers shared by the browser suites. On phones the sidebar is a
// drawer that must be opened first; the backdrop button exists only while it is open.
import { expect } from "@playwright/test";

export async function openShelf(page) {
  const toggle = page.getByRole("button", { name: "打开书架", exact: true });
  if (!(await toggle.isVisible())) return;
  if (await page.getByRole("button", { name: "关闭书架", exact: true }).isVisible()) return;
  await toggle.click();
}

export async function openAccountMenu(page) {
  await openShelf(page);
  const trigger = page.getByRole("button", { name: /^账号菜单/ });
  if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
  await expect(page.getByRole("button", { name: "退出", exact: true })).toBeVisible();
}
