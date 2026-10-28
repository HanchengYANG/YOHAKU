import test from "node:test";
import assert from "node:assert/strict";
import uploadImage from "../client/upload-image.mjs";

function fixture(t) {
  const previousRequest = globalThis.XMLHttpRequest;
  const previousWindow = globalThis.window;
  const requests = [];
  globalThis.window = new EventTarget();
  globalThis.XMLHttpRequest = class {
    constructor() { this.upload = {}; requests.push(this); }
    open(method, path) { this.method = method; this.path = path; }
    send(body) { this.body = body; }
    abort() { this.aborted = true; this.onabort?.(); }
    reply(status, result) {
      this.status = status;
      this.responseText = typeof result === "string" ? result : JSON.stringify(result);
      this.onload?.();
    }
  };
  t.after(() => {
    if (previousRequest === undefined) delete globalThis.XMLHttpRequest;
    else globalThis.XMLHttpRequest = previousRequest;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  return requests;
}

test("图片上传进度只使用浏览器实际字节，成功后清理事件而不虚构100%", async (t) => {
  const requests = fixture(t), percentages = [], body = new FormData();
  const pending = uploadImage(body, { onProgress: (value) => percentages.push(value) });
  const request = requests[0];
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/api/images");
  assert.equal(request.body, body);
  assert.equal(request.timeout, 120000);
  request.upload.onprogress({ lengthComputable: true, loaded: 27, total: 100 });
  request.upload.onprogress({ lengthComputable: false, loaded: 40, total: 0 });
  request.upload.onprogress({ lengthComputable: true, loaded: 92, total: 100 });
  request.reply(201, { id: "uploaded-image", width: 20 });
  assert.deepEqual(await pending, { id: "uploaded-image", width: 20 });
  assert.deepEqual(percentages, [27, null, 92]);
  assert.equal(request.upload.onprogress, null);
  assert.equal(request.onload, null);
});

test("图片上传取消在发送前或发送中都会结束等待，并清理进度事件", async (t) => {
  const requests = fixture(t);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(uploadImage(new FormData(), { signal: alreadyAborted.signal }), { name: "AbortError" });
  assert.equal(requests[0].body, undefined);
  const controller = new AbortController();
  const pending = uploadImage(new FormData(), { signal: controller.signal });
  const rejection = assert.rejects(pending, { name: "AbortError" });
  controller.abort();
  await rejection;
  assert.equal(requests[1].aborted, true);
  assert.equal(requests[1].upload.onprogress, null);
  assert.equal(requests[1].onabort, null);
});

test("图片上传网络、超时、服务器和无效响应都明确失败，会话失效事件保持", async (t) => {
  const requests = fixture(t);
  let expired = 0;
  window.addEventListener("yohaku:session-expired", () => { expired++; });
  for (const [respond, expected] of [
    [(request) => request.onerror(), TypeError],
    [(request) => request.ontimeout(), /上传超时/],
    [(request) => request.reply(503, { error: "测试上传失败" }), /测试上传失败/],
    [(request) => request.reply(200, "null"), /结果无效/],
    [(request) => request.reply(200, "invalid json"), /结果无效/],
    [(request) => request.reply(401, { code: "WEBSITE_AUTH_REQUIRED", error: "请先登录" }), /请先登录/],
  ]) {
    const pending = uploadImage(new FormData());
    const rejected = assert.rejects(pending, expected);
    const request = requests.at(-1);
    respond(request);
    await rejected;
    assert.equal(request.onload, null);
    assert.equal(request.upload.onprogress, null);
  }
  assert.equal(expired, 1);
});
