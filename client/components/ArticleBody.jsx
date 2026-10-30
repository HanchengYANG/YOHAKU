import { useEffect, useLayoutEffect, useRef, useMemo, useState } from "react";
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
      let position = 0;
      const copy = (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          const from = position; position += node.textContent.length;
          const text = node.textContent.slice(Math.max(0,start-from), Math.max(0,Math.min(position,end)-from));
          return text ? window.document.createTextNode(text) : null;
        }
        const clone = node.cloneNode(false);
        node.childNodes.forEach((child) => { const part = copy(child); if (part) clone.append(part); });
        return clone.childNodes.length ? clone : null;
      };
      // A Range wholly inside one text node drops its ancestor metadata.
      // Clone the wrappers too, even when only part of a ruby word is shown.
      const result = window.document.createDocumentFragment();
      base.childNodes.forEach((node) => { const part = copy(node); if (part) result.append(part); });
      return result;
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
  const accessibleGroups = new Set();
  container.querySelectorAll("mark[data-qa-group-ids]").forEach((mark) => {
    const count = mark.dataset.qaGroupIds.split(/\s+/).filter(Boolean).length;
    const key = mark.dataset.qaGroupIds.split(/\s+/).sort().join(" ");
    mark.title = `查看此处关联的 ${count} 个问答组`;
    if (!accessibleGroups.has(key)) {
      accessibleGroups.add(key);
      mark.tabIndex = 0;
      mark.setAttribute("role", "button");
      mark.setAttribute("aria-label", `查看关联记录：${mark.textContent}`);
    }
  });
  return container.innerHTML;
}

// Stored metadata wraps ruby base text, while rt is its sibling. Measure the
// displayed boxes together so backgrounds include the complete pronunciation
// without adding padding, changing line breaks, or touching selection offsets.
function decorationRects(elements, origin, fontSize) {
  const lines = [];
  elements.forEach((element) => {
    const annotation = element.closest("ruby")?.querySelector("rt");
    const reading = annotation && getComputedStyle(annotation).visibility !== "hidden" ? annotation.getBoundingClientRect() : null;
    [...element.getClientRects()].forEach((box) => {
      if (!box.width || !box.height) return;
      const rect = {
        left: box.left - origin.left,
        right: box.right - origin.left,
        top: box.top - origin.top - fontSize * .58,
        bottom: box.bottom - origin.top + fontSize * .1,
      };
      if (reading?.width && reading.bottom >= box.top - fontSize && reading.top < box.bottom) {
        rect.left = Math.min(rect.left, reading.left - origin.left);
        rect.right = Math.max(rect.right, reading.right - origin.left);
        rect.top = Math.min(rect.top, reading.top - origin.top - 2);
      }
      const line = lines.find((item) => Math.abs(item.bottom - rect.bottom) < fontSize * .2);
      if (line) {
        line.top = Math.min(line.top, rect.top);
        line.bottom = Math.max(line.bottom, rect.bottom);
        line.ranges.push(rect);
      } else lines.push({ top: rect.top, bottom: rect.bottom, ranges: [rect] });
    });
  });
  return lines.flatMap((line) => {
    const merged = [];
    line.ranges.sort((a,b) => a.left - b.left).forEach((rect) => {
      const previous = merged.at(-1);
      if (previous && rect.left <= previous.right + 1) previous.right = Math.max(previous.right, rect.right);
      else merged.push({ ...rect });
    });
    return merged.map((rect) => ({ left: rect.left, top: line.top, width: rect.right - rect.left, height: line.bottom - line.top }));
  });
}

function sentenceIdsAt(target) {
  const direct = target.closest("[data-sentence-id]");
  if (direct) return [direct.dataset.sentenceId];
  const word = target.closest("ruby") || target.closest(".ruby-word");
  return [...new Set([...(word?.querySelectorAll("[data-sentence-id]") || [])].map((node) => node.dataset.sentenceId))];
}

