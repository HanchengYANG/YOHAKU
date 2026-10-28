import React, { useEffect, useRef } from "react";
import { splitRubyDisplay } from "../../shared/ruby-display.mjs";

export default function RubyText({
  blocks,
  showRuby = true,
  fontSize = 26,
  className = "",
  activeRange = null,
  occurrences = [],
  selectedKeys = [],
  onOccurrenceToggle,
}) {
  const activeElement = useRef(null);
  useEffect(() => {
    const target = activeElement.current;
    if (!target) return;
    const preview = target.closest(".preview-content");
    if (!preview) {
      target.scrollIntoView({ block: "center", inline: "nearest" });
      return;
    }
    const targetRect = target.getBoundingClientRect();
    const previewRect = preview.getBoundingClientRect();
    preview.scrollTo({
      top: Math.max(
        0,
        preview.scrollTop +
          targetRect.top -
          previewRect.top -
          preview.clientTop -
          (preview.clientHeight - targetRect.height) / 2,
      ),
      behavior: "auto",
    });
  }, [activeRange]);

  const matchesByBlock = new Map();
  occurrences.forEach((item, index) => {
    if (!matchesByBlock.has(item.blockIndex))
      matchesByBlock.set(item.blockIndex, []);
    matchesByBlock.get(item.blockIndex).push({ ...item, index });
  });
  const selected = new Set(selectedKeys);
  const renderBlock = (block, blockIndex, blockStart) => {
    let position = blockStart;
    const segments = block.segments.map((segment) => {
      const start = position;
      position += segment.text.length;
      return { ...segment, start, end: position };
    });
    const inBlock = matchesByBlock.get(blockIndex) || [];
    const available = inBlock.filter((item) => item.canAnnotate);
    const blocked = inBlock.filter((item) => !item.canAnnotate);
    const text = block.segments.map((segment) => segment.text).join("");
    const label = (item) =>
      `第${item.index + 1}处${text.slice(item.start - blockStart, item.end - blockStart)}（第${blockIndex + 1}行）`;

    // Keep the original ruby intact when a query matches only part of its base.
    const baseText = (value, start) => {
      const end = start + value.length;
      const parts = [];
      let cursor = start;
      for (const item of blocked) {
        const from = Math.max(start, item.start),
          to = Math.min(end, item.end);
        if (from >= to) continue;
        if (from > cursor)
          parts.push(value.slice(cursor - start, from - start));
        parts.push(
          <mark
            key={item.key}
            className="ruby-occurrence unavailable"
            role="button"
            aria-disabled="true"
            aria-label={label(item)}
            title={item.reason}
          >
            {value.slice(from - start, to - start)}
          </mark>,
        );
        cursor = to;
      }
      if (cursor < end) parts.push(value.slice(cursor - start));
      return parts;
    };
    let segmentCursor = 0;
    const range = (from, to) => {
      while (
        segmentCursor < segments.length &&
        segments[segmentCursor].end <= from
      )
        segmentCursor++;
      const rendered = [];
      for (
        let index = segmentCursor;
        index < segments.length && segments[index].start < to;
        index++
      ) {
        const segment = segments[index];
        const start = Math.max(from, segment.start),
          end = Math.min(to, segment.end);
        if (start >= end) continue;
        const value = segment.text.slice(
          start - segment.start,
          end - segment.start,
        );
        let partOffset = start;
        const display = splitRubyDisplay(value, segment.reading).map(
          (part, partIndex) => {
            const base = baseText(part.text, partOffset);
            partOffset += part.text.length;
            return part.reading ? (
              <ruby key={partIndex} data-origin={segment.origin}>
                {base}
                <rp>（</rp>
                <rt>{part.reading}</rt>
                <rp>）</rp>
              </ruby>
            ) : (
              <React.Fragment key={partIndex}>{base}</React.Fragment>
            );
          },
        );
        const content = segment.reading ? (
          <span
            className="ruby-word"
            title={`${segment.text}：${segment.reading}`}
          >
            {display}
          </span>
        ) : (
          display
        );
        const active =
          activeRange &&
          activeRange.start === segment.start &&
          activeRange.end === segment.end;
        rendered.push(
          active ? (
            <mark
              key={index}
              className="ruby-active-occurrence"
              ref={activeElement}
              aria-label={`当前校正词：${segment.text}`}
            >
              {content}
            </mark>
          ) : (
            <React.Fragment key={index}>{content}</React.Fragment>
          ),
        );
      }
      return rendered;
    };
    const children = [];
    let cursor = blockStart;
    for (const item of available) {
      if (item.start > cursor)
        children.push(
          <React.Fragment key={`before-${item.key}`}>
            {range(cursor, item.start)}
          </React.Fragment>,
        );
      children.push(
        <button
          key={item.key}
          type="button"
          className={`ruby-occurrence ${selected.has(item.key) ? "selected" : ""}`}
          aria-label={label(item)}
          aria-pressed={selected.has(item.key)}
          title={`当前读音：${item.currentReading || "未标注"}`}
          onClick={() => onOccurrenceToggle?.(item.key)}
        >
          {range(item.start, item.end)}
        </button>,
      );
      cursor = item.end;
    }
    if (cursor < position)
      children.push(
        <React.Fragment key="after">{range(cursor, position)}</React.Fragment>,
      );
    if (!block.segments.length) children.push(<br key="empty" />);
    return children;
  };

  const output = [];
  let offset = 0,
    list = [];
  const flushList = () => {
    if (list.length)
      output.push(
        <ul className="ruby-text-list" key={`list-${list[0].key}`}>
          {list}
        </ul>,
      );
    list = [];
  };
  blocks.forEach((block, blockIndex) => {
    const children = renderBlock(block, blockIndex, offset);
    const classes = `text-line ${block.segments.length ? "" : "empty-line"}`;
    if (block.type === "list_item")
      list.push(
        <li className={classes} key={block.id}>
          {children}
        </li>,
      );
    else {
      flushList();
      output.push(
        block.type === "heading" ? (
          <h2 className={`${classes} text-heading`} key={block.id}>
            {children}
          </h2>
        ) : (
          <p className={classes} key={block.id}>
            {children}
          </p>
        ),
      );
    }
    offset +=
      block.segments.reduce(
        (length, segment) => length + segment.text.length,
        0,
      ) + 1;
  });
  flushList();
  return (
    <div
      className={`japanese-text horizontal ${showRuby ? "" : "ruby-hidden"} ${className}`}
      lang="ja"
      style={{ fontSize }}
    >
      {output}
    </div>
  );
}
