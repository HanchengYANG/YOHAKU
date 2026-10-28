export default async function api(path, options) {
  const response = await fetch(`/api${path}`, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (response.status === 204) return null;
  const result = await response
    .json()
    .catch(() => ({ error: "服务没有返回有效结果，请检查本机服务。" }));
  if (!response.ok) throw new Error(result.error || "操作未成功，请重试。");
  return result;
}
