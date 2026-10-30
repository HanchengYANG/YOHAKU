import { useLayoutEffect, useRef, useState } from "react";
import "../editor-workflow.css";

export default function SourceImageSorter({ items, activeId, onSelect, onReorder, onRemove, summary, minItems = 0, disabled = false, label = "图片顺序" }) {
  const [status, setStatus] = useState("");
  const list = useRef(null);
  const previousRects = useRef(null);
  const ids = items.map((item) => item.id).join("\n");
  const activeIndex = items.findIndex((item) => item.id === activeId);
  const minimumReached = items.length <= minItems;
  const minimumMessage = minItems === 1 ? "至少保留一张图片" : `至少保留 ${minItems} 张图片`;
  const itemElements = () => [...(list.current?.querySelectorAll("[data-sort-item-id]") || [])];
  const moveActive = (direction) => {
    const nextIndex = activeIndex + direction;
    if (disabled || activeIndex < 0 || nextIndex < 0 || nextIndex >= items.length) return;
    const next = items.map((item) => item.id);
    [next[activeIndex], next[nextIndex]] = [next[nextIndex], next[activeIndex]];
    previousRects.current = new Map(itemElements().map((item) => [item.dataset.sortItemId, item.getBoundingClientRect()]));
    onReorder(next);
    setStatus(`当前照片已移至第 ${nextIndex + 1} 张。`);
  };
  useLayoutEffect(() => {
    if (!previousRects.current) return;
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) itemElements().forEach((item) => {
      const from = previousRects.current.get(item.dataset.sortItemId), to = item.getBoundingClientRect();
      if (from && item.animate) item.animate([{ transform: `translate(${from.left - to.left}px, ${from.top - to.top}px)` }, { transform: "translate(0,0)" }], { duration: 120, easing: "ease-out" });
    });
    previousRects.current = null;
  }, [ids]);
  return <section className="source-image-sorter" aria-label={label}>
    <div className="source-sort-heading"><span>{label} · {items.length} 张</span>
      <div className="source-sort-actions" role="group" aria-label="调整当前照片顺序">
        <small>{disabled ? "处理中，暂不可排序" : activeIndex >= 0 ? `当前第 ${activeIndex + 1} 张` : "先选择照片"}</small>
        <button type="button" className="button subtle" aria-label="前移当前照片" disabled={disabled || activeIndex <= 0} onClick={() => moveActive(-1)}>前移</button>
        <button type="button" className="button subtle" aria-label="后移当前照片" disabled={disabled || activeIndex < 0 || activeIndex === items.length - 1} onClick={() => moveActive(1)}>后移</button>
      </div>
    </div>
    {summary && <p className="source-sort-summary" role="status">{summary}</p>}
    <div ref={list} className="source-sort-list">
      {items.map((item, index) => <div key={item.id} data-sort-item-id={item.id} data-status-kind={item.statusKind} className={`source-sort-item ${onRemove ? "has-remove" : ""}`}>
        <button type="button" data-sort-image-id={item.id} data-status-kind={item.statusKind} className="source-sort-card"
          aria-label={`照片 ${index + 1}，${item.name || `来源图 ${index + 1}`}`} aria-pressed={activeId === item.id} disabled={disabled}
          aria-description={`点按切换图片。${item.status ? ` ${item.status}。` : ""}`} onClick={() => onSelect?.(item.id)}>
          <img src={item.src || `/api/images/${encodeURIComponent(item.id)}/raw`} alt="" draggable={false} style={{ transform: `rotate(${(item.quarterTurns || 0) * 90}deg)` }} />
          <span className="source-sort-card-label"><span>照片 {index + 1}</span><small>{item.name || `来源图 ${index + 1}`}</small></span>
          <span className="source-sort-number" aria-hidden="true">{index + 1}</span>
        </button>
        {item.status && <span className="source-sort-item-status" title={item.status}>{item.status}</span>}
        {onRemove && <button type="button" className="source-sort-remove" aria-label={`移除${item.name || `来源图 ${index + 1}`}`} disabled={disabled || minimumReached}
          title={minimumReached ? minimumMessage : `移除此图片${minItems ? "及对应正文" : ""}`} onClick={() => { if (!disabled && !minimumReached) onRemove(item.id); }}>×</button>}
      </div>)}
    </div>
    {onRemove && minItems > 0 && minimumReached && <p className="source-sort-minimum">{minimumMessage}</p>}
    <p className="sr-only" aria-live="polite">{status}</p>
  </section>;
}
