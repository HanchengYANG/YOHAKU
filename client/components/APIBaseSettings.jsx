import { useEffect, useState } from "react";
import api from "../api.mjs";

export default function APIBaseSettings({ status, busy, perform, refresh, onNotice, onSaveProvider }) {
  const configuration = status?.configuration;
  const [model, setModel] = useState(configuration?.model || "");
  const [apiKey, setApiKey] = useState("");
  const [customModel, setCustomModel] = useState(false);
  const [catalog, setCatalog] = useState({ models: configuration?.models || [], source: configuration?.modelsSource || "preset" });
  const [loadingModels, setLoadingModels] = useState(false);
  const [modelsError, setModelsError] = useState("");
  const [modelChecks, setModelChecks] = useState(configuration?.modelChecks || []);
  useEffect(() => {
    setApiKey("");
    setCustomModel(false);
    setModelChecks(configuration?.modelChecks || []);
    setCatalog({ models: configuration?.models || [], source: configuration?.modelsSource || "preset" });
    setModelsError("");
    setLoadingModels(false);
    if (!configuration?.hasKey) return;
    const controller = new AbortController();
    setLoadingModels(true);
    api("/ai/models?providerId=api_base", { signal: controller.signal })
      .then((value) => { if (!controller.signal.aborted) setCatalog(value); })
      .catch((error) => { if (!controller.signal.aborted) setModelsError(error.message); })
      .finally(() => { if (!controller.signal.aborted) setLoadingModels(false); });
    return () => controller.abort();
  }, [configuration]);
  const selectedModel = catalog.models.find((item) => item.id === model);
  const manualModel = customModel || !selectedModel;
  const credentialsDirty = !!apiKey.trim();
  const report = credentialsDirty ? null : modelChecks.find((item) => item.model === model);
  const refreshModels = () => perform("models", async () => {
    setModelsError("");
    setLoadingModels(true);
    try {
      const value = await api("/ai/models?providerId=api_base");
      setCatalog(value);
      onNotice(`已从服务端获取 ${value.models.length} 个可选模型。`);
    } finally { setLoadingModels(false); }
  });
  const save = (event) => {
    event.preventDefault();
    perform("configure", async () => {
      await api("/ai/configuration", { method: "PUT", body: JSON.stringify({ apiKey, providerId: "api_base" }) });
      await refresh();
      onNotice("API 配置已保存；模型通过测试后，点击「保存提供方」启用。");
    });
  };
  const disconnect = () => perform("logout", async () => {
    await api("/ai/logout", { method: "POST", body: JSON.stringify({ providerId: "api_base" }) });
    await refresh();
    onNotice("已从服务器移除 API key，阅读材料和对话继续保留。");
  });
  const testModel = () => perform("model-test", async () => {
    const result = await api("/ai/models/test", { method: "POST", body: JSON.stringify({ model, providerId: "api_base" }) });
    await refresh();
    onNotice(result.passed ? "模型测试通过，可以点击「保存提供方」。" : "模型测试未通过，暂不能启用。请查看各项结果，稍后可重新测试。");
  });
  return <form className="ai-account-card api-base-settings" aria-label="iliad codix 配置" onSubmit={save}>
    <div className="ai-account-state">
      <span className={`ai-status-dot ${status?.connected ? "connected" : ""}`} />
      <div>
        <strong>{configuration?.hasKey ? "已保存 API key" : "尚未配置 API key"}</strong>
        <p>连接 iliad codix，为所有网站账号提供共享 AI。</p>
      </div>
    </div>
    <p className="ai-model-caption">服务地址：{configuration?.baseURL}</p>
    <label className="stage2-field">
      API key{configuration?.hasKey ? "（已保存，留空继续使用）" : ""}
      <input type="password" aria-label="API key" required={!configuration?.hasKey}
        autoComplete="new-password" spellCheck={false} value={apiKey} maxLength={8192}
        disabled={!!busy} onChange={(event) => setApiKey(event.target.value)} />
    </label>
    <p className="ai-model-caption">密钥仅保存在服务器，保存后不会回显。</p>
    <div className="ai-account-actions">
      <button className="button primary" type="submit" disabled={!!busy}>
        {busy === "configure" ? "正在保存…" : "保存 API 配置"}
      </button>
      {configuration?.hasKey && <button className="text-button" type="button" disabled={!!busy} onClick={disconnect}>
        {busy === "logout" ? "正在移除…" : "移除 API key"}
      </button>}
    </div>
    <div className="api-model-heading">
      <strong>模型与能力</strong>
      <p className="ai-model-caption" aria-label="当前使用模型">当前使用：{configuration?.activeModel || "尚未启用模型"}</p>
    </div>
    <label className="stage2-field">
      选择待测试模型
      <select aria-label="待测试模型" value={manualModel ? "" : model} disabled={!!busy}
        onChange={(event) => {
          setCustomModel(!event.target.value);
          if (event.target.value) setModel(event.target.value);
        }}>
        {catalog.models.map((item) => <option key={item.id} value={item.id}>
          {item.name === item.id ? item.id : `${item.name} · ${item.id}`}
        </option>)}
        <option value="">手动填写模型 ID…</option>
      </select>
    </label>
    {manualModel && <label className="stage2-field">
      模型 ID
      <input aria-label="模型 ID" value={model} disabled={!!busy}
        onChange={(event) => setModel(event.target.value)} />
    </label>}
    <div className="ai-account-actions">
      <button type="button" className="text-button" disabled={!!busy || loadingModels || !configuration?.hasKey || credentialsDirty}
        onClick={refreshModels}>{loadingModels ? "正在获取模型…" : "刷新模型列表"}</button>
    </div>
    <p className="ai-model-caption" aria-label="模型列表来源">
      {catalog.source === "server" ? `服务端返回 ${catalog.models.length} 个可选模型。`
        : "当前为预设模型，保存 API key 后自动获取服务端列表。"}
      {catalog.excluded > 0 ? `已排除 ${catalog.excluded} 个 embedding 或 autocomplete 模型。` : ""}
      {configuration?.hasKey ? "修改密钥后，请先保存再刷新列表。" : ""}
    </p>
    {modelsError && <p className="ai-status-error">{modelsError}仍可从预设列表选择或手动填写。</p>}
    {selectedModel?.limit && <p className="ai-model-caption">
      配置中的上下文上限：{selectedModel.limit.context.toLocaleString()} tokens；
      输出上限：{selectedModel.limit.output.toLocaleString()} tokens。实际以服务支持为准。
    </p>}
    <p className="ai-model-caption">手动测试会发送 3 个小型请求，检查流式文本、JSON 和图片输入。三项通过后，点击「保存提供方」启用；更换密钥后需要重新测试。</p>
    {report ? <div className="api-model-checks" aria-label="所选模型测试结果">
      <p>{report.passed ? "测试通过" : "测试未通过"} · <time dateTime={report.checkedAt}>{new Date(report.checkedAt).toLocaleString("zh-CN")}</time></p>
      <ul>{[["streaming", "流式文本"], ["json", "JSON 输出"], ["image", "图片输入"]].map(([id, label]) => {
        const check = report.checks[id];
        return <li key={id}>
          <strong>{label}：{{ supported: "通过", unsupported: "不支持", failed: "未通过" }[check?.state] || "未测试"}</strong>
          {check && <span>{check.message}{Number.isFinite(check.elapsedMs) ? `（${(check.elapsedMs / 1000).toFixed(1)} 秒）` : ""}</span>}
        </li>;
      })}</ul>
    </div> : <p className="ai-model-caption">{credentialsDirty ? "请先保存 API 配置，再测试模型。" : "此模型尚未在当前 API 配置下通过测试。"}</p>}
    <p className="ai-model-caption">图片识别与参考原图注音需要所选模型支持图片输入。本连接未启用网页搜索，问答基于原文及模型知识。</p>
    {status?.lastError && <p className="ai-status-error">{status.lastError}</p>}
    <div className="ai-account-actions">
      <button className="button secondary" type="button" disabled={!!busy || credentialsDirty || !configuration?.hasKey || !model.trim()} onClick={testModel}>
        {busy === "model-test" ? "正在测试模型…" : report ? "重新测试模型" : "测试所选模型"}
      </button>
      <button className="button primary" type="button" disabled={!!busy || credentialsDirty || !report?.passed || (status.activeProviderId === status.providerId && model === configuration?.activeModel)} onClick={() => onSaveProvider(model)}>
        {busy === "provider" ? "正在保存…" : "保存提供方"}
      </button>
    </div>
  </form>;
}
