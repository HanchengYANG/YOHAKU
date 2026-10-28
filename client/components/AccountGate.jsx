import { useRef, useState } from "react";
import api from "../api.mjs";
import Icon from "./Icon.jsx";

export default function AccountGate({ session, onAuthenticated }) {
  const [mode, setMode] = useState("login");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const setup = session?.needsSetup === true;
  const registering = !setup && mode === "register";

  const submit = async (event) => {
    event.preventDefault();
    if (pending.current || !session) return;
    const name = username.trim();
    if (name.length < 3 || name.length > 40) {
      setError("网站账号需要 3–40 个字符。");
      return;
    }
    if (password.length < 10 || password.length > 128) {
      setError("密码需要 10–128 个字符。");
      return;
    }
    if (registering && !inviteToken.trim()) {
      setError("请输入管理员给你的邀请码。");
      return;
    }
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await api(
        setup
          ? "/accounts/setup"
          : registering
            ? "/accounts/register"
            : "/session/login",
        {
          method: "POST",
          body: JSON.stringify({
            username: name,
            password,
            ...(registering ? { inviteToken: inviteToken.trim() } : {}),
          }),
        },
      );
      if (!result?.user || typeof result.user.username !== "string")
        throw new Error("登录结果无效，请重新尝试。");
      setPassword("");
      onAuthenticated(result.user);
    } catch (cause) {
      setError(
        cause instanceof TypeError
          ? "无法连接本机服务，请确认余白已经启动。"
          : cause.message,
      );
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  return (
    <main className="account-gate">
      <div className="account-gate-brand">
        <span className="brand-mark">余</span>
        <div>
          <strong>余白</strong>
          <small>日语阅读与笔记</small>
        </div>
      </div>
      {!session ? (
        <section className="account-gate-card">
          <p className="account-gate-loading" role="status">
            正在读取网站账号状态…
          </p>
        </section>
      ) : (
        <section
          className="account-gate-card"
          aria-label={
            setup
              ? "创建首个网站账号"
              : registering
                ? "凭邀请码注册"
                : "登录网站账号"
          }
        >
          <span className="eyebrow">
            {setup
              ? "给自己的书架一把钥匙"
              : registering
                ? "受邀加入"
                : "欢迎回来"}
          </span>
          <h1>
            {setup
              ? "创建你的网站账号"
              : registering
                ? "注册一个新账号"
                : "回到你的书架"}
          </h1>
          <p className="account-gate-description">
            {setup
              ? "先为余白设置一个网站账号，之后阅读材料、笔记和对话都会归属到各自账号。"
              : "用余白的网站账号登录，使用自己的书架和网站共享的 AI。"}
          </p>
          {setup && (
            <div className="account-setup-note">
              <p>已有的本机阅读资料将归这个首次创建的账号所有。</p>
              <p>
                首个账号是网站拥有者，负责配置所有账号共用的 AI 授权。
              </p>
            </div>
          )}
          {!setup && (
            <div className="account-gate-modes" aria-label="登录或注册">
              <button
                className={registering ? "" : "selected"}
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode("login");
                  setError("");
                }}
              >
                登录
              </button>
              <button
                className={registering ? "selected" : ""}
                type="button"
                disabled={busy}
                onClick={() => {
                  setMode("register");
                  setError("");
                }}
              >
                凭邀请码注册
              </button>
            </div>
          )}
          {error && (
            <div className="account-gate-error" role="alert">
              {error}
            </div>
          )}
          <form onSubmit={submit}>
            <fieldset disabled={busy}>
              <label className="account-form-field">
                网站账号
                <input
                  aria-label="网站账号"
                  name="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  spellCheck={false}
                  autoCapitalize="none"
                  minLength={3}
                  maxLength={40}
                  placeholder="3–40 个字符"
                  required
                  autoFocus
                />
              </label>
              <label className="account-form-field">
                密码
                <input
                  aria-label="网站账号密码"
                  name="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoComplete={
                    setup || registering ? "new-password" : "current-password"
                  }
                  minLength={10}
                  maxLength={128}
                  placeholder="10–128 个字符"
                  required
                />
              </label>
              {registering && (
                <label className="account-form-field">
                  邀请码
                  <input
                    aria-label="邀请码"
                    name="inviteToken"
                    value={inviteToken}
                    onChange={(e) => setInviteToken(e.target.value)}
                    autoComplete="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    placeholder="由管理员提供"
                    maxLength={256}
                    required
                  />
                </label>
              )}
              <button
                className="button primary account-submit"
                type="submit"
                disabled={
                  busy ||
                  !username.trim() ||
                  !password ||
                  (registering && !inviteToken.trim())
                }
              >
                {busy
                  ? "正在处理…"
                  : setup
                    ? "创建账号并进入书架"
                    : registering
                      ? "注册并登录"
                      : "登录书架"}
                <Icon name="arrow" size={17} />
              </button>
            </fieldset>
          </form>
          <p className="account-separation-note">
            网站账号用于保存你的资料；ChatGPT 等 AI 服务的授权在登录后单独设置。
          </p>
        </section>
      )}
    </main>
  );
}
