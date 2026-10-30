import { expect } from "@playwright/test";
import { bodyText, bodyRanges } from "../../shared/article-html.mjs";

// Browser ranges count UTF-16, and ruby readings are outside the article body.
export async function selectArticleText(page, quote, occurrence = 0) {
  const article = page.getByRole("article", { name: "日语原文", exact: true });
  await expect(article).toBeVisible();
  await article.evaluate((root, { quote, occurrence }) => {
    const entries = [];
    let text = "";
    const lines = [...root.querySelectorAll(".text-line")];
    lines.forEach((line, index) => {
      if (index) text += "\n";
      const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          return node.parentElement.closest("rt, rp") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      let node;
      while ((node = walker.nextNode())) {
        entries.push({ node, start: text.length, end: text.length + node.length });
        text += node.textContent;
      }
    });
    let from = -1;
    for (let i = 0; i <= occurrence; i++) from = text.indexOf(quote, from + 1);
    if (from < 0) throw new Error(`文章中找不到选区：${quote}`);
    const to = from + quote.length;
    const start = entries.find((entry) => entry.end > from);
    const end = entries.find((entry) => entry.end >= to);
    const range = document.createRange();
    range.setStart(start.node, from - start.start);
    range.setEnd(end.node, to - end.start);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    (root.querySelector(".article-body") || root).dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    (root.querySelector(".article-body") || root).dispatchEvent(new Event("touchend", { bubbles: true }));
    document.dispatchEvent(new Event("selectionchange"));
  }, { quote, occurrence });
}

export function selectionFor(document, quote) {
  const text = bodyText(document.bodyHtml);
  const start = text.indexOf(quote);
  if (start < 0) throw new Error(`找不到引用：${quote}`);
  const end = start + quote.length;
  return {
    start, end, text: quote, bodyHash: document.bodyHash,
    sentenceIds: bodyRanges(document.bodyHtml).sentences
      .filter((sentence) => sentence.start < end && sentence.end > start).map((sentence) => sentence.id),
  };
}
