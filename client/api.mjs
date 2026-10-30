export default async function api(path, options) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: "服务没有返回有效结果，请检查本机服务。" }));
  if (result.code === "WEBSITE_AUTH_REQUIRED")
    window.dispatchEvent(new Event("yohaku:session-expired"));
  if (!response.ok) throw Object.assign(new Error(result.error || "操作未成功，请重试。"), {
    status: response.status, code: result.code,
  });
  return result;
}
