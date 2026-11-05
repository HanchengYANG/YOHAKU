import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import "../confirmation.css";

function ConfirmDialog({ title, description, confirmLabel, opener, onConfirm }) {
  const dialog = useRef(null), cancelButton = useRef(null);
  const titleId = useId(), descriptionId = useId();
  useLayoutEffect(() => {
    const element = dialog.current;
    element.showModal();
    cancelButton.current?.focus({ preventScroll: true });
    return () => {
      element.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, [opener]);
  return <dialog ref={dialog} className="confirmation-dialog" aria-labelledby={titleId}
    aria-describedby={descriptionId} onCancel={(event) => { event.preventDefault(); onConfirm(false); }}
    onKeyDown={(event) => {
      if (event.key !== "Tab") return;
      const buttons = [...dialog.current.querySelectorAll("button")];
      const index = buttons.indexOf(document.activeElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length]?.focus();
    }}>
    <h2 id={titleId}>{title}</h2>
    <p id={descriptionId}>{description}</p>
    <div className="confirmation-actions">
      <button ref={cancelButton} type="button" className="button secondary" onClick={() => onConfirm(false)}>取消</button>
      <button type="button" className="button confirmation-delete" onClick={() => onConfirm(true)}>{confirmLabel}</button>
    </div>
  </dialog>;
}

export function useConfirmation() {
  const [request, setRequest] = useState(null);
  const pending = useRef(null);
  useEffect(() => () => {
    pending.current?.(false);
    pending.current = null;
  }, []);
  const confirm = (options) => {
    if (pending.current) return Promise.resolve(false);
    return new Promise((resolve) => {
      pending.current = resolve;
      setRequest({ ...options, opener: document.activeElement });
    });
  };
  const settle = (accepted) => {
    const resolve = pending.current;
    pending.current = null;
    setRequest(null);
    resolve?.(accepted);
  };
  return { confirm, confirmationDialog: request && <ConfirmDialog {...request} onConfirm={settle} /> };
}
