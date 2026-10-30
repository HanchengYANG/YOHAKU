// XMLHttpRequest exposes actual upload bytes; model requests still use fetch.
export default function uploadImage(body, { signal, onProgress, path = "/images" } = {}) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    let settled = false;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      request.onload = request.onerror = request.onabort = request.ontimeout = null;
      request.upload.onprogress = null;
      if (error) reject(error);
      else resolve(result);
    };
    const abort = () => {
      request.abort();
      finish(new DOMException("图片上传已取消。", "AbortError"));
    };
    if (signal?.aborted) {
      finish(new DOMException("图片上传已取消。", "AbortError"));
      return;
    }
    request.open("POST", `/api${path}`);
    request.timeout = 120000;
    request.upload.onprogress = (event) => {
      onProgress?.(event.lengthComputable && event.total > 0
        ? Math.min(100, Math.floor(event.loaded / event.total * 100))
        : null);
    };
    request.onload = () => {
      let result;
      try { result = JSON.parse(request.responseText); }
      catch { result = { error: "图片上传未完成，请重试。" }; }
      if (result?.code === "WEBSITE_AUTH_REQUIRED")
        window.dispatchEvent(new Event("yohaku:session-expired"));
      if (request.status < 200 || request.status >= 300) {
        finish(Object.assign(new Error(result?.error || "图片上传未完成，请重试。"), { status: request.status, code: result?.code }));
      } else if (typeof result?.id !== "string") {
        finish(new Error("图片上传结果无效，请重试。"));
      } else finish(null, result);
    };
    request.onerror = () => finish(new TypeError("图片上传网络连接失败。"));
    request.onabort = () => finish(new DOMException("图片上传已取消。", "AbortError"));
    request.ontimeout = () => finish(new Error("图片上传超时，所选图片已保留，请重试。"));
    signal?.addEventListener("abort", abort, { once: true });
    try { request.send(body); }
    catch (error) { finish(error); }
  });
}
