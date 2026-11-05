import { createElement as h } from "react";
import { ROLE_NAMES } from "../../shared/ai-roles.mjs";

const providers = { openai: "OpenAI", api_base: "iliad codix" };
const tokenCount = (value) => Number.isSafeInteger(value) && value >= 0 ? `${value.toLocaleString("zh-CN")} tokens` : null;

export default function ExecutionDetails({ execution, detailId, label }) {
  if (!execution?.providerId || !execution?.model) return null;
  const role = ROLE_NAMES[execution.role] || label || "AI";
  const reasoning = execution.reasoningParameterSent === false ? "提供方默认" : execution.reasoningEffort || execution.reasoning?.effort;
  const usage = execution.usage || {};
  const facts = [
    ["推理强度", reasoning], ["单次输出上限", tokenCount(execution.maxOutputTokens)],
    ["输入用量", tokenCount(usage.inputTokens)], ["其中缓存命中", tokenCount(usage.cachedInputTokens)],
    ["输出用量", tokenCount(usage.outputTokens)], ["其中推理", tokenCount(usage.reasoningTokens)],
    ["总用量", tokenCount(usage.totalTokens)],
  ].filter(([, value]) => value);
  return h("details", { className: "ai-execution-details", "aria-label": `${label || role}执行来源`,
    ...(detailId ? { "data-chat-detail": detailId } : {}) },
  h("summary", null, "执行来源"),
  h("dl", null,
    h("dt", null, "角色"), h("dd", null, role),
    h("dt", null, "提供方"), h("dd", null, providers[execution.providerId] || execution.providerId),
    h("dt", null, "模型"), h("dd", null, execution.model),
    ...facts.flatMap(([name, value]) => [h("dt", { key: `${name}-label` }, name), h("dd", { key: `${name}-value` }, value)])));
}
