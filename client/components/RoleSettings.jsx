import { useEffect, useRef, useState } from "react";
import api from "../api.mjs";
import { requiredCapabilities, normalizeReasoning, reasoningKey } from "../../shared/ai-roles.mjs";

const ROLES = [
  { id: "ocr", name: "OCR" },
  { id: "annotation", name: "注音" },
  { id: "segmentation", name: "分句" },
  { id: "chat", name: "问答" },
];
const labels = { json: "JSON 输出", image: "图片输入", streaming: "流式文本" };
const effortLabels = { none: "关闭推理（none）", minimal: "最低（minimal）", low: "低（low）", medium: "中（medium）", high: "高（high）", xhigh: "很高（xhigh）", max: "最高（max）" };

function reasoningOptions(model) {
  const options = model?.reasoningOptions || {};
  return { ...options, efforts: Array.isArray(options.efforts) ? options.efforts : [] };
}
function reasoningError(selection, model) {
  let value;
  try { value = normalizeReasoning(selection?.reasoning); }
  catch (cause) { return cause.message; }
  if (!value) return "";
  const options = reasoningOptions(model);
  if (value.effort !== undefined && !options.efforts.includes(value.effort))
    return "当前模型目录不支持已选推理强度，请选择模型默认或其他可用强度。";
  if (value.enabled !== undefined && (options.toggle !== true || typeof value.enabled !== "boolean"))
    return "当前模型目录不支持已保存的推理开关，请使用服务默认。";
  if (value.budgetTokens !== undefined && (!options.budget || !Number.isSafeInteger(value.budgetTokens)
    || value.budgetTokens < options.budget.min || value.budgetTokens > options.budget.max))
    return "推理预算不在当前模型支持的范围内，请修改预算或使用服务默认。";
  return "";
}
const testKey = (selection) => JSON.stringify([selection.providerId, selection.model, reasoningKey(selection.reasoning)]);

function selectionErrors(roles, providers) {
  return Object.fromEntries(ROLES.flatMap(({ id }) => {
    const selected = roles[id], provider = providers.find((item) => item.id === selected?.providerId);
    const message = !provider?.connected ? "此提供方尚未连接，请先在 AI 设置中完成连接。"
      : !selected?.model ? "请选择模型。"
      : !provider.models?.some((model) => model.id === selected.model) ? "模型不在当前目录中，请刷新目录后重新选择。"
      : reasoningError(selected, provider.models.find((model) => model.id === selected.model));
    return message ? [[id, message]] : [];
  }));
}

