// Real settings and role routes against isolated OAuth/model doubles.
import { test, expect } from "@playwright/test";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { ensureOwnerSession } from "./session.mjs";

test("角色页紧凑配置，保存时自动测试且仅显示失败角色与能力", async ({ page }, info) => {
  await ensureOwnerSession(page.request);
  await page.request.post("/api/ai/login", { data: { providerId: "openai" } });
  await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code");
  const state = async (providerId = "openai") => (await (await page.request.get(`/api/ai/status?providerId=${providerId}`)).json());
  const rolesState = async () => (await (await page.request.get("/api/ai/roles")).json());
  const originalOpenAI = await state();
  const original = await rolesState();
  // Production deliberately offers no downgrade route. Snapshot only the
  // isolated browser database so this spec does not migrate other specs.
  const databasePath = fileURLToPath(new URL("../../artifacts/ai-e2e-data/yohaku.sqlite", import.meta.url));
  const snapshotDatabase = new DatabaseSync(databasePath);
  const originalRow = snapshotDatabase.prepare("SELECT * FROM ai_role_configurations LIMIT 1").get();
  snapshotDatabase.close();
  expect(originalOpenAI.connected).toBe(true);
  const tests = [], saves = [];
  let authorizations = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/ai/login" || url.hostname === "auth.openai.com") authorizations++;
    if (url.pathname === "/api/ai/models/test") tests.push(request.postDataJSON());
    if (url.pathname === "/api/ai/roles" && request.method() === "PUT") saves.push(request.postDataJSON());
  });
  const open = async (name) => {
    const drawer = page.getByRole("button", { name: "打开书架", exact: true });
    if (await drawer.isVisible()) await drawer.click();
    await page.getByRole("button", { name, exact: true }).click();
  };
  const save = page.getByRole("button", { name: "保存角色配置", exact: true });
  try {
    await page.goto("/");
    await open("AI 设置");
    const providers = page.getByRole("combobox", { name: "AI 提供方", exact: true });
    await providers.selectOption("api_base");
    const form = page.getByRole("form", { name: "iliad codix 配置" });
    await expect(form).toContainText("服务地址：https://iliad.codix.scw.eu/v1");
    await expect(page.getByRole("button", { name: "保存提供方", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /测试.*模型/ })).toHaveCount(0);
    await expect(page.getByRole("combobox")).toHaveCount(1);
    const key = page.getByLabel("API key", { exact: true });
    await expect(key).toHaveAttribute("type", "password");
    await key.fill(`fixture-only-roles-key-${info.project.name}`);
    await page.getByRole("button", { name: "保存 API key", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("API key 已保存");
    await expect(key).toHaveValue("");
    expect(tests).toHaveLength(0);
    expect((await rolesState()).version).toBe(original.version);
    await providers.selectOption("openai");
    await expect(page.getByText("已授权", { exact: true })).toBeVisible();
    expect((await state()).activeAccountId).toBe(originalOpenAI.activeAccountId);
    await open("角色配置");
    await expect(page.getByRole("heading", { name: "角色配置", exact: true })).toBeVisible();
    await expect(save).toHaveCount(1);
    for (const role of ["OCR", "注音", "分句", "问答"]) {
      await page.getByRole("combobox", { name: `${role}提供方`, exact: true }).selectOption("api_base");
      await page.getByRole("combobox", { name: `${role}模型`, exact: true }).selectOption("codiX-agent");
    }
    await page.getByLabel("参考原图", { exact: false }).uncheck();
    await expect(page.getByRole("button", { name: /^测试/ })).toHaveCount(0);
    await expect(page.getByLabel(/测试结果/)).toHaveCount(0);
    await expect(page.getByText(/最近测试|待测试：当前凭据/)).toHaveCount(0);
    await expect(save).toBeEnabled();
    expect(tests).toHaveLength(0);
    expect(saves).toHaveLength(0);
    await save.click();
    const ocr = page.getByRole("region", { name: "OCR角色", exact: true });
    const annotation = page.getByRole("region", { name: "注音角色", exact: true });
    await expect(ocr.getByRole("alert")).toContainText(/图片输入.*(?:不支持|未通过)/);
    await expect(page.getByRole("region", { name: "分句角色", exact: true }).getByRole("alert")).toHaveCount(0);
    expect((await rolesState()).version).toBe(original.version);
    expect(saves).toHaveLength(0);
    await expect(save).toBeEnabled();
    await page.getByLabel("参考原图", { exact: false }).check();
    await save.click();
    await expect(annotation.getByRole("alert")).toContainText(/图片输入.*(?:不支持|未通过)/);
    expect(saves).toHaveLength(0);
    await page.screenshot({ path: `artifacts/role-settings-failure-${info.project.name}.png`, fullPage: true });
    await page.getByLabel("参考原图", { exact: false }).uncheck();
    await page.getByRole("combobox", { name: "OCR提供方", exact: true }).selectOption("openai");
    await expect(save).toBeEnabled();
    const successfulAttempt = tests.length;
    await save.click();
    await expect(page.getByRole("status")).toContainText("角色配置已保存");
    expect(tests.slice(successfulAttempt).map(({ role }) => role)).toEqual(["ocr", "annotation", "chat"]);
    expect(tests.slice(successfulAttempt).filter(({ providerId }) => providerId === "api_base")
      .every(({ referenceImage }) => !referenceImage)).toBe(true);
    const applied = await rolesState();
    expect(applied.roles.ocr.providerId).toBe("openai");
    expect(applied.roles.segmentation).toEqual({ providerId: "api_base", model: "codiX-agent" });
    expect(applied.annotationReferenceImage).toBe(false);
    expect(applied.enabled).toBe(true);
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.getByLabel(/测试结果/)).toHaveCount(0);
    const firstRow = await ocr.boundingBox(), saveBounds = await save.boundingBox();
    expect(firstRow.y).toBeGreaterThanOrEqual(0);
    expect(saveBounds.y + saveBounds.height).toBeLessThanOrEqual(page.viewportSize().height);
    await page.screenshot({ path: `artifacts/role-settings-${info.project.name}.png`, fullPage: true });
    await page.getByRole("combobox", { name: "分句模型", exact: true }).selectOption("Qwen/Qwen3.6-35B");
    await expect(save).toBeEnabled();
    expect((await rolesState()).roles.segmentation.model).toBe("codiX-agent");
    await page.reload();
    await open("角色配置");
    await expect(page.getByRole("combobox", { name: "分句模型", exact: true })).toHaveValue("codiX-agent");
    await expect(page.getByLabel(/测试结果/)).toHaveCount(0);
    await page.getByRole("region", { name: "分句角色", exact: true }).getByRole("button", { name: "刷新模型目录", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("共 3 个模型");
    // A new credential is automatically tested on save, without a manual test UI.
    await page.request.put("/api/ai/configuration", {
      data: { providerId: "api_base", apiKey: `fixture-only-roles-replacement-${info.project.name}` },
    });
    const replacementAttempt = tests.length;
    await save.click();
    await expect(page.getByRole("status")).toContainText("角色配置已保存");
    expect(tests.slice(replacementAttempt).map(({ role }) => role)).toEqual(["ocr", "annotation", "chat"]);
    const replacementApplied = await rolesState();
    expect(replacementApplied.version).toBe(applied.version + 1);
    // Detect a stale page before sending any model tests or partial role update.
    const external = await page.request.put("/api/ai/roles", { data: {
      version: replacementApplied.version, roles: replacementApplied.roles,
      annotationReferenceImage: replacementApplied.annotationReferenceImage,
    } });
    expect(external.ok()).toBe(true);
    const testsBeforeConflict = tests.length, savesBeforeConflict = saves.length;
    await save.click();
    await expect(page.getByRole("alert")).toContainText(/已更新|版本/);
    expect(tests).toHaveLength(testsBeforeConflict);
    expect(saves).toHaveLength(savesBeforeConflict);
    expect(authorizations).toBe(0);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  } finally {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
      database.prepare("DELETE FROM ai_role_configurations").run();
      if (originalRow) database.prepare("INSERT INTO ai_role_configurations(owner_id,version,configuration_json,updated_at) VALUES(?,?,?,?)")
        .run(originalRow.owner_id, originalRow.version, originalRow.configuration_json, originalRow.updated_at);
      database.exec("COMMIT");
    } finally { database.close(); }
    await page.request.post("/api/ai/logout", { data: { providerId: "api_base" } });
  }
});

