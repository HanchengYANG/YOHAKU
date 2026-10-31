import { randomUUID } from "node:crypto";
import { CHAT_INSTRUCTIONS } from "./runtime.mjs";
import { readEventStream } from "../../../shared/event-stream.mjs";

const failure = (message, status = 502) => Object.assign(new Error(message), { status, expose: true });
function publicUrl(value) {
  try { const url = new URL(value); return ["https:", "http:"].includes(url.protocol) ? url.href : null; } catch { return null; }
}
export function presentWebResponse(response) {
  if (response?.status !== "completed" || !Array.isArray(response.output)) throw failure("AI 联网回答未完整完成，未保存部分输出，请重试。");
  if (response.output.some((item) => item.type === "web_search_call" && item.status && item.status !== "completed")) throw failure("网页搜索失败或未完成，未保存未核实的联网答案，请重试。");
  if (response.output.some((item) => item.type === "message" && item.role === "assistant" && item.status && item.status !== "completed")) throw failure("AI 联网回答未完整完成，未保存部分输出，请重试。");
  const searches = response.output.filter((item) => item.type === "web_search_call" && item.status === "completed");
  const sources = new Map();
  const remember = (source) => {
    const url = publicUrl(source?.url);
    if (url) sources.set(url, { url, title: String(source.title || url).slice(0, 500) });
  };
  for (const search of searches) {
    (search.action?.sources || []).forEach(remember);
    if (search.action?.url) remember({ url: search.action.url });
  }
  const messages = response.output.filter((item) => item.type === "message" && item.role === "assistant");
  const final = messages.some((item) => item.phase === "final_answer") ? messages.filter((item) => item.phase === "final_answer") : messages;
  const text = final.flatMap((item) => item.content || []).filter((part) => part.type === "output_text").map((part) => {
    let text = part.text || "";
    for (const annotation of [...(part.annotations || [])].sort((a, b) => b.start_index - a.start_index)) {
      if (annotation.type !== "url_citation") continue;
      remember(annotation);
      const url = publicUrl(annotation.url), from = annotation.start_index, to = annotation.end_index;
      if (!url || !Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 0 || to <= from || to > text.length) continue;
      const label = String(annotation.title || "来源").replace(/[\[\]\r\n]/g, "");
      const link = `[${label}](${url.replaceAll(")", "%29")})`;
      // Native markers are transport metadata. Preserve actual prose when an
      // annotation instead points at a normal span of the answer.
      const cited = text.slice(from, to);
      text = text.slice(0, from) + (cited.includes("") ? link : `${cited} ${link}`) + text.slice(to);
    }
    return text.replace(/cite[^]+/g, "");
  }).join("\n");
  if (!text.trim()) throw failure("AI 没有返回完整的联网答案，请重试。");
  return { text, model: response.model, sources: searches.length ? [...sources.values()].slice(0, 100) : [],
    webSearch: { enabled: true, performed: !!searches.length, transport: "responses", queries: searches.flatMap((item) => item.action?.queries || (item.action?.query ? [item.action.query] : [])) }, completed: true };
}

