import { useEffect, useRef, useState } from "react";

// Reveal incoming text over a few frames, catching up quickly if a larger chunk
// arrives. This runs while receiving the answer, never after a completed reply.
export default function useStreamedReply(beforeUpdate) {
  const [reply,setReply] = useState(null);
  const target = useRef(null), shown = useRef(null), frame = useRef(null), before = useRef(beforeUpdate);
  const [motion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)"));
  before.current = beforeUpdate;
  const step = () => {
    frame.current = null;
    const next = target.current;
    if (!next) return;
    const text = next.text || "", previous = shown.current?.key === next.key ? shown.current.text : "";
    let visible = text.startsWith(previous) ? previous : "";
    const remaining = Array.from(text.slice(visible.length));
    visible += remaining.slice(0,next.incomplete || motion.matches ? remaining.length : Math.max(1,Math.ceil(remaining.length/3))).join("");
    const value = {...next,text:visible};
    before.current?.(value); shown.current = value; setReply(value);
    if (visible !== text) frame.current = requestAnimationFrame(step);
  };
  const update = (change) => {
    target.current = typeof change === "function" ? change(target.current) : change;
    if (frame.current === null) frame.current = requestAnimationFrame(step);
  };
  const clear = () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null; target.current = null; shown.current = null; setReply(null);
  };
  useEffect(() => () => { if (frame.current !== null) cancelAnimationFrame(frame.current); }, []);
  return {reply,update,clear,interrupt:() => target.current?.text ? update((value) => ({...value,incomplete:true})) : clear()};
}