export default function RoleSettings({ onClose }) {
  const [configuration, setConfiguration] = useState(null);
  const [draft, setDraft] = useState({});
  const [referenceImage, setReferenceImage] = useState(false);
  const [providers, setProviders] = useState([]);
  const [busy, setBusy] = useState("loading");
  const [error, setError] = useState("");
  const [rowErrors, setRowErrors] = useState({});
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const pending = useRef(false);
  const saveController = useRef(null);
  const accept = (value) => {
    setConfiguration(value);
    setDraft(value.roles);
    setReferenceImage(value.annotationReferenceImage === true);
    setProviders(value.providers.filter((provider) => provider.enabled !== false));
    setRowErrors({});
  };
  useEffect(() => {
    mounted.current = true;
    const controller = new AbortController();
    api("/ai/roles", { signal: controller.signal }).then((value) => {
      if (!controller.signal.aborted) accept(value);
    }).catch((cause) => {
      if (!controller.signal.aborted) setError(cause.message);
    }).finally(() => { if (!controller.signal.aborted) setBusy(""); });
    return () => {
      mounted.current = false;
      controller.abort();
      saveController.current?.abort();
    };
  }, []);

  const perform = async (action, work, role) => {
    if (busy || pending.current) return;
    pending.current = true;
    setBusy(action);
    setError("");
    setNotice("");
    if (role) setRowErrors((current) => ({ ...current, [role]: "" }));
    try { await work(); }
    catch (cause) {
      if (mounted.current) {
        if (role) setRowErrors((current) => ({ ...current, [role]: cause.message }));
        else setError(cause.message);
      }
    } finally {
      pending.current = false;
      if (mounted.current) setBusy("");
    }
  };
  const selectedProvider = (id) => providers.find((provider) => provider.id === draft[id]?.providerId);
  const choose = (id, change) => {
    setDraft((current) => ({ ...current, [id]: { ...current[id], ...change } }));
    setRowErrors((current) => ({ ...current, [id]: "" }));
    setNotice("");
  };
  const changeReasoning = (id, field, value) => {
    const reasoning = { ...draft[id]?.reasoning };
    if (value === undefined) delete reasoning[field];
    else reasoning[field] = value;
    choose(id, { reasoning: Object.keys(reasoning).length ? reasoning : undefined });
  };
  const refreshModels = (role) => perform(`models:${role.id}`, async () => {
    const providerId = draft[role.id].providerId;
    const value = await api(`/ai/models?providerId=${encodeURIComponent(providerId)}&role=${role.id}`);
    if (!mounted.current) return;
    setProviders((current) => current.map((provider) => provider.id === providerId
      ? { ...provider, models: value.models } : provider));
    setNotice(`已刷新 ${selectedProvider(role.id)?.name || providerId} 模型目录，共 ${value.models.length} 个模型。`);
  }, role.id);
  const save = (event) => {
    event.preventDefault();
    perform("validate", async () => {
      setRowErrors({});
      const controller = new AbortController();
      saveController.current = controller;
      const options = { signal: controller.signal };
      try {
        // Check the draft version and current credentials before any inference.
        const latest = await api("/ai/roles", options);
        if (latest.version !== configuration.version) throw new Error("角色配置已更新，请重新读取配置后再保存。");
        setProviders(latest.providers.filter((provider) => provider.enabled !== false));
        const selections = selectionErrors(draft, latest.providers);
        if (Object.keys(selections).length) { setRowErrors(selections); return; }
        const selectedRoles = Object.fromEntries(ROLES.map(({ id }) => {
          const { reasoning: previousReasoning, ...selection } = draft[id];
          const reasoning = normalizeReasoning(previousReasoning);
          return [id, { ...selection, ...(reasoning ? { reasoning } : {}) }];
        }));
        // Only reuse checks performed during this save attempt. One JSON check
        // can serve multiple text roles sharing the same credentials/model.
        const tested = new Map();
        for (const role of ROLES) {
          const selection = selectedRoles[role.id], image = role.id === "annotation" && referenceImage;
          const needed = requiredCapabilities(role.id, image);
          const key = testKey(selection);
          const checks = tested.get(key) || {};
          if (needed.some((name) => !Object.hasOwn(checks, name))) {
            try {
              const report = await api("/ai/models/test", { ...options, method: "POST", body: JSON.stringify({
                ...selection, role: role.id, referenceImage: image,
              }) });
              for (const name of needed) checks[name] = report.checks?.[name]
                || { state: "failed", message: "未完成验证，请重试。" };
            } catch (cause) {
              controller.signal.throwIfAborted();
              if (cause.code === "WEBSITE_AUTH_REQUIRED") throw cause;
              for (const name of needed) checks[name] = { state: "failed", message: cause.message };
            }
          }
          tested.set(key, checks);
        }
        const failures = Object.fromEntries(ROLES.flatMap((role) => {
          const selection = selectedRoles[role.id], checks = tested.get(testKey(selection));
          const failed = requiredCapabilities(role.id, role.id === "annotation" && referenceImage)
            .filter((name) => checks[name]?.state !== "supported")
            .map((name) => `${labels[name]}${checks[name]?.state === "unsupported" ? "不支持" : "未通过"}：${checks[name]?.message || "请重试。"}`);
          return failed.length ? [[role.id, `${role.name}：${failed.join("；")}`]] : [];
        }));
        if (Object.keys(failures).length) { setRowErrors(failures); return; }
        controller.signal.throwIfAborted();
        setBusy("save");
        const value = await api("/ai/roles", { ...options, method: "PUT", body: JSON.stringify({
          version: configuration.version, roles: selectedRoles, annotationReferenceImage: referenceImage,
        }) });
        if (!mounted.current) return;
        accept(value);
        setNotice("角色配置已保存。");
      } finally { if (saveController.current === controller) saveController.current = null; }
    });
  };
  return <section className="stage2-page ai-role-settings" aria-label="角色配置">
    <div className="stage2-heading">
      <div><span className="eyebrow">阅读助手</span><h1>角色配置</h1></div>
      <button type="button" className="button subtle" disabled={!!busy} onClick={onClose}>返回</button>
    </div>
    <p className="stage2-description">保存时自动验证所选模型，全部通过后统一生效。</p>
    {error && <div className="stage2-error" role="alert">{error}
      <button type="button" className="text-button" disabled={!!busy}
        onClick={() => perform("reload", async () => { accept(await api("/ai/roles")); })}>重新读取配置</button>
    </div>}
    {!configuration && busy === "loading" && <p role="status">正在读取角色配置…</p>}
    {configuration && <form className="ai-role-form" onSubmit={save} noValidate>
      <div className="ai-role-list">
        {ROLES.map((role) => {
          const selection = draft[role.id] || {}, provider = selectedProvider(role.id), models = provider?.models || [];
          const model = models.find((item) => item.id === selection.model), options = reasoningOptions(model);
          let reasoning;
          try { reasoning = normalizeReasoning(selection.reasoning) || {}; }
          catch { reasoning = selection.reasoning || {}; }
          const hasReasoning = Object.keys(reasoning).length > 0;
          const showAdvanced = options.efforts.length > 0 || options.toggle === true || !!options.budget || hasReasoning;
          const unsupportedReasoning = reasoningError(selection, model);
          return <section className="ai-role-row" key={role.id} aria-label={`${role.name}角色`}>
            <h2>{role.name}</h2>
            <div className="ai-role-fields">
              <label className="stage2-field">提供方
                <select aria-label={`${role.name}提供方`} value={selection.providerId || ""} disabled={!!busy}
                  onChange={(event) => {
                    const next = providers.find((item) => item.id === event.target.value);
                    choose(role.id, { providerId: event.target.value, model: next?.models?.[0]?.id || "", reasoning: undefined });
                  }}>
                  {!selection.providerId && <option value="">选择提供方</option>}
                  {providers.map((item) => <option value={item.id} key={item.id}>{item.name || item.id}</option>)}
                </select>
              </label>
              <label className="stage2-field">模型
                <select aria-label={`${role.name}模型`} value={selection.model || ""} disabled={!!busy}
                  onChange={(event) => choose(role.id, { model: event.target.value, reasoning: undefined })}>
                  {!selection.model && <option value="">请刷新目录并选择模型</option>}
                  {selection.model && !models.some((model) => model.id === selection.model) &&
                    <option value={selection.model}>{selection.model}（请刷新目录确认）</option>}
                  {models.map((model) => <option key={model.id} value={model.id}>
                    {model.name && model.name !== model.id ? `${model.name} · ${model.id}` : model.id}
                  </option>)}
                </select>
              </label>
            </div>
            <button type="button" className="text-button ai-role-refresh" aria-label="刷新模型目录"
              disabled={!!busy || !provider?.connected} onClick={() => refreshModels(role)}>
              {busy === `models:${role.id}` ? "刷新中…" : "刷新"}
            </button>
            {role.id === "annotation" && <label className="ai-role-image-option" title="没有原图的文章仍按文字处理。">
              <input type="checkbox" checked={referenceImage} disabled={!!busy}
                onChange={(event) => {
                  setReferenceImage(event.target.checked);
                  setRowErrors((current) => ({ ...current, annotation: "" }));
                  setNotice("");
                }} />参考原图
            </label>}
            {role.id === "chat" && <small className="ai-role-note">
              {selection.providerId === "openai" ? "使用网页工具" : "未联网"}
            </small>}
            {showAdvanced && <details className="ai-role-advanced" key={`${selection.providerId}:${selection.model}`}>
              <summary>高级设置{hasReasoning ? <span>已自定义</span> : null}</summary>
              <div className="ai-role-reasoning-fields">
                {options.efforts.length > 0 && <label className="stage2-field">推理强度
                  <select aria-label={`${role.name}推理强度`} value={reasoning.effort || ""} disabled={!!busy}
                    onChange={(event) => changeReasoning(role.id, "effort", event.target.value || undefined)}>
                    <option value="">模型默认</option>
                    {reasoning.effort && !options.efforts.includes(reasoning.effort) &&
                      <option value={reasoning.effort}>{reasoning.effort}（当前目录不支持）</option>}
                    {options.efforts.map((effort) => <option key={effort} value={effort}>{effortLabels[effort] || effort}</option>)}
                  </select>
                </label>}
                {options.toggle === true && <label className="stage2-field">推理开关
                  <select aria-label={`${role.name}推理开关`}
                    value={reasoning.enabled === true ? "enabled" : reasoning.enabled === false ? "disabled" : ""}
                    disabled={!!busy} onChange={(event) => changeReasoning(role.id, "enabled",
                      event.target.value === "" ? undefined : event.target.value === "enabled")}>
                    <option value="">服务默认</option>
                    <option value="enabled">开启</option><option value="disabled">关闭</option>
                  </select>
                </label>}
                {options.budget && <label className="stage2-field">推理预算（tokens）
                  <input type="number" aria-label={`${role.name}推理预算`} min={options.budget.min}
                    max={options.budget.max} step="1" value={reasoning.budgetTokens ?? ""}
                    placeholder="服务默认" disabled={!!busy}
                    onChange={(event) => changeReasoning(role.id, "budgetTokens", event.target.value === ""
                      ? undefined : Number(event.target.value))} />
                  <small>{options.budget.min}–{options.budget.max} tokens；留空使用服务默认。</small>
                </label>}
              </div>
              {unsupportedReasoning && <p className="ai-role-reasoning-warning">{unsupportedReasoning}
                {!options.efforts.length && reasoning.effort !== undefined && <span> 已保存强度：{String(reasoning.effort)}。</span>}
                {!options.toggle && reasoning.enabled !== undefined && <span> 已保存开关：{reasoning.enabled ? "开启" : "关闭"}。</span>}
                {!options.budget && reasoning.budgetTokens !== undefined && <span> 已保存预算：{String(reasoning.budgetTokens)} tokens。</span>}
              </p>}
              {hasReasoning && <button type="button" className="text-button ai-role-reasoning-reset" disabled={!!busy}
                onClick={() => choose(role.id, { reasoning: undefined })}>使用服务默认</button>}
            </details>}
            {rowErrors[role.id] && <p className="ai-status-error ai-role-error" role="alert">{rowErrors[role.id]}</p>}
          </section>;
        })}
      </div>
      <div className="ai-role-save">
        <p role={notice || busy === "validate" ? "status" : undefined}>{notice || (busy === "validate"
          ? "正在验证所选模型，请稍候…" : configuration.enabled ? "修改后保存生效。" : "首次保存前沿用现有 AI 配置。")}</p>
        <button className="button primary" type="submit" disabled={!!busy}>
          {busy === "validate" ? "正在验证角色…" : busy === "save" ? "正在保存…" : "保存角色配置"}
        </button>
      </div>
    </form>}
  </section>;
}
