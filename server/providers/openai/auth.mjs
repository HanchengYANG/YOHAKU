import {
  randomBytes,
  randomUUID,
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  rename,
  chmod,
  lstat,
  unlink,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRemoteJWKSet, jwtVerify } from "jose";

const issuer = "https://auth.openai.com";
const resource = "https://api.openai.com/v1";
const tokenEndpoint = `${issuer}/api/accounts/oauth/token`;
const scopes =
  "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const requiredScopes = ["resource.invoke", "chatgpt.tokens.use.direct"];
const loginLifetime = 10 * 60_000;

class AuthError extends Error {
  constructor(message, status = 401) {
    super(message);
    this.status = status;
    this.expose = true;
  }
}

const random = () => randomBytes(32).toString("base64url");
const same = (a, b) => {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
const safeAccount = (record) =>
  record
    ? {
        id: record.id,
        email: record.email || null,
        subject: record.subject,
        clientId: record.client_id,
        issuer: record.issuer,
      }
    : null;

async function readJSON(path, fallback) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("unsafe");
    await chmod(path, 0o600);
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw new AuthError(
      "本机的 ChatGPT 授权记录无法读取，请检查保存目录。",
      500,
    );
  }
}

async function atomicJSON(path, value) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temporary, path);
  } catch {
    throw new AuthError(
      "无法保存本机 ChatGPT 授权，请检查保存目录后重新授权。",
      500,
    );
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

function credentials(response, previous, now) {
  const granted =
    typeof response.scope === "string"
      ? [...new Set(response.scope.split(/\s+/).filter(Boolean))]
      : previous?.scopes || [];
  if (!requiredScopes.every((scope) => granted.includes(scope))) {
    throw new AuthError(
      "本次授权未允许使用 ChatGPT 订阅额度，请重新授权并启用该权限。",
    );
  }
  if (
    typeof response.access_token !== "string" ||
    !response.access_token ||
    typeof response.expires_in !== "number" ||
    !Number.isFinite(response.expires_in) ||
    response.expires_in <= 0 ||
    response.token_type?.toLowerCase() !== "bearer"
  ) {
    throw new AuthError("ChatGPT 授权返回不完整，请重新登录。");
  }
  return {
    access_token: response.access_token,
    refresh_token:
      typeof response.refresh_token === "string"
        ? response.refresh_token
        : previous?.refresh_token || null,
    id_token:
      typeof response.id_token === "string"
        ? response.id_token
        : previous?.id_token || null,
    token_type: "Bearer",
    scopes: granted,
    expires_at: now + response.expires_in * 1000,
    saved_at: new Date(now).toISOString(),
  };
}

export function createChatGPTAuth({
  storageDir,
  callbackUri,
  fetchImpl = fetch,
  jwks: suppliedJWKS,
  now = Date.now,
} = {}) {
  const callback = new URL(callbackUri);
  if (
    callback.protocol !== "http:" ||
    callback.hostname !== "127.0.0.1" ||
    callback.pathname !== "/auth/callback" ||
    callback.search ||
    callback.hash ||
    callback.username ||
    callback.password ||
    typeof storageDir !== "string" ||
    !storageDir
  ) {
    throw new Error(
      "ChatGPT 回调必须使用 http://127.0.0.1:端口/auth/callback。",
    );
  }
  const directory = resolve(storageDir);
  const accountFile = join(directory, "chatgpt-accounts.json");
  const hostFile = join(directory, "chatgpt-host.json");
  let state,
    hostId,
    pending = null,
    lastError = null,
    discoveryPromise = null,
    remoteJWKS;
  let queue = Promise.resolve();
  const ready = (async () => {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AuthError("ChatGPT 授权目录不安全。", 500);
    await chmod(directory, 0o700);
    const host = await readJSON(hostFile, null);
    hostId = host?.ext_agent_host_id;
    if (!hostId) {
      hostId = `urn:uuid:${randomUUID()}`;
      await atomicJSON(hostFile, { ext_agent_host_id: hostId });
    }
    state = await readJSON(accountFile, {
      schemaVersion: 1,
      activeId: null,
      accounts: [],
    });
    if (
      state.schemaVersion !== 1 ||
      !Array.isArray(state.accounts) ||
      state.accounts.some(
        (a) =>
          !a ||
          typeof a.id !== "string" ||
          typeof a.client_id !== "string" ||
          typeof a.subject !== "string" ||
          a.issuer !== issuer,
      )
    ) {
      throw new AuthError("本机的 ChatGPT 授权记录格式无效。", 500);
    }
  })();
  ready.catch(() => {}); // Initialization errors remain observable through every method.
  const active = () =>
    state.accounts.find((record) => record.id === state.activeId) || null;
  const persist = async (next) => {
    await atomicJSON(accountFile, next);
    state = next;
  };
  const replaceAccount = (record) => ({
    ...state,
    accounts: state.accounts.map((a) => (a.id === record.id ? record : a)),
  });
  const exclusive = (work) => {
    const result = queue.then(async () => {
      await ready;
      return work();
    });
    queue = result.catch(() => {});
    return result;
  };

  async function request(url, options) {
    try {
      return await fetchImpl(url, {
        ...options,
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
    } catch {
      throw new AuthError("暂时无法连接 ChatGPT 授权服务，请稍后重试。", 503);
    }
  }
  async function discovery() {
    if (!discoveryPromise)
      discoveryPromise = (async () => {
        const response = await request(
          `${issuer}/.well-known/openid-configuration`,
        );
        const document = await response.json().catch(() => null);
        if (!response.ok || document?.issuer !== issuer)
          throw new AuthError("无法确认 ChatGPT 授权服务身份。", 503);
        for (const field of ["jwks_uri", "revocation_endpoint"]) {
          if (!document[field]) continue;
          let url;
          try {
            url = new URL(document[field]);
          } catch {
            throw new AuthError("ChatGPT 授权服务配置无效。", 503);
          }
          if (url.origin !== issuer || url.username || url.password)
            throw new AuthError("ChatGPT 授权服务配置无效。", 503);
        }
        if (!document.jwks_uri)
          throw new AuthError("ChatGPT 授权服务缺少签名验证配置。", 503);
        return document;
      })().catch((error) => {
        discoveryPromise = null;
        throw error;
      });
    return discoveryPromise;
  }
  async function tokenRequest(values) {
    const response = await request(tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(values),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new AuthError(
        response.status >= 500
          ? "ChatGPT 授权服务暂时不可用，请稍后重试。"
          : "ChatGPT 授权已失效或被拒绝，请重新登录。",
        response.status >= 500 ? 503 : 401,
      );
      error.invalidGrant = payload?.error === "invalid_grant";
      throw error;
    }
    if (!payload || typeof payload !== "object")
      throw new AuthError("ChatGPT 授权返回不完整，请重新登录。");
    return payload;
  }
  function statusValue() {
    const record = active();
    const connected =
      !!record?.access_token &&
      requiredScopes.every((scope) => record.scopes?.includes(scope)) &&
      (record.expires_at > now() || !!record.refresh_token);
    return {
      ...safeAccount(record),
      connected,
      requiresLogin: !connected,
      activeAccountId: record?.id || null,
      pending: !!pending && pending.expiresAt > now(),
      lastError,
    };
  }

  return {
    async status() {
      await ready;
      return statusValue();
    },
    async accounts() {
      await ready;
      return {
        accounts: state.accounts.map(safeAccount),
        activeId: state.activeId,
      };
    },
    select(id) {
      return exclusive(async () => {
        if (!state.accounts.some((record) => record.id === id))
          throw new AuthError("找不到所选的 ChatGPT 账户。", 404);
        await persist({ ...state, activeId: id });
        pending = null;
        lastError = null;
        return statusValue();
      });
    },
    start({ newAccount = false } = {}) {
      return exclusive(async () => {
        const selected = newAccount ? null : active();
        const verifier = random();
        pending = {
          state: random(),
          nonce: random(),
          verifier,
          expiresAt: now() + loginLifetime,
          accountId: selected?.id || null,
          clientId: selected?.client_id || "dynamic_agent_client",
          callbackUri: callbackUri,
        };
        const url = new URL(`${issuer}/api/accounts/authorize`);
        url.search = new URLSearchParams({
          client_id: pending.clientId,
          ext_agent_host_id: hostId,
          response_type: "code",
          redirect_uri: callbackUri,
          scope: scopes,
          resource,
          state: pending.state,
          nonce: pending.nonce,
          code_challenge_method: "S256",
          code_challenge: createHash("sha256")
            .update(verifier)
            .digest("base64url"),
        }).toString();
        if (selected?.id_token)
          url.searchParams.set("id_token_hint", selected.id_token);
        if (selected?.email) url.searchParams.set("login_hint", selected.email);
        if (!selected) url.searchParams.set("agent_name_hint", "yohaku_reader");
        lastError = null;
        return { url: url.href };
      });
    },
    callback(parameters) {
      return exclusive(async () => {
        const params =
          parameters instanceof URLSearchParams
            ? parameters
            : new URLSearchParams(parameters);
        const attempt = pending;
        if (!attempt || attempt.expiresAt <= now()) {
          pending = null;
          throw new AuthError("登录请求已过期，请重新开始授权。", 400);
        }
        if (
          params.getAll("state").length !== 1 ||
          !same(params.get("state"), attempt.state)
        )
          throw new AuthError(
            "登录校验未通过，请从本机页面重新开始授权。",
            400,
          );
        pending = null;
        try {
          if (params.has("error"))
            throw new AuthError(
              "本次 ChatGPT 授权未完成；原有账户不会被替换。",
              400,
            );
          if (
            params.getAll("code").length !== 1 ||
            !params.get("code") ||
            params.getAll("client_id").length > 1
          )
            throw new AuthError(
              "ChatGPT 登录回调不完整，请重新开始授权。",
              400,
            );
          const suppliedId = params.get("client_id");
          const clientId =
            attempt.clientId === "dynamic_agent_client"
              ? suppliedId
              : attempt.clientId;
          if (
            !clientId ||
            clientId === "dynamic_agent_client" ||
            clientId.length > 300 ||
            (attempt.clientId !== "dynamic_agent_client" &&
              suppliedId &&
              suppliedId !== attempt.clientId)
          )
            throw new AuthError(
              "ChatGPT 应用注册校验未通过，请重新开始授权。",
              400,
            );
          const response = await tokenRequest({
            grant_type: "authorization_code",
            client_id: clientId,
            code: params.get("code"),
            code_verifier: attempt.verifier,
            redirect_uri: attempt.callbackUri,
            resource,
          });
          const tokens = credentials(response, null, now());
          const doc = await discovery();
          remoteJWKS ||=
            suppliedJWKS || createRemoteJWKSet(new URL(doc.jwks_uri));
          let identity;
          try {
            const result = await jwtVerify(tokens.id_token, remoteJWKS, {
              issuer,
              audience: clientId,
              algorithms: ["RS256", "ES256"],
              clockTolerance: 5,
              currentDate: new Date(now()),
            });
            identity = result.payload;
            if (
              typeof identity.sub !== "string" ||
              !identity.sub ||
              !same(identity.nonce, attempt.nonce) ||
              typeof identity.exp !== "number" ||
              identity.exp <= now() / 1000
            )
              throw new Error("identity");
          } catch {
            throw new AuthError(
              "ChatGPT 身份签名或登录校验未通过，请重新授权。",
            );
          }
          const selected = state.accounts.find(
            (record) => record.id === attempt.accountId,
          );
          if (
            attempt.accountId &&
            (!selected ||
              selected.subject !== identity.sub ||
              selected.client_id !== clientId)
          )
            throw new AuthError(
              "返回的 ChatGPT 账户与所选账户不一致，原有授权未替换。",
            );
          const id = createHash("sha256")
            .update(`${issuer}\0${clientId}\0${identity.sub}`)
            .digest("base64url");
          const record = {
            id,
            issuer,
            subject: identity.sub,
            email: typeof identity.email === "string" ? identity.email : null,
            client_id: clientId,
            ext_agent_host_id: hostId,
            ...tokens,
          };
          const next = replaceAccount(record);
          if (!next.accounts.some((a) => a.id === id))
            next.accounts.push(record);
          next.activeId = id;
          await persist(next);
          lastError = null;
          return statusValue();
        } catch (error) {
          lastError =
            error instanceof AuthError
              ? error.message
              : "ChatGPT 授权未完成，请重新登录。";
          throw error instanceof AuthError
            ? error
            : new AuthError(lastError, 500);
        }
      });
    },
    accessToken() {
      return exclusive(async () => {
        let record = active();
        if (
          !record?.access_token ||
          !requiredScopes.every((s) => record.scopes?.includes(s))
        )
          throw new AuthError("请先使用 ChatGPT 订阅授权登录。");
        if (record.expires_at > now() + 60_000) return record.access_token;
        if (!record.refresh_token)
          throw new AuthError("ChatGPT 授权已过期，请重新登录。");
        try {
          const response = await tokenRequest({
            grant_type: "refresh_token",
            client_id: record.client_id,
            refresh_token: record.refresh_token,
            resource,
          });
          const tokens = credentials(response, record, now());
          record = { ...record, ...tokens };
          await persist(replaceAccount(record));
          lastError = null;
          return record.access_token;
        } catch (error) {
          lastError =
            error instanceof AuthError
              ? error.message
              : "无法刷新 ChatGPT 授权，请重新登录。";
          if (error.invalidGrant) {
            record = { ...record };
            for (const key of [
              "access_token",
              "refresh_token",
              "id_token",
              "expires_at",
              "saved_at",
            ])
              delete record[key];
            record.scopes = [];
            await persist(replaceAccount(record));
          }
          throw error instanceof AuthError ? error : new AuthError(lastError);
        }
      });
    },
    disconnect() {
      return exclusive(async () => {
        let record = active();
        pending = null;
        if (!record) return { revoked: true, connected: false };
        let revoked = !record.access_token;
        if (record.refresh_token) {
          try {
            const doc = await discovery();
            if (!doc.revocation_endpoint) throw new Error("revoke unavailable");
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const response = await request(doc.revocation_endpoint, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/x-www-form-urlencoded",
                  },
                  body: new URLSearchParams({
                    token: record.refresh_token,
                    token_type_hint: "refresh_token",
                    client_id: record.client_id,
                  }),
                });
                if (response.status === 200) {
                  revoked = true;
                  break;
                }
                if (response.status < 500) break;
              } catch {
                /* Retry one transient transport failure before clearing local tokens. */
              }
              if (attempt === 0)
                await new Promise((resolve) => setTimeout(resolve, 200));
            }
          } catch {
            /* Local sign out still completes; remote revocation is reported explicitly. */
          }
        }
        record = { ...record };
        for (const key of [
          "access_token",
          "refresh_token",
          "id_token",
          "expires_at",
          "saved_at",
        ])
          delete record[key];
        record.scopes = [];
        await persist(replaceAccount(record));
        lastError = revoked
          ? null
          : "本机已断开，但未能确认远端撤销。可在 ChatGPT 设置中撤销本应用。";
        return {
          revoked,
          connected: false,
          requiresManualRevocation: !revoked,
        };
      });
    },
  };
}
