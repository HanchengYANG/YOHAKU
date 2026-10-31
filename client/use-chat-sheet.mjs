import { useEffect, useLayoutEffect, useRef, useState } from "react";

const mobileQuery = "(max-width: 1023px)";

export default function useChatSheet({ open, onOpen, onClose, onPreview }) {
  const [mobile, setMobile] = useState(() => window.matchMedia(mobileQuery).matches);
  const panel = useRef(null), handle = useRef(null), closeButton = useRef(null);
  const latest = useRef(null), drag = useRef(null), timer = useRef(null), blockClickUntil = useRef(0);
  const wasOpen = useRef(open);
  latest.current = { open, onOpen, onClose, onPreview };

  useEffect(() => {
    const media = window.matchMedia(mobileQuery);
    const changed = () => setMobile(media.matches);
    media.addEventListener("change", changed);
    return () => media.removeEventListener("change", changed);
  }, []);

  useLayoutEffect(() => {
    const viewport = window.visualViewport;
    let frame;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        for (const element of [panel.current, handle.current]) {
          element?.style.setProperty("--chat-viewport-height", (viewport?.height || window.innerHeight) + "px");
          element?.style.setProperty("--chat-viewport-top", (viewport?.offsetTop || 0) + "px");
        }
      });
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      cancelAnimationFrame(frame);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  useLayoutEffect(() => {
    if (!open || !mobile) return;
    const body = window.document.body;
    const background = window.document.querySelector(".reader-main-column, .editor-page");
    const position = { x: window.scrollX, y: window.scrollY };
    const previous = Object.fromEntries(["position", "top", "left", "width", "overflow"].map((key) => [key, body.style[key]]));
    const inert = background?.inert;
    Object.assign(body.style, { position:"fixed", top:-position.y + "px", left:-position.x + "px", width:"100%", overflow:"hidden" });
    body.classList.add("chat-sheet-open");
    if (background) background.inert = true;
    return () => {
      Object.assign(body.style, previous);
      body.classList.remove("chat-sheet-open");
      if (background) background.inert = inert;
      window.scrollTo(position.x, position.y);
    };
  }, [open, mobile]);

  useLayoutEffect(() => {
    clearTimeout(timer.current);
    if (panel.current) {
      panel.current.style.transform = "";
      panel.current.style.transition = "";
    }
    if (open && !wasOpen.current) closeButton.current?.focus({ preventScroll:true });
    if (!open && wasOpen.current && mobile) handle.current?.focus({ preventScroll:true });
    wasOpen.current = open;
  }, [open, mobile]);
  useEffect(() => () => clearTimeout(timer.current), []);

  const openPanel = () => {
    clearTimeout(timer.current);
    panel.current.style.transition = "";
    panel.current.style.transform = "";
    latest.current.onOpen();
  };
  const pointerDown = (opening) => (event) => {
    if (!mobile || !event.isPrimary || event.button !== 0 || (!opening && event.target.closest("button, select, a"))) return;
    clearTimeout(timer.current);
    drag.current = { id:event.pointerId, x:event.clientX, y:event.clientY, distance:0, opening };
    event.currentTarget.setPointerCapture(event.pointerId);
    const element = panel.current;
    if (opening) {
      element.hidden = false;
      element.inert = true;
      latest.current.onPreview();
    }
    element.style.transition = "none";
    element.style.transform = opening ? "translateY(100%)" : "translateY(0)";
  };
  const pointerMove = (event) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    const dy = (event.clientY - current.y) * (current.opening ? -1 : 1);
    current.distance = dy > Math.abs(event.clientX - current.x) ? Math.max(0, dy) : 0;
    const offset = current.opening ? Math.max(0, panel.current.offsetHeight - current.distance) : current.distance;
    panel.current.style.transform = "translateY(" + offset + "px)";
  };
  const pointerEnd = (event) => {
    const current = drag.current;
    if (!current || current.id !== event.pointerId) return;
    drag.current = null;
    const commit = event.type === "pointerup" && current.distance > 80;
    const element = panel.current;
    element.style.transition = "";
    if (current.opening) {
      if (current.distance > 6) blockClickUntil.current = performance.now() + 400;
      if (commit) openPanel();
      else {
        element.style.transform = "translateY(100%)";
        timer.current = setTimeout(() => {
          if (!latest.current.open) { element.hidden = true; element.style.transform = ""; }
        }, 200);
      }
    } else {
      element.style.transform = "";
      if (commit) latest.current.onClose();
    }
  };
  const pointerHandlers = (opening) => ({
    onPointerDown: pointerDown(opening), onPointerMove: pointerMove,
    onPointerUp: pointerEnd, onPointerCancel: pointerEnd, onLostPointerCapture: pointerEnd,
  });
  const onKeyDown = (event) => {
    if (event.key === "Escape") { event.preventDefault(); latest.current.onClose(); return; }
    if (!mobile || event.key !== "Tab") return;
    const controls = Array.from(panel.current.querySelectorAll("button:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary"))
      .filter((element) => element.getClientRects().length && !element.closest("[inert]"));
    const first = controls[0], last = controls.at(-1), active = window.document.activeElement;
    if ((event.shiftKey && active === first) || (!event.shiftKey && active === last)) {
      event.preventDefault(); (event.shiftKey ? last : first)?.focus({ preventScroll:true });
    }
  };
  return {
    mobile, panel, handle, closeButton, onKeyDown,
    headerDrag: pointerHandlers(false), handleDrag: pointerHandlers(true),
    onHandleClick: () => { if (performance.now() >= blockClickUntil.current) openPanel(); },
  };
}
