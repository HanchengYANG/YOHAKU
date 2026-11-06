export const NETWORK_FAILURE = "连不上服务器，请稍后重试。";

// fetch() rejects with TypeError when the server cannot be reached.
export async function apiFetch(url, options) {
  try {
    return await fetch(url, options);
  } catch (cause) {
    if (cause?.name === "TypeError") throw Object.assign(new Error(NETWORK_FAILURE), { status: 0, network: true });
    throw cause;
  }
}

export default async function api(path, options) {
  const response = await apiFetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  return readApiResult(response);
}

export async function readApiResult(response) {
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: "服务没有返回有效结果，请稍后重试。" }));
  if (result.code === "WEBSITE_AUTH_REQUIRED")
    globalThis.window?.dispatchEvent(new Event("yohaku:session-expired"));
  if (!response.ok) throw Object.assign(new Error(result.error || "操作未成功，请重试。"), {
    status: response.status, code: result.code, errorCode: result.errorCode, action: result.action,
  });
  return result;
}
