export const ROLE_IDS = Object.freeze(["ocr", "annotation", "segmentation", "chat"]);

// Persist only explicit controls. Empty settings retain the provider default
// and remain compatible with checks/configuration written before this feature.
export function normalizeReasoning(input) {
  const fail = (message) => Object.assign(new Error(message), { status: 400, expose: true });
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input)) throw fail("推理设置格式无效。");
  if (Object.keys(input).some((key) => !["effort", "enabled", "budgetTokens"].includes(key)))
    throw fail("推理设置包含不支持的选项。");
  const result = {};
  if (input.effort !== undefined && input.effort !== "" && input.effort !== "default") {
    if (typeof input.effort !== "string" || !/^[a-z][a-z0-9_-]{0,30}$/.test(input.effort)) throw fail("请选择有效的推理强度。");
    result.effort = input.effort;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== "boolean") throw fail("请选择有效的思考模式。");
    result.enabled = input.enabled;
  }
  if (input.budgetTokens !== undefined) {
    if (!Number.isSafeInteger(input.budgetTokens) || input.budgetTokens < 1 || input.budgetTokens > 1000000)
      throw fail("思考预算需要是 1 至 1000000 之间的整数。");
    if (input.enabled === false) throw fail("关闭思考时不能设置思考预算。");
    result.budgetTokens = input.budgetTokens;
  }
  return Object.keys(result).length ? result : undefined;
}

export const reasoningKey = (input) => JSON.stringify(normalizeReasoning(input) || {});

export function requiredCapabilities(role, referenceImage = false) {
  if (role === "ocr") return ["json", "image"];
  if (role === "annotation") return referenceImage ? ["json", "image"] : ["json"];
  if (role === "segmentation") return ["json"];
  if (role === "chat") return ["streaming"];
  throw new Error("未知 AI 角色。");
}

// Checks belong to a credential/model pair, so a compatible earlier check can
// serve another role. Keep the date of each check when merging partial tests.
export function roleReport(reports, model, role, referenceImage = false, reasoning) {
  const key = reasoningKey(reasoning);
  const report = reports?.find((item) => item.model === model && reasoningKey(item.reasoning) === key);
  if (!report) return null;
  const required = requiredCapabilities(role, referenceImage);
  const checks = Object.fromEntries(required.filter((name) => report.checks?.[name])
    .map((name) => [name, { ...report.checks[name], checkedAt: report.checks[name].checkedAt || report.checkedAt }]));
  return { model, role, ...(normalizeReasoning(reasoning) ? { reasoning: normalizeReasoning(reasoning) } : {}), checkedAt: report.checkedAt, checks,
    passed: required.every((name) => checks[name]?.state === "supported") };
}
