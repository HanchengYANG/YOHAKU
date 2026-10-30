const failure = (code, message) => Object.assign(new Error(message), {
  code, status: code === "AI_BUSY" ? 409 : 503, expose: true,
});

// A single execution slot shared by foreground requests and background steps.
// Alternate when both queues have work, so neither side can starve the other.
export function createOperationQueue() {
  const interactive = [], background = [], idle = new Set();
  let active = false, closed = false, interactiveTurns = 0;
  const stopped = () => failure("AI_STOPPED", "AI 服务正在停止，请稍后重试。");
  const abortError = (signal) => signal.reason instanceof Error
    ? signal.reason : new DOMException("请求已取消。", "AbortError");
  function notifyIdle() {
    if (active || interactive.length || background.length) return;
    for (const resolve of idle) resolve();
    idle.clear();
  }
  async function drain() {
    if (active || closed) { notifyIdle(); return; }
    const queue = interactive.length && (!background.length || interactiveTurns < 1)
      ? interactive : background.length ? background : interactive;
    const entry = queue.shift();
    if (!entry) { notifyIdle(); return; }
    entry.signal?.removeEventListener("abort", entry.onAbort);
    if (entry.signal?.aborted) {
      entry.reject(abortError(entry.signal));
      queueMicrotask(drain);
      return;
    }
    active = true;
    interactiveTurns = queue === interactive ? interactiveTurns + 1 : 0;
    try { entry.resolve(await entry.work()); }
    catch (error) { entry.reject(error); }
    finally {
      active = false;
      if (closed) notifyIdle();
      else setImmediate(drain);
    }
  }
  return {
    run(work, { priority = "interactive", signal, wait = true } = {}) {
      if (closed) return Promise.reject(stopped());
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (!wait && (active || interactive.length || background.length))
        return Promise.reject(failure("AI_BUSY", "AI 正在处理请求，请完成后重试。"));
      const queue = priority === "background" ? background : interactive;
      return new Promise((resolve, reject) => {
        const entry = { work, resolve, reject, signal };
        entry.onAbort = () => {
          const index = queue.indexOf(entry);
          if (index < 0) return;
          queue.splice(index, 1);
          reject(abortError(signal));
          notifyIdle();
        };
        signal?.addEventListener("abort", entry.onAbort, { once: true });
        queue.push(entry);
        queueMicrotask(drain);
      });
    },
    status: () => ({ active, waiting: interactive.length + background.length }),
    whenIdle: () => active || interactive.length || background.length
      ? new Promise((resolve) => idle.add(resolve)) : Promise.resolve(),
    close() {
      closed = true;
      for (const entry of [...interactive.splice(0), ...background.splice(0)]) {
        entry.signal?.removeEventListener("abort", entry.onAbort);
        entry.reject(stopped());
      }
      notifyIdle();
    },
  };
}
