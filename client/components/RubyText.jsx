import React from "react";

export default function RubyText({
  blocks,
  showRuby = true,
  orientation = "horizontal",
  fontSize = 26,
  className = "",
}) {
  return (
    <div
      className={`japanese-text ${orientation} ${showRuby ? "" : "ruby-hidden"} ${className}`}
      lang="ja"
      style={{ fontSize }}
    >
      {blocks.map((block) => (
        <div
          className={`text-line ${block.segments.length ? "" : "empty-line"}`}
          key={block.id}
        >
          {block.segments.map((segment, i) =>
            segment.reading ? (
              <ruby key={i} data-origin={segment.origin}>
                {segment.text}
                <rp>（</rp>
                <rt>{segment.reading}</rt>
                <rp>）</rp>
              </ruby>
            ) : (
              <React.Fragment key={i}>{segment.text}</React.Fragment>
            ),
          )}
          {!block.segments.length && <br />}
        </div>
      ))}
    </div>
  );
}
