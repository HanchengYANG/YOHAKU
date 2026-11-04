import { useEffect, useState } from "react";
import api from "../api.mjs";

export default function APIBaseSettings({ status, busy, perform, refresh, onNotice }) {
  const configuration = status?.configuration;
  const [apiKey, setApiKey] = useState("");
  useEffect(() => { setApiKey(""); }, [configuration]);
  const save = (event) => {
    event.preventDefault();
    perform("configure", async () => {
      await api("/ai/configuration", { method: "PUT", body: JSON.stringify({ apiKey, providerId: "api_base" }) });
      await refresh();
      onNotice("API key 已保存。请到「角色配置」选择模型并手动测试。");
    });
  };
  const disconnect = () => perform("logout", async () => {
    await api("/ai/logout", { method: "POST", body: JSON.stringify({ providerId: "api_base" }) });
    await refresh();
    onNotice("已从服务器移除 API key，阅读材料和对话继续保留。");
  });
  return <form className="ai-account-card api-base-settings" aria-label="iliad codix 配置" onSubmit={save}>
    <div className="ai-account-state">
      <span className={`ai-status-dot ${configuration?.hasKey ? "connected" : ""}`} />
      <div>
        <strong>{configuration?.hasKey ? "已保存 API key" : "尚未配置 API key"}</strong>
        <p>所有网站账号共用此连接。</p>
      </div>
    </div>
    <p className="ai-model-caption">服务地址：{configuration?.baseURL || "https://iliad.codix.scw.eu/v1"}</p>
    <label className="stage2-field">
      API key{configuration?.hasKey ? "（已保存，留空继续使用）" : ""}
      <input type="password" aria-label="API key" required={!configuration?.hasKey}
        autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={8192}
        disabled={!!busy} onChange={(event) => setApiKey(event.target.value)} />
    </label>
    <p className="ai-model-caption">密钥仅保存在服务器，保存后不会回显。保存不会调用模型。</p>
    <div className="ai-account-actions">
      <button className="button primary" type="submit" disabled={!!busy}>
        {busy === "configure" ? "正在保存…" : "保存 API key"}
      </button>
      {configuration?.hasKey && <button className="text-button" type="button" disabled={!!busy} onClick={disconnect}>
        {busy === "logout" ? "正在移除…" : "移除 API key"}
      </button>}
    </div>
    {status?.lastError && <p className="ai-status-error">{status.lastError}</p>}
  </form>;
}
