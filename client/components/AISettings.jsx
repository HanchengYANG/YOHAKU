import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";

export default function AISettings({ onClose, onChanged }) {
  const [status, setStatus] = useState(null);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api("/ai/status", { signal: controller.signal })
      .then((value) => {
        setStatus(value);
        onChanged?.(value);
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      })
      .finally(() => {
        if (!controller.signal.aborted) setBusy("");
      });
    return () => {
      mounted.current = false;
      controller.abort();
    };
  }, []);

  const perform = async (action, operation) => {
    if (pending.current || busy) return;
    pending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (e) {
      if (mounted.current) setError(e.message);
    } finally {
      pending.current = false;
      if (mounted.current) setBusy("");
    }
  };

  const refresh = async () => {
    const value = await api("/ai/status");
    if (mounted.current) {
      setStatus(value);
      onChanged?.(value);
    }
  };

  const login = (newAccount = false) =>
    perform("login", async () => {
      const result = await api("/ai/login", {
        method: "POST",
        body: JSON.stringify({ newAccount }),
      });
      const target = new URL(result.url);
      if (
        target.protocol !== "https:" ||
        target.hostname !== "auth.openai.com" ||
        target.pathname !== "/api/accounts/authorize" ||
        target.username ||
        target.password
      ) {
        throw new Error("登录地址无效，请重新读取授权状态后再试。");
      }
      window.location.assign(target.href);
    });

  const disconnect = () =>
    perform("logout", async () => {
      const result = await api("/ai/logout", { method: "POST" });
      await refresh();
      if (mounted.current) {
        setNotice(
          result?.revoked === false || result?.remoteRevoked === false
            ? "已停止使用本机授权；未能确认远端撤销，请到 ChatGPT 设置检查此应用的授权。"
            : "已断开此账户的授权，阅读材料和对话仍保留在本机。",
        );
      }
    });

  const selectAccount = (id) =>
    perform("account", async () => {
      await api("/ai/account", {
        method: "POST",
        body: JSON.stringify({ id }),
      });
      await refresh();
    });

  const accounts = Array.isArray(status?.accounts) ? status.accounts : [];
  const connected = status?.connected === true;
  const chooseProvider = (providerId) =>
    perform("provider", async () => {
      await api("/providers/active", {
        method: "POST",
        body: JSON.stringify({ providerId }),
      });
      await refresh();
    });
  const claim = () =>
    perform("claim", async () => {
      await api("/ai/claim-existing", { method: "POST" });
      await refresh();
      setNotice("原本机授权已绑定为网站共享 AI，所有账号均可使用。");
    });

  if (status && !status.canManageAI) return (
    <section className="stage2-page ai-settings" aria-label="AI 授权设置">
      <h1>网站共享 AI</h1>
      <p>AI 由网站拥有者统一配置，你可以在自己的材料中使用。</p>
      <button className="button subtle" onClick={onClose}>返回</button>
    </section>
  );

  return (
    <section className="stage2-page ai-settings" aria-label="AI 授权设置">
      <div className="stage2-heading">
        <div>
          <span className="eyebrow">阅读助手</span>
          <h1>配置网站共享 AI</h1>
        </div>
        <button
          type="button"
          className="button subtle"
          disabled={!!busy}
          onClick={onClose}
        >
          返回
        </button>
      </div>
      <p className="stage2-description">
        网站拥有者统一连接 ChatGPT，所有网站账号共用这份 AI 授权和额度。
        各账号的书架、图片与讨论仍各自独立。
      </p>
      <label className="stage2-field account-picker">
        AI 提供方
        <select
          aria-label="AI 提供方"
          value={status?.providerId || "openai"}
          disabled={!!busy}
          onChange={(event) => chooseProvider(event.target.value)}
        >
          {(
            status?.providers || [
              { id: "openai", name: "OpenAI", enabled: true },
            ]
          ).map((provider) => (
            <option
              key={provider.id}
              value={provider.id}
              disabled={!provider.enabled}
            >
              {provider.name}
              {provider.enabled ? "" : "（预留，未实现）"}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <div className="stage2-error" role="alert">
          {error}
        </div>
      )}
      {notice && (
        <div className="stage2-notice" role="status">
          {notice}
        </div>
      )}
      <div className="ai-account-card">
        {status?.canClaimExisting && (
          <div className="stage2-notice">
            <p>
              本机有一份此前为余白完成的 ChatGPT
              授权。你可以把它认领为网站共享授权。
            </p>
            <button
              className="button secondary"
              type="button"
              disabled={!!busy}
              onClick={claim}
            >
              {busy === "claim" ? "正在绑定…" : "绑定刚才的 ChatGPT 授权"}
            </button>
          </div>
        )}
        <div className="ai-account-state">
          <span className={`ai-status-dot ${connected ? "connected" : ""}`} />
          <div>
            <strong>
              {busy === "loading"
                ? "正在读取授权状态…"
                : connected
                  ? "已授权"
                  : accounts.length
                    ? "需要重新授权"
                    : "尚未授权"}
            </strong>
            <p>
              {status?.email ||
                (connected
                  ? "已连接网站共享 ChatGPT 账户。"
                  : "图片识别和 AI 问答需要先连接账户。")}
            </p>
          </div>
          <button
            className="text-button"
            type="button"
            disabled={!!busy}
            onClick={() => perform("refresh", refresh)}
          >
            {busy === "refresh" ? "正在刷新…" : "刷新状态"}
          </button>
        </div>
        {status?.lastError && (
          <p className="ai-status-error">{status.lastError}</p>
        )}
        {status?.model && connected && (
          <p className="ai-model-caption">当前模型：{status.model}</p>
        )}
        {accounts.length > 0 && (
          <label className="stage2-field account-picker">
            已保存的 ChatGPT 账户
            <select
              aria-label="ChatGPT 账户"
              value={status?.activeAccountId || ""}
              disabled={!!busy}
              onChange={(e) => selectAccount(e.target.value)}
            >
              {!status?.activeAccountId && (
                <option value="" disabled>
                  选择账户
                </option>
              )}
              {accounts.map((account, index) => (
                <option key={account.id} value={account.id}>
                  {account.email || `账户 ${index + 1}`}
                  {account.connected === false ? " · 需重新授权" : ""}
                </option>
              ))}
            </select>
          </label>
        )}
        <div className="ai-account-actions">
          {!connected && status && (
            <button
              className="button primary chatgpt-connect"
              type="button"
              disabled={!!busy}
              onClick={() => login(false)}
            >
              {busy === "login" ? "正在打开授权页面…" : "Continue with ChatGPT"}
            </button>
          )}
          {accounts.length > 0 && (
            <button
              className="button secondary"
              type="button"
              disabled={!!busy}
              onClick={() => login(true)}
            >
              使用另一个账户
            </button>
          )}
          {(connected || status?.email) && (
            <button
              className="text-button"
              type="button"
              disabled={!!busy}
              onClick={disconnect}
            >
              {busy === "logout" ? "正在断开…" : "断开授权"}
            </button>
          )}
        </div>
      </div>
      <div className="ai-usage-note">
        <Icon name="book" size={18} />
        <div>
          <p>识别图片与讨论内容会发送给所连接账户的 AI 服务。</p>
          <p>
            所有网站账号的 AI 请求均消耗网站拥有者配置的订阅额度，用量达到限制时会显示实际错误。
          </p>
          <a
            className="text-button"
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
          >
            到 ChatGPT 管理用量和授权 <Icon name="arrow" size={14} />
          </a>
        </div>
      </div>
    </section>
  );
}