// The verified 0.160.1 CLI alpha/search endpoint rejects SIWC tokens.
// Hosted Responses web_search accepts the same subscription token. Only this
// one hosted tool is offered; no local tools, files or execution are available.
export function createWebRuntime({ auth, fetchImpl = fetch, turnTimeoutMs = 180000 } = {}) {
  let controller = null, lastError = null, lastSuccessfulAt = null;
  const accountId = (account) => account.activeAccountId || account.id;
  function check(account, expected) {
    if (!account.connected) throw failure("请先连接网站共享 ChatGPT 订阅授权。", 401);
    if ((expected.expectedAccountId && accountId(account) !== expected.expectedAccountId) || (expected.expectedSubject && account.subject !== expected.expectedSubject)) throw failure("AI 授权身份已变化，请重新发起请求。", 409);
  }
  async function run({ prompt, model, threadId, expectedAccountId, expectedSubject, signal, onEvent } = {}) {
    if (controller) throw failure("AI 正在处理请求，请稍后重试。", 409);
    if (typeof prompt !== "string" || !prompt.trim() || typeof model !== "string" || !model.trim()) throw failure("联网问答缺少问题或有效模型。", 400);
    const active = new AbortController(); controller = active;
    const abort = () => active.abort(signal.reason);
    if (signal?.aborted) abort(); else signal?.addEventListener("abort", abort, {once:true});
    const timer = setTimeout(() => active.abort(), turnTimeoutMs);
    let token;
    try {
      active.signal.throwIfAborted();
      const expected = { expectedAccountId, expectedSubject }, first = await auth.status(); check(first, expected);
      token = await auth.accessToken();
      const confirmed = await auth.status(); check(confirmed, expected);
      if (accountId(first) !== accountId(confirmed) || active.signal.aborted) throw failure("AI 授权身份已变化或请求已停止，请重试。", 409);
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST", signal: active.signal,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions: CHAT_INSTRUCTIONS,
          input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
          tools: [{ type: "web_search", external_web_access: true }],
          include: ["web_search_call.action.sources"], store: false, stream: true }),
      });
      if (!response.ok) throw failure(response.status === 401 ? "联网问答授权失败，请重新连接共享订阅后重试。" : `联网问答服务返回 ${response.status}，请重试。`, response.status === 429 ? 429 : 502);
      if (!response.body) throw failure("联网问答没有返回事件流，请重试。");
      const items = new Map(), previews = new Map(); let completed = null, visible = "";
      const publish = async () => {
        const all = [...previews.values()].sort((a,b) => a.index-b.index);
        const final = all.some((item) => item.phase === "final_answer");
        const text = all.filter((item) => item.role === "assistant" && item.type === "message" &&
          (final ? item.phase === "final_answer" : !item.phase))
          .map((item) => [...item.parts.entries()].sort((a,b) => a[0]-b[0]).map(([,text]) => text).join(""))
          .join("\n").replace(/[^]*/g, "").replace(/[^]*$/, "");
        if (text === visible) return;
        const event = text.startsWith(visible) ? {type:"delta",delta:text.slice(visible.length)} : {type:"text",text};
        visible = text; await onEvent?.(event);
      };
      for await (const frame of readEventStream(response.body)) {
        if (frame.data === "[DONE]") continue;
        let event; try { event = JSON.parse(frame.data); } catch { throw failure("联网回答事件格式无效，未保存部分输出，请重试。"); }
        if (["response.failed", "response.incomplete", "error"].includes(event.type)) throw failure("联网问答失败或中断，未保存部分输出，请重试。");
        if (event.type?.startsWith("response.web_search_call.")) await onEvent?.({type:"status",phase:"searching"});
        if (["response.output_item.added","response.output_item.done"].includes(event.type) && event.item?.id) {
          const previous = previews.get(event.item.id);
          const item = {...previous,...event.item,index:event.output_index ?? previous?.index ?? previews.size,parts:previous?.parts || new Map()};
          (event.item.content || []).forEach((part,index) => { if (part.type === "output_text") item.parts.set(index,part.text || ""); });
          previews.set(event.item.id,item);
          if (event.type === "response.output_item.done") items.set(event.item.id,event.item);
          await publish();
        }
        if (event.type === "response.output_text.delta" || event.type === "response.output_text.done") {
          let item = previews.get(event.item_id);
          if (!item) { item = {index:event.output_index ?? previews.size,parts:new Map()}; previews.set(event.item_id,item); }
          const index = event.content_index ?? 0;
          item.parts.set(index,event.type.endsWith(".delta") ? (item.parts.get(index) || "") + event.delta : event.text || "");
          await publish();
        }
        if (event.type === "response.completed") completed = event.response;
      }
      if (active.signal.aborted) throw failure("联网问答已停止或超时，未保存部分输出，请重试。");
      const checked = await auth.status(); check(checked, expected);
      if (active.signal.aborted) throw failure("联网问答已停止或超时，未保存部分输出，请重试。");
      if (accountId(checked) !== accountId(first)) throw failure("AI 授权身份已变化，请重新发起请求。", 409);
      // SIWC streams may omit output from the terminal snapshot. Completed
      // item events are usable only after the response itself completes.
      const result = presentWebResponse(completed && { ...completed, output: completed.output?.length ? completed.output : [...items.values()] });
      lastError = null; lastSuccessfulAt = new Date().toISOString();
      return { ...result, threadId: threadId?.startsWith("responses:") ? threadId : `responses:${randomUUID()}` };
    } catch (cause) {
      const safe = String(cause.message || "联网问答失败").replaceAll(token || "\u0000", "[已隐藏]").replace(/Bearer\s+\S+/gi, "Bearer [已隐藏]").slice(0, 700);
      lastError = active.signal.aborted ? "联网问答已停止或超时，未保存部分输出，请重试。" : safe;
      throw failure(lastError, cause.status || 502);
    } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); if (controller === active) controller = null; }
  }
  return { run, stop: () => controller?.abort(), status: () => ({ busy: !!controller, lastError, lastSuccessfulAt }) };
}
