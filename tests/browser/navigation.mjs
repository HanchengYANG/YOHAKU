// Sidebar helpers shared by the browser suites. On phones the sidebar is a
// drawer that must be opened first; the backdrop button exists only while it is open.
import { expect } from "@playwright/test";

export async function openShelf(page) {
  // The sidebar mounts once the session has loaded; checking visibility before
  // that would skip opening the drawer on phones.
  await page.locator("#bookshelf").waitFor({ state: "attached" });
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

export async function openAddText(page) {
  await openShelf(page);
  await page.getByRole("button", { name: "添加", exact: true }).click();
  await page.getByRole("tab", { name: "粘贴文字", exact: true }).click();
}
