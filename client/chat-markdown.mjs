import { createElement } from "react";
import remarkGfm from "remark-gfm";

export function safeMarkdownUrl(value) {
  if (typeof value !== "string") return undefined;
  const url = value.trim();
  if (url.startsWith("#")) return url;
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol) ? url : undefined;
  } catch { return undefined; }
}

export const chatMarkdownOptions = {
  skipHtml: true,
  remarkPlugins: [remarkGfm],
  urlTransform: (url, key) => key === "href" ? safeMarkdownUrl(url) : undefined,
  components: {
    a: ({ href, children }) => href
      ? createElement("a", { href, ...(href.startsWith("#") ? {} : { target: "_blank", rel: "noopener noreferrer" }) }, children)
      : createElement("span", null, children),
    // Model answers can describe images without loading remote image resources.
    img: ({ alt }) => createElement("span", null, alt || ""),
    table: ({ children }) => createElement("div", { className: "chat-table-scroll" }, createElement("table", null, children)),
  },
};
