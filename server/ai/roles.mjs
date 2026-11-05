import { ROLE_IDS, ROLE_NAMES, roleReport, normalizeReasoning } from "../../shared/ai-roles.mjs";

const fail = (status, message) => Object.assign(new Error(message), { status, expose: true });
export function createRoleConfiguration({ database, ownerId, connection, preferred, managementRevision = () => 0 }) {
  database.exec(`CREATE TABLE IF NOT EXISTS ai_role_configurations (
    owner_id TEXT PRIMARY KEY, version INTEGER NOT NULL, configuration_json TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`);
  const row = () => database.prepare("SELECT * FROM ai_role_configurations WHERE owner_id=?").get(ownerId());
  function current() {
    const saved = row();
    if (!saved) return null;
    const configuration = JSON.parse(saved.configuration_json);
    configuration.roles.correction ||= { ...configuration.roles.ocr };
    configuration.roles.chaptering ||= { ...configuration.roles.segmentation };
    return { ...configuration, version: saved.version, enabled: true, updatedAt: saved.updated_at };
  }
  async function providerState(id) {
    const provider = connection(ownerId(), id);
    const account = await (provider.credentialStatus ? provider.credentialStatus() : provider.auth.status());
    const reports = provider.testReports ? await provider.testReports() : (await provider.configuration?.())?.modelChecks || [];
    const models = provider.knownModels ? await provider.knownModels() : (await provider.configuration?.())?.models || [];
    return { provider, account, reports, models: Array.isArray(models) ? models : models.models || [] };
  }
  const credentialIdentity = (account) => JSON.stringify([account.connected, account.credentialId, account.activeAccountId || account.id, account.subject]);
  async function readiness(role, selection, referenceImage, state) {
    if (!selection || !["openai", "api_base"].includes(selection.providerId) || typeof selection.model !== "string" || !selection.model || selection.model.length > 300 || /\s/.test(selection.model))
      return { ready: false, credentialsReady: false, report: null, message: "请选择提供方和模型。" };
    state ||= await providerState(selection.providerId);
    let reasoning, settingsError;
    try {
      reasoning = normalizeReasoning(selection.reasoning);
      if (reasoning) await state.provider.validateReasoning?.(selection.model, reasoning);
    } catch (error) { settingsError = error.message; }
    const report = settingsError ? null : roleReport(state.reports, selection.model, role, referenceImage, reasoning);
    const modelAvailable = state.models.some((item) => (item.id || item.model) === selection.model);
    return { ready: !!state.account.connected && modelAvailable && !settingsError && !!report?.passed,
      credentialsReady: !!state.account.connected, modelAvailable, settingsReady: !settingsError, report,
      message: !state.account.connected ? "请在 AI 设置中连接此提供方。" : !modelAvailable ? "请刷新模型目录并选择可用模型。" : settingsError || (!report?.passed ? "待测试：所选推理设置的所需能力尚未全部通过。" : "已就绪。") };
  }
  async function describe() {
    const enabled = current();
    const states = Object.fromEntries(await Promise.all(["openai", "api_base"].map(async (id) => [id, await providerState(id)])));
    const legacyProvider = preferred(), legacyState = states[legacyProvider];
    const legacyModel = legacyState.provider.runtime.status().model || (await legacyState.provider.configuration?.())?.model || legacyState.models.find((model) => model.isDefault)?.id || "";
    const configuration = enabled || { enabled: false, version: 0, annotationReferenceImage: false,
      roles: Object.fromEntries(ROLE_IDS.map((role) => [role, { providerId: legacyProvider, model: legacyModel }])) };
    const ready = Object.fromEntries(await Promise.all(ROLE_IDS.map(async (role) => [role,
      await readiness(role, configuration.roles[role], role === "annotation" && configuration.annotationReferenceImage, states[configuration.roles[role].providerId])])));
    return { ...configuration, readiness: ready, providers: Object.entries(states).map(([id, state]) => ({
      id, name: id === "openai" ? "OpenAI" : "iliad codix", enabled: true, connected: !!state.account.connected,
      models: state.models, modelChecks: state.reports,
    })) };
  }
  async function save(input) {
    const revision = managementRevision();
    if (revision === null) throw fail(409, "连接、模型目录或测试记录正在更新，请完成后再保存角色配置。");
    if (!input || !Number.isSafeInteger(input.version) || input.version < 0) throw fail(400, "缺少角色配置版本，请刷新页面。");
    const previous = current();
    if ((previous?.version || 0) !== input.version) throw fail(409, "角色配置已更新，请刷新页面后再保存。");
    if (!input.roles || typeof input.annotationReferenceImage !== "boolean") throw fail(400, "请提供完整的角色及注音参考原图设置。");
    // Preserve independent selections when older clients omit newer roles.
    const suppliedRoles = {
      ...input.roles,
      correction: input.roles.correction || previous?.roles.correction || input.roles.ocr,
      chaptering: input.roles.chaptering || previous?.roles.chaptering || input.roles.segmentation,
    };
    const roles = {}, readyStates = {}, identities = new Map(), evidence = new Map();
    for (const role of ROLE_IDS) {
      const selected = suppliedRoles[role];
      const state = selected && ["openai", "api_base"].includes(selected.providerId) ? await providerState(selected.providerId) : undefined;
      const ready = await readiness(role, selected, role === "annotation" && input.annotationReferenceImage, state);
      if (!ready.ready) throw fail(409, `${ROLE_NAMES[role]}尚未就绪：${ready.message}`);
      readyStates[role] = ready;
      const reasoning = normalizeReasoning(selected.reasoning);
      roles[role] = { providerId: selected.providerId, model: selected.model, ...(reasoning ? { reasoning } : {}) };
      const identity = credentialIdentity(state.account);
      if (identities.has(selected.providerId) && identities.get(selected.providerId) !== identity) throw fail(409, "验证期间凭据已变化，请重新测试。");
      identities.set(selected.providerId, identity);
      evidence.set(selected.providerId, JSON.stringify(state.reports));
    }
    const description = await describe();
    for (const [id, identity] of identities) {
      const provider = connection(ownerId(), id);
      const account = await (provider.credentialStatus ? provider.credentialStatus() : provider.auth.status());
      const reports = provider.testReports ? await provider.testReports() : (await provider.configuration?.())?.modelChecks || [];
      if (provider.runtime.status().testing || JSON.stringify(reports) !== evidence.get(id)) throw fail(409, "测试记录正在变化，请等待测试结束后再保存。");
      if (credentialIdentity(account) !== identity) throw fail(409, "验证期间凭据已变化，请重新测试。");
    }
    const configuration = { roles, annotationReferenceImage: input.annotationReferenceImage };
    const updatedAt = new Date().toISOString();
    if (managementRevision() !== revision) throw fail(409, "验证期间连接、模型目录或测试记录已变化，请重新读取后再保存。");
    database.exec("BEGIN IMMEDIATE");
    try {
      if ((current()?.version || 0) !== input.version) throw fail(409, "角色配置已更新，请刷新页面后再保存。");
      database.prepare(`INSERT INTO ai_role_configurations VALUES(?,?,?,?) ON CONFLICT(owner_id) DO UPDATE SET
        version=excluded.version,configuration_json=excluded.configuration_json,updated_at=excluded.updated_at`)
        .run(ownerId(), input.version + 1, JSON.stringify(configuration), updatedAt);
      database.exec("COMMIT");
    } catch (error) { database.exec("ROLLBACK"); throw error; }
    return { ...description, ...configuration, readiness: readyStates, enabled: true, version: input.version + 1, updatedAt };
  }
  return { current, describe, save, readiness };
}
