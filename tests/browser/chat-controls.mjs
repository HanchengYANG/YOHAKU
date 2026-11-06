export async function openDocumentChat(page) {
  const panel = page.getByLabel("原文 AI 讨论", {exact:true});
  await panel.waitFor({state:"attached"});
  if (await panel.isVisible()) return;
  const handle = page.getByRole("button", {name:"上划恢复对话",exact:true});
  if (await handle.isVisible()) await handle.click();
  else await page.getByRole("button", {name:/^对话/}).click();
}
