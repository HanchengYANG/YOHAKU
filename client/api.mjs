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

// A proxy error page (not JSON) still says why it failed, with the HTTP code.
export function unreadableResponseText(status) {
  const reason = status === 413 ? "文件太大，服务器拒绝接收"
    : [502, 503].includes(status) ? "服务器没有响应，可能正在重启，请稍后重试"
      : status === 504 ? "服务器处理超时，请稍后重试"
        : status >= 500 ? "服务器出错，请稍后重试" : "服务器返回了无法识别的结果";
  return `${reason}（HTTP ${status}）。`;
}

export async function readApiResult(response) {
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: unreadableResponseText(response.status) }));
  if (result.code === "WEBSITE_AUTH_REQUIRED")
    globalThis.window?.dispatchEvent(new Event("yohaku:session-expired"));
  if (!response.ok) throw Object.assign(new Error(result.error || "操作未成功，请重试。"), {
    status: response.status, code: result.code, errorCode: result.errorCode, action: result.action,
  });
  return result;
}
