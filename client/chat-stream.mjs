import { apiFetch, readApiResult } from "./api.mjs";
import { readEventStream } from "../shared/event-stream.mjs";

export async function sendChat(path, { body, signal, onEvent } = {}) {
  const response = await apiFetch(`/api${path}`, {
    method:"POST", signal, body,
    headers:{"Content-Type":"application/json",Accept:"text/event-stream"},
  });
  if (!response.ok || !response.headers.get("content-type")?.includes("text/event-stream")) return readApiResult(response);
  let result;
  for await (const frame of readEventStream(response.body)) {
    let event;
    try { event = JSON.parse(frame.data); }
    catch { throw new Error("回答传输中断，未完成的内容没有保存。请重试。"); }
    if (event.type === "error") throw Object.assign(new Error(event.error || "回答中断，请重试。"), {status:event.status,code:event.code,errorCode:event.errorCode,action:event.action});
    if (event.type === "done") result = event.conversation;
    else onEvent?.(event);
  }
  if (!result) throw new Error("回答传输中断，未完成的内容没有保存。请重试。");
  return result;
}
