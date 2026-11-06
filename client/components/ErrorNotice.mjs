import { createElement as h, useContext, useState } from "react";
import { UserContext } from "../user-context.mjs";
import { errorNoticeModel } from "../error-presentation.mjs";

export const OPEN_PANEL_EVENT = "yohaku:open-panel";

export default function ErrorNotice({ error, className = "" }) {
  const user = useContext(UserContext);
  const [copied, setCopied] = useState(false);
  const model = errorNoticeModel(error, { isAdmin: Boolean(user?.isAdmin) });
  if (!model) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(model.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // The code stays on screen for manual copying.
    }
  };
  return h("div", { className: `error-notice ${className}`.trim(), role: "alert" },
    h("span", { className: "error-notice-message" }, model.message),
    model.code && h("button", { type: "button", className: "error-notice-code", onClick: copy, "aria-label": `复制错误代码 ${model.code}` },
      copied ? "已复制" : `错误代码 ${model.code}`),
    model.action && h("button", {
      type: "button", className: "text-button error-notice-action",
      onClick: () => window.dispatchEvent(new CustomEvent(OPEN_PANEL_EVENT, { detail: "settings" })),
    }, model.actionLabel));
}