test("角色推理设置按模型提供，保存测试使用相同参数且不同强度不共用结果", async ({ page }, info) => {
  await ensureOwnerSession(page.request);
  await page.request.post("/api/ai/login", { data: { providerId: "openai" } });
  await page.request.get("/auth/callback?state=ui-test-state&code=ui-test-code");
  const databasePath = fileURLToPath(new URL("../../artifacts/ai-e2e-data/yohaku.sqlite", import.meta.url));
  const originalDatabase = new DatabaseSync(databasePath);
  const originalRow = originalDatabase.prepare("SELECT * FROM ai_role_configurations LIMIT 1").get();
  originalDatabase.close();
  const tests = [], saves = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/ai/models/test") tests.push(request.postDataJSON());
    if (url.pathname === "/api/ai/roles" && request.method() === "PUT") saves.push(request.postDataJSON());
  });
  const row = (name) => page.getByRole("region", { name: `${name}角色`, exact: true });
  const openRoles = async () => {
    const drawer = page.getByRole("button", { name: "打开书架", exact: true });
    if (await drawer.isVisible()) await drawer.click();
    await page.getByRole("button", { name: "角色配置", exact: true }).click();
  };
  const advanced = (name) => row(name).locator("details");
  const openAdvanced = (name) => advanced(name).locator("summary").click();
  const save = page.getByRole("button", { name: "保存角色配置", exact: true });
  try {
    await page.goto("/");
    await openRoles();
    for (const name of ["OCR", "注音", "分句", "问答"]) {
      await page.getByRole("combobox", { name: `${name}提供方`, exact: true }).selectOption("openai");
      await page.getByRole("combobox", { name: `${name}模型`, exact: true }).selectOption("UI-REASONING-DOUBLE");
      await expect(advanced(name)).not.toHaveAttribute("open");
    }
    await openAdvanced("OCR");
    await page.getByLabel("OCR推理强度", { exact: true }).selectOption("high");
    await page.getByLabel("OCR推理开关", { exact: true }).selectOption("enabled");
    await page.getByLabel("OCR推理预算", { exact: true }).fill("2048");
    await openAdvanced("OCR");
    await openAdvanced("注音");
    await page.getByLabel("注音推理强度", { exact: true }).selectOption("low");
    await openAdvanced("注音");
    await openAdvanced("分句");
    await page.getByLabel("分句推理强度", { exact: true }).selectOption("high");
    await openAdvanced("分句");
    expect(tests).toHaveLength(0);
    await save.click();
    await expect(page.getByRole("status")).toContainText("角色配置已保存");
    expect(tests.map(({ role }) => role)).toEqual(["ocr", "annotation", "segmentation", "chat"]);
    expect(tests.find(({ role }) => role === "ocr").reasoning).toEqual({ effort: "high", enabled: true, budgetTokens: 2048 });
    expect(tests.find(({ role }) => role === "annotation").reasoning).toEqual({ effort: "low" });
    expect(tests.find(({ role }) => role === "segmentation").reasoning).toEqual({ effort: "high" });
    expect(tests.find(({ role }) => role === "chat").reasoning || {}).toEqual({});
    const saved = saves.at(-1);
    expect(saved.roles.ocr.reasoning).toEqual({ effort: "high", enabled: true, budgetTokens: 2048 });
    expect(saved.roles.annotation.reasoning).toEqual({ effort: "low" });
    expect(saved.roles.segmentation.reasoning).toEqual({ effort: "high" });
    expect(saved.roles.chat.reasoning).toBeUndefined();
    const first = await row("OCR").boundingBox(), last = await save.boundingBox();
    expect(first.y).toBeGreaterThanOrEqual(0);
    expect(last.y + last.height).toBeLessThanOrEqual(page.viewportSize().height);
    await page.screenshot({ path: `artifacts/role-reasoning-${info.project.name}.png`, fullPage: true });
    await page.reload();
    await openRoles();
    await expect(advanced("OCR")).not.toHaveAttribute("open");
    await openAdvanced("OCR");
    await expect(page.getByLabel("OCR推理强度", { exact: true })).toHaveValue("high");
    await expect(page.getByLabel("OCR推理开关", { exact: true })).toHaveValue("enabled");
    await expect(page.getByLabel("OCR推理预算", { exact: true })).toHaveValue("2048");
    await page.screenshot({ path: `artifacts/role-reasoning-expanded-${info.project.name}.png`, fullPage: true });
    const beforeInvalid = { tests: tests.length, saves: saves.length };
    await page.getByLabel("OCR推理预算", { exact: true }).fill("8193");
    await save.click();
    await expect(row("OCR").getByRole("alert")).toContainText(/预算|范围/);
    expect(tests).toHaveLength(beforeInvalid.tests);
    expect(saves).toHaveLength(beforeInvalid.saves);
    await row("OCR").getByRole("button", { name: "使用服务默认", exact: true }).click();
    await expect(page.getByLabel("OCR推理强度", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("OCR推理开关", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("OCR推理预算", { exact: true })).toHaveValue("");
    await page.getByLabel("OCR推理强度", { exact: true }).selectOption("medium");
    await page.getByRole("combobox", { name: "OCR模型", exact: true }).selectOption("UI-TEST-DOUBLE");
    await openAdvanced("OCR");
    await expect(page.getByLabel("OCR推理强度", { exact: true })).toHaveValue("");
    await expect(page.getByLabel("OCR推理开关", { exact: true })).toHaveCount(0);
    await expect(page.getByLabel("OCR推理预算", { exact: true })).toHaveCount(0);
    const width = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth }));
    expect(width.scroll).toBeLessThanOrEqual(width.viewport);
  } finally {
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
      database.prepare("DELETE FROM ai_role_configurations").run();
      if (originalRow) database.prepare("INSERT INTO ai_role_configurations(owner_id,version,configuration_json,updated_at) VALUES(?,?,?,?)")
        .run(originalRow.owner_id, originalRow.version, originalRow.configuration_json, originalRow.updated_at);
      database.exec("COMMIT");
    } finally { database.close(); }
  }
});
