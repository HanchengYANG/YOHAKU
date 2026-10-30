import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { bodyRanges } from "../../shared/article-html.mjs";
import { editorDecorations } from "../editor-decorations.mjs";
import "../body-editor.css";

export default function BodyEditor({ html, value, textareaRef, onChange, onSelection, onKeyDown,
  onCompositionStart, onCompositionEnd, onGroup, activeSourceId, ...textareaProps }) {
  const viewport = useRef(null);
  const mirror = useRef(null);
  const rectangles = useRef([]);
  const composing = useRef(false);
  const [compositionDraft, setCompositionDraft] = useState(null);
  const [hoveredSentence, setHoveredSentence] = useState(null);
  const [hoveredGroups, setHoveredGroups] = useState([]);
  const [caret, setCaret] = useState({ start: 0, end: 0 });
  const ranges = useMemo(() => bodyRanges(html), [html]);
  const shown = compositionDraft ?? value;
  const parts = useMemo(() => editorDecorations(shown, ranges), [shown, ranges]);
  const caretGroups = ranges.qa.filter((range) => caret.start === caret.end
    ? range.start <= caret.start && range.end > caret.start
    : range.start < caret.end && range.end > caret.start).map((range) => range.id);
  const groupIds = [...new Set((hoveredGroups.length ? hoveredGroups : caretGroups).filter((id) => ranges.qa.some((range) => range.id === id)))];
  const syncScroll = () => {
    const input = textareaRef.current;
    if (input && mirror.current) mirror.current.style.transform = `translate(${-input.scrollLeft}px, ${-input.scrollTop}px)`;
  };
  useLayoutEffect(() => {
    const input = textareaRef.current, layer = mirror.current;
    if (!input || !layer) return;
    const measure = () => {
      const style = getComputedStyle(input);
      for (const name of ["fontFamily", "fontSize", "fontWeight", "fontStyle", "lineHeight", "letterSpacing", "wordSpacing",
        "textAlign", "textIndent", "textTransform", "direction", "tabSize", "whiteSpace", "overflowWrap", "wordBreak",
        "paddingTop", "paddingRight", "paddingBottom", "paddingLeft"])
        layer.style[name] = style[name];
      viewport.current.style.width = `${input.clientWidth}px`;
      viewport.current.style.height = `${input.clientHeight}px`;
      syncScroll();
      const origin = layer.getBoundingClientRect();
      rectangles.current = [...layer.querySelectorAll("[data-editor-part]")].flatMap((span) => {
        const part = parts[Number(span.dataset.editorPart)];
        const range = document.createRange(); range.selectNodeContents(span);
        return [...range.getClientRects()].map((rect) => ({
          left: rect.left - origin.left, right: rect.right - origin.left,
          top: rect.top - origin.top, bottom: rect.bottom - origin.top, part,
        }));
      });
    };
    measure();
    const observer = new ResizeObserver(measure); observer.observe(input);
    const attributes = new MutationObserver(measure); attributes.observe(input, { attributes:true, attributeFilter:["style", "class"] });
    window.addEventListener("resize", measure);
    document.fonts?.addEventListener("loadingdone", measure);
    return () => { observer.disconnect(); attributes.disconnect(); window.removeEventListener("resize", measure); document.fonts?.removeEventListener("loadingdone", measure); };
  }, [parts, textareaRef]);
  const selected = () => {
    if (composing.current) return;
    const input = textareaRef.current;
    setCaret({ start: input.selectionStart, end: input.selectionEnd });
    setHoveredGroups([]);
    onSelection?.();
  };
  return <div className="body-editor" data-composing={compositionDraft !== null ? "true" : undefined}>
    <div className="body-editor-records">
      {groupIds.length > 0 && <button type="button" className="text-button" onMouseDown={(event) => event.preventDefault()}
        onClick={() => onGroup?.(groupIds)}>查看此处记录 · {groupIds.length} 组</button>}
    </div>
    <div className="body-editor-input">
      <div ref={viewport} className="body-editor-viewport" aria-hidden="true">
        <div ref={mirror} className="body-editor-mirror" lang="ja">
          {parts.map((part, index) => <span key={part.start} data-editor-part={index}
            data-sentence-ids={part.sentenceIds.join(" ") || undefined}
            data-qa-group-ids={part.groupIds.join(" ") || undefined}
            data-source-image-id={part.sourceIds.join(" ") || undefined}
            className={`body-editor-part ${part.sentenceIds.includes(hoveredSentence) ? "sentence-hover" : ""}`}>{part.text}</span>)}
          <span>{"\u200b"}</span>
        </div>
      </div>
      <textarea {...textareaProps} ref={textareaRef} className="source-textarea" value={shown}
        onChange={(event) => {
          if (composing.current) setCompositionDraft(event.target.value);
          else onChange(event.target.value);
        }}
        onCompositionStart={(event) => {
          composing.current = true; setCompositionDraft(event.currentTarget.value);
          setHoveredSentence(null); onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          composing.current = false; setCompositionDraft(null);
          onCompositionEnd?.(event); onChange(event.currentTarget.value);
        }}
        onScroll={syncScroll}
        onSelect={selected} onBlur={selected} onKeyUp={selected} onMouseUp={selected}
        onKeyDown={onKeyDown}
        onPointerMove={(event) => {
          if (event.buttons || composing.current || event.pointerType === "touch") return;
          const input = event.currentTarget, box = input.getBoundingClientRect();
          const x = event.clientX - box.left + input.scrollLeft, y = event.clientY - box.top + input.scrollTop;
          const hit = rectangles.current.find((rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
          setHoveredSentence(hit?.part.sentenceIds[0] || null);
          setHoveredGroups(hit?.part.groupIds || []);
        }}
        onPointerLeave={() => setHoveredSentence(null)} />
    </div>
  </div>;
}
