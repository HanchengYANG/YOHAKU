import { normalizeReasoning } from "../../shared/ai-roles.mjs";

const fail = (message) => Object.assign(new Error(message), { status: 400, expose: true });

// Only publish controls that have a defined wire mapping in the adapter.
export function effortOptions(values) {
  const efforts = [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === "string" && /^[a-z][a-z0-9_-]{0,30}$/.test(value)))];
  return efforts.length ? { efforts } : undefined;
}

export function validateModelReasoning(model, input) {
  const reasoning = normalizeReasoning(input);
  if (!reasoning) return undefined;
  if (reasoning.enabled !== undefined) throw fail("此连接不支持单独的思考开关，请使用模型支持的推理强度；none 表示关闭。");
  if (reasoning.budgetTokens !== undefined) throw fail("此连接尚未确认支持思考 token 预算，请使用默认预算。");
  if (!model?.reasoningOptions?.efforts?.includes(reasoning.effort))
    throw fail("所选模型不支持此推理强度，请刷新模型目录后选择。");
  return reasoning;
}
