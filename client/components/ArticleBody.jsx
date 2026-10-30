import { useEffect, useRef, useMemo } from "react";
import { splitRubyDisplay } from "../../shared/ruby-display.mjs";
import { normalizeBodyHtml, bodyText } from "../../shared/article-html.mjs";


function displayBodyHtml(html) {
  const container = window.document.createElement("div");
  container.innerHTML = normalizeBodyHtml(html);
  container.querySelectorAll("p").forEach((node) => {
    node.classList.add("text-line");
    if (!node.textContent) { node.classList.add("empty-line"); node.append(window.document.createElement("br")); }
    if (node.dataset.blockType === "heading") node.classList.add("text-heading");
    if (node.dataset.blockType === "list_item") node.classList.add("article-list-item");
  });
  container.querySelectorAll("ruby").forEach((ruby) => {
    const reading = ruby.querySelector("rt")?.textContent;
    const base = ruby.cloneNode(true);
    base.querySelectorAll("rt,rp").forEach((node) => node.remove());
    const parts = splitRubyDisplay(base.textContent, reading);
    const fragment = window.document.createDocumentFragment();
    let offset = 0;
    const slice = (start, end) => {
      const walker = window.document.createTreeWalker(base, NodeFilter.SHOW_TEXT);
      let node, position = 0, from, to;
      while ((node = walker.nextNode())) {
        const next = position + node.textContent.length;
        if (!from && start >= position && start < next) from = [node,start-position];
        if (end > position && end <= next) { to = [node,end-position]; break; }
        position = next;
      }
      if (!from || !to) return window.document.createTextNode("");
      const range = window.document.createRange(); range.setStart(...from); range.setEnd(...to);
      return range.cloneContents();
    };
    parts.forEach((part) => {
      const content = slice(offset, offset + part.text.length); offset += part.text.length;
      if (part.reading) {
        const next = window.document.createElement("ruby");
        next.dataset.origin = ruby.dataset.origin || "manual";
        next.append(content);
        const rt = window.document.createElement("rt"); rt.textContent = part.reading; next.append(rt);
        fragment.append(next);
      } else fragment.append(content);
    });
    const word = window.document.createElement("span");
    word.className = "ruby-word"; word.title = `${base.textContent}：${reading}`;
    word.append(fragment); ruby.replaceWith(word);
  });
  container.querySelectorAll("mark[data-qa-group-ids]").forEach((mark) => {
    const count = mark.dataset.qaGroupIds.split(/\s+/).filter(Boolean).length;
    if (count > 1) { mark.dataset.qaCount = count; mark.title = `此处关联 ${count} 个问答组`; }
  });
  return container.innerHTML;
}

// DOM offsets count only base characters, with one separator between paragraphs.
// The source/mark/ruby wrappers never contribute characters to a selection.
export function articleSelection(root, canonicalHtml) {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const paragraphNodes = [...root.querySelectorAll("p")];
  let offset = 0;
  const positions = new Map([[root, 0]]);
  const ends = new Map();
  const walk = (node) => {
    if (node.nodeType === 3) {
      positions.set(node, offset);
      offset += node.textContent.length;
      ends.set(node, offset);
      return;
    }
    if (node.nodeType !== 1 || node.matches("rt,rp")) return;
    positions.set(node, offset);
    if (node.matches("br")) { if (!node.closest("p.empty-line")) offset++; }
    else [...node.childNodes].forEach(walk);
    ends.set(node, offset);
  };
  paragraphNodes.forEach((paragraph, index) => { if (index) offset++; walk(paragraph); });
  ends.set(root, offset);
  const point = (node, childOffset) => {
    if (!positions.has(node)) return -1;
    if (node.nodeType === 3) return positions.get(node) + childOffset;
    const next = [...node.childNodes].slice(childOffset).find((child) => positions.has(child));
    return next ? positions.get(next) : ends.get(node);
  };
  const start = point(range.startContainer, range.startOffset);
  const end = point(range.endContainer, range.endOffset);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
  const text = bodyText(canonicalHtml).slice(start, end);
  if (!text.trim()) return null;
  const rect = range.getBoundingClientRect();
  return { start, end, text, rect: { left: rect.left, top: rect.top, bottom: rect.bottom } };
}

export default function ArticleBody({ html, showRuby = true, fontSize = 26, onSelection, onSource, onGroup, activeSourceId, className = "" }) {
  const root = useRef(null);
  const display = useMemo(() => displayBodyHtml(html), [html]);
  useEffect(() => {
    root.current?.querySelectorAll("[data-source-image-id]").forEach((node) => {
      node.classList.toggle("active-source", node.dataset.sourceImageId === activeSourceId);
    });
  }, [html, activeSourceId]);
  const choose = () => { const value = articleSelection(root.current, html); if (value) onSelection?.(value); };
  useEffect(() => {
    if (!onSelection) return;
    const changed = () => { const value = articleSelection(root.current, html); if (value) onSelection(value); };
    window.document.addEventListener("selectionchange", changed);
    return () => window.document.removeEventListener("selectionchange", changed);
  }, [html, onSelection]);
  return <div ref={root} lang="ja" style={{ fontSize }}
    className={`japanese-text horizontal article-body ${showRuby ? "" : "ruby-hidden"} ${className}`}
    onMouseUp={choose} onTouchEnd={() => setTimeout(choose, 50)} onKeyUp={choose}
    onClick={(event) => {
      const group = event.target.closest("[data-qa-group-ids]");
      if (group && window.getSelection()?.isCollapsed) onGroup?.(group.dataset.qaGroupIds.split(/\s+/).filter(Boolean));
      const source = event.target.closest("[data-source-image-id]");
      if (source) onSource?.(source.dataset.sourceImageId);
    }}
    dangerouslySetInnerHTML={{ __html: display }} />;
}
