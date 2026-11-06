import { publicErrorBody } from "../errors.mjs";
// Opt-in transport keeps existing JSON callers and HTTP error codes intact.
export async function respondToChat(req, res, work) {
  if (!req.get("accept")?.includes("text/event-stream")) {
    const result = await work(null);
    res.status(result.status).json(result.conversation); return;
  }
  res.status(200).set({
    "Content-Type":"text/event-stream; charset=utf-8",
    "Cache-Control":"no-cache, no-transform", "X-Accel-Buffering":"no",
  });
  res.flushHeaders();
  const emit = async (event) => {
    if (res.destroyed || res.writableEnded) return;
    if (res.write("data: " + JSON.stringify(event) + "\n\n")) return;
    await new Promise((resolve) => {
      const done = () => { res.off("drain",done); res.off("close",done); resolve(); };
      res.once("drain",done); res.once("close",done);
    });
  };
  const heartbeat = setInterval(() => {
    if (!res.destroyed && !res.writableEnded && !res.writableNeedDrain) res.write(": keep-alive\n\n");
  },15000);
  heartbeat.unref();
  try {
    await emit({type:"status",phase:"queued"});
    const result = await work(emit);
    await emit({type:"done",conversation:result.conversation});
  } catch (cause) {
    const { status, body } = publicErrorBody(cause, {
      errorLog: req.app.locals.errorLog, userId: req.user?.id ?? null, scope: "chat",
      location: `${req.method} ${req.originalUrl.split("?")[0]}`,
    });
    await emit({ type: "error", status, code: cause?.code, ...body });
  } finally {
    clearInterval(heartbeat);
    if (!res.destroyed && !res.writableEnded) res.end();
  }
}
