// Fetch exposes byte chunks, which need not align with UTF-8 or SSE frames.
export async function* readEventStream(body, { maxBytes = 16_000_000 } = {}) {
  if (!body) throw new Error("没有收到事件流。");
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = "", data = [], event = "message", bytes = 0, finished = false;
  function line(value) {
    if (!value) {
      const frame = data.length ? { event, data:data.join("\n") } : null;
      data = []; event = "message"; return frame;
    }
    if (value.startsWith(":")) return null;
    const colon = value.indexOf(":"), field = colon < 0 ? value : value.slice(0,colon);
    let text = colon < 0 ? "" : value.slice(colon+1);
    if (text.startsWith(" ")) text = text.slice(1);
    if (field === "data") data.push(text);
    if (field === "event") event = text;
    return null;
  }
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) { buffer += decoder.decode(); break; }
      bytes += chunk.value.byteLength;
      if (bytes > maxBytes) throw new Error("事件流过长，请缩小问题后重试。");
      buffer += decoder.decode(chunk.value,{stream:true});
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const frame = line(buffer.slice(0,end).replace(/\r$/, "")); buffer = buffer.slice(end+1);
        if (frame) yield frame;
      }
    }
    if (buffer) { const frame = line(buffer.replace(/\r$/, "")); if (frame) yield frame; }
    const tail = line(""); if (tail) yield tail;
    finished = true;
  } finally {
    if (!finished) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
