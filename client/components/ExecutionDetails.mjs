import { createElement as h } from "react";

const roles = { ocr: "OCR", annotation: "注音", segmentation: "分句", chat: "问答" };
const providers = { openai: "OpenAI", api_base: "iliad codix" };

export default function ExecutionDetails({ execution, detailId, label }) {
  if (!execution?.providerId || !execution?.model) return null;
  const role = roles[execution.role] || label || "AI";
  return h("details", { className: "ai-execution-details", "aria-label": `${label || role}执行来源`,
    ...(detailId ? { "data-chat-detail": detailId } : {}) },
  h("summary", null, "执行来源"),
  h("dl", null,
    h("dt", null, "角色"), h("dd", null, role),
    h("dt", null, "提供方"), h("dd", null, providers[execution.providerId] || execution.providerId),
    h("dt", null, "模型"), h("dd", null, execution.model),
    ...(execution.reasoning?.effort ? [h("dt", { key: "reasoning-label" }, "推理强度"), h("dd", { key: "reasoning-value" }, execution.reasoning.effort)] : [])));
}
