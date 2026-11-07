import { Fragment, useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";
import ErrorNotice from "./ErrorNotice.mjs";
import { accountMenuItems, isAdminUser } from "../account-menu.mjs";
import { promptInstall, useInstallPrompt } from "../install-prompt.mjs";

// The account row at the bottom of the sidebar. Admin pages, invitations and
// logout open from a menu that unfolds upward over the shelf. The panel comes
// after the button in the DOM so Tab moves from the button into the menu.
export default function UserMenu({ user, onLoggedOut, onBeforeLogout, onOpenPanel, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState(null);
  const [invitation, setInvitation] = useState(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  const tokenInput = useRef(null);
  const root = useRef(null);
  const trigger = useRef(null);
  const admin = isAdminUser(user);
  useEffect(() => {
    setOpen(false);
    setInvitation(null);
    setCopied(false);
    setError(null);
  }, [user?.id, user?.username]);
  // Closing also drops an error from the last action, so reopening starts clean.
  const close = () => {
    setOpen(false);
    setError(null);
  };
  useEffect(() => {
    if (!open) return;
    const outside = (event) => {
      if (!root.current?.contains(event.target)) close();
    };
    // On the document, so Escape works wherever focus is (Safari does not
    // focus a button on click).
    const escape = (event) => {
      if (event.key !== "Escape") return;
      close();
      trigger.current?.focus();
    };
    window.document.addEventListener("pointerdown", outside);
    window.document.addEventListener("keydown", escape);
    return () => {
      window.document.removeEventListener("pointerdown", outside);
      window.document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const perform = async (action, operation) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError(null);
    try {
      await operation();
    } catch (cause) {
      setError(cause);
    } finally {
      pending.current = false;
      setBusy("");
    }
  };
  const logout = () =>
    perform("logout", async () => {
      if (onBeforeLogout && (await onBeforeLogout()) === false) return;
      await api("/session/logout", { method: "POST", body: "{}" });
      setInvitation(null);
      close();
      onLoggedOut();
    });
  const invite = () =>
    perform("invite", async () => {
      const result = await api("/invitations", { method: "POST", body: "{}" });
      if (!result || typeof result.token !== "string" || !result.token)
        throw new Error("邀请码未生成，请重试。");
      setInvitation(result);
      setCopied(false);
    });
  const copy = async () => {
    if (!invitation || busy) return;
    setError(null);
    setCopied(false);
    if (!navigator.clipboard?.writeText) {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setError("当前浏览器不支持自动复制，请选中邀请码手动复制。");
      return;
    }
    try {
      await navigator.clipboard.writeText(invitation.token);
      setCopied(true);
    } catch {
      tokenInput.current?.focus();
      tokenInput.current?.select();
      setError("未能复制，请选中邀请码手动复制。");
    }
  };
  const installEvent = useInstallPrompt();
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const choose = (item) => {
    if (item.id === "invite") return invite();
    if (item.id === "install") { trigger.current?.focus(); close(); void promptInstall(installEvent); return; }
    if (item.id === "logout") return logout();
    // The chosen item unmounts with the menu; keep focus on the trigger
    // instead of letting it fall to <body>.
    trigger.current?.focus();
    close();
    onOpenPanel?.(item.panel);
  };
  const expiryValue =
    typeof invitation?.expiresAt === "number" && invitation.expiresAt < 1e12
      ? invitation.expiresAt * 1000
      : invitation?.expiresAt;
  const expiry = expiryValue ? new Date(expiryValue) : null;

  if (!user) return null;
  return (
    <section className="account-user-menu" aria-label="当前网站账号" ref={root} onBlur={(event) => {
      // Focus moving past the menu closes it. A null target means focus left
      // the page or went nowhere (Safari on click); outside presses close it above.
      if (open && event.relatedTarget && !root.current?.contains(event.relatedTarget)) close();
    }}>
      <button ref={trigger} type="button" className="account-trigger"
        aria-label={`账号菜单（${user.username}）`} aria-expanded={open}
        aria-controls={open ? "account-menu" : undefined}
        onClick={() => (open ? close() : setOpen(true))}>
        <span className="account-avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
        <span className="account-name">
          <strong title={user.username}>{user.username}</strong>
          {admin && <small>管理员</small>}
        </span>
        <Icon name="more" size={16} />
      </button>
      {open && (
        <div className="account-menu-panel" id="account-menu">
          {accountMenuItems(user, { installable: !!installEvent && !standalone }).map((item) => (
            <Fragment key={item.id}>
              <button type="button" className={`account-menu-item${item.id === "logout" ? " is-logout" : ""}`}
                disabled={!!busy || (disabled && !!item.panel)} onClick={() => choose(item)}>
                {item.id === "invite" && busy === "invite" ? "正在生成…"
                  : item.id === "logout" && busy === "logout" ? "正在退出…" : item.label}
              </button>
              {item.id === "invite" && invitation && (
                <div className="user-menu-invitation">
                  <label>
                    邀请码
                    <input aria-label="新生成的邀请码" ref={tokenInput} value={invitation.token} readOnly
                      spellCheck={false} onFocus={(event) => event.target.select()} />
                  </label>
                  <div className="invite-copy-row">
                    {expiry && !Number.isNaN(expiry.getTime()) && (
                      <small>有效至 {expiry.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}</small>
                    )}
                    <button className="text-button" type="button" disabled={!!busy} onClick={copy}>
                      {copied ? "已复制" : "复制"}
                    </button>
                  </div>
                </div>
              )}
            </Fragment>
          ))}
          {error && <ErrorNotice error={error} />}
        </div>
      )}
    </section>
  );
}
