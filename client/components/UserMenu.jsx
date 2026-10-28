import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";

export default function UserMenu({ user, onLoggedOut, onBeforeLogout }) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [invitation, setInvitation] = useState(null);
  const [copied, setCopied] = useState(false);
  const pending = useRef(false);
  const tokenInput = useRef(null);
  const admin = user?.role === "admin" || user?.isAdmin === true;
  useEffect(() => {
    setInvitation(null);
    setCopied(false);
    setError("");
  }, [user?.id, user?.username]);

  const perform = async (action, operation) => {
    if (pending.current) return;
    pending.current = true;
    setBusy(action);
    setError("");
    try {
      await operation();
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? "无法连接本机服务，请稍后重试。"
          : cause.message,
      );
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
    setError("");
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
  const expiryValue =
    typeof invitation?.expiresAt === "number" && invitation.expiresAt < 1e12
      ? invitation.expiresAt * 1000
      : invitation?.expiresAt;
  const expiry = expiryValue ? new Date(expiryValue) : null;

  if (!user) return null;
  return (
    <section className="account-user-menu" aria-label="当前网站账号">
      <div className="user-menu-header">
        <div>
          <small>网站账号{admin ? " · 管理员" : ""}</small>
          <strong title={user.username}>{user.username}</strong>
        </div>
        <button
          className="text-button"
          type="button"
          onClick={logout}
          disabled={!!busy}
        >
          {busy === "logout" ? "正在退出…" : "退出"}
        </button>
      </div>
      {error && (
        <p className="user-menu-error" role="alert">
          {error}
        </p>
      )}
      {admin && (
        <div className="user-menu-admin">
          <button
            className="text-button"
            type="button"
            disabled={!!busy}
            onClick={invite}
          >
            <Icon name="plus" size={13} />
            {busy === "invite"
              ? "正在生成…"
              : invitation
                ? "再生成一个邀请码"
                : "生成朋友的邀请码"}
          </button>
          {invitation && (
            <div className="user-menu-invitation">
              <label>
                邀请码
                <input
                  aria-label="新生成的邀请码"
                  ref={tokenInput}
                  value={invitation.token}
                  readOnly
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <div className="invite-copy-row">
                <small>
                  {expiry && !Number.isNaN(expiry.getTime())
                    ? `有效至 ${expiry.toLocaleString("zh-CN", { dateStyle: "short", timeStyle: "short" })}`
                    : "仅向你想邀请的人提供"}
                </small>
                <button
                  className="text-button"
                  type="button"
                  disabled={!!busy}
                  onClick={copy}
                >
                  {copied ? "已复制" : "复制"}
                </button>
              </div>
              <p>朋友注册后，保存自己的资料，并使用网站共享的 AI。</p>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