// DOM offsets count only base characters, with one separator between paragraphs.
// The source/mark/ruby wrappers never contribute characters to a selection.
export function articleSelection(root, canonicalHtml) {
  if (!root) return null;
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
  const surface = useRef(null);
  const highlighted = useRef([]);
  const pointer = useRef(null);
  const [decorations, setDecorations] = useState({ sentences: [], qa: [] });
  const display = useMemo(() => displayBodyHtml(html), [html]);
  const highlight = (ids) => {
    if (ids.length === highlighted.current.length && ids.every((id,index) => id === highlighted.current[index])) return;
    highlighted.current = ids;
    surface.current?.querySelectorAll("[data-highlight-sentence-id]").forEach((node) => {
      node.classList.toggle("active", ids.includes(node.dataset.highlightSentenceId));
    });
    root.current?.querySelectorAll("[data-sentence-id]").forEach((node) => {
      node.classList.toggle("sentence-hovered", ids.includes(node.dataset.sentenceId));
    });
  };
  useLayoutEffect(() => {
    let frame;
    const measure = () => {
      const element = root.current;
      if (!element) return;
      const origin = surface.current.getBoundingClientRect();
      const groups = new Map();
      element.querySelectorAll("[data-sentence-id]").forEach((node) => {
        const nodes = groups.get(node.dataset.sentenceId) || [];
        nodes.push(node); groups.set(node.dataset.sentenceId, nodes);
      });
      setDecorations({
        sentences: [...groups].flatMap(([id,nodes]) => decorationRects(nodes,origin,fontSize).map((rect) => ({...rect,id}))),
        qa: decorationRects([...element.querySelectorAll("mark[data-qa-group-ids]")], origin, fontSize),
      });
    };
    const schedule = () => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); };
    measure();
    const observer = new ResizeObserver(schedule);
    observer.observe(root.current);
    window.addEventListener("resize", schedule);
    window.visualViewport?.addEventListener("resize", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    return () => {
      cancelAnimationFrame(frame); observer.disconnect();
      window.removeEventListener("resize", schedule);
      window.visualViewport?.removeEventListener("resize", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
    };
  }, [display, fontSize, showRuby]);
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
  return <div ref={surface} className="article-text-surface">
    <div className="article-highlight-layer" aria-hidden="true">
      {decorations.sentences.map(({id,...rect},index) => <span key={`sentence:${index}`} data-highlight-sentence-id={id}
        className={`article-sentence-highlight ${highlighted.current.includes(id) ? "active" : ""}`} style={rect} />)}
      {decorations.qa.map((rect,index) => <span key={`qa:${index}`} className="article-qa-highlight" style={rect} />)}
    </div>
    <div ref={root} lang="ja" style={{ fontSize }}
    className={`japanese-text horizontal article-body ${showRuby ? "" : "ruby-hidden"} ${className}`}
    onMouseUp={choose} onTouchEnd={() => setTimeout(choose, 50)} onKeyUp={choose}
    onPointerDown={(event) => { pointer.current = { x:event.clientX, y:event.clientY, moved:false }; }}
    onPointerMove={(event) => {
      if (pointer.current && Math.hypot(event.clientX-pointer.current.x,event.clientY-pointer.current.y) > 4) pointer.current.moved = true;
      if (event.pointerType !== "touch") highlight(sentenceIdsAt(event.target));
    }}
    onPointerLeave={() => highlight([])}
    onFocus={(event) => highlight(sentenceIdsAt(event.target))}
    onBlur={() => highlight([])}
    onKeyDown={(event) => {
      const mark = event.target.closest('mark[role="button"]');
      if (mark && ["Enter", " "].includes(event.key)) {
        event.preventDefault(); onGroup?.(mark.dataset.qaGroupIds.split(/\s+/).filter(Boolean));
      }
    }}
    onClick={(event) => {
      if (pointer.current?.moved || !window.getSelection()?.isCollapsed) return;
      const group = event.target.closest("[data-qa-group-ids]");
      const word = event.target.closest("ruby") || event.target.closest(".ruby-word");
      const groups = group ? group.dataset.qaGroupIds.split(/\s+/).filter(Boolean)
        : [...new Set([...(word?.querySelectorAll("[data-qa-group-ids]") || [])].flatMap((node) => node.dataset.qaGroupIds.split(/\s+/).filter(Boolean)))];
      if (groups.length) onGroup?.(groups);
      const source = event.target.closest("[data-source-image-id]");
      if (source) onSource?.(source.dataset.sourceImageId);
    }}
    dangerouslySetInnerHTML={{ __html: display }} />
  </div>;
}
