const failure = (code, message) => Object.assign(new Error(message), {
  code, status: code === 'AI_BUSY' ? 409 : code === 'AI_TIMEOUT' ? 504 : 503, expose: true,
  ...(code === 'AI_TIMEOUT' ? {diagnostic:{code:'AI_TIMEOUT',category:'timeout'}} : {}),
});

// Resource limits belong here; dependency ordering belongs to each caller.
export function createOperationQueue({ concurrency = 1, maxPerGroup = Infinity, timeoutMs = 0 } = {}) {
  concurrency = Math.max(1, Math.floor(Number(concurrency) || 1));
  const pending = [], active = new Set(), idle = new Set(), served = new Map();
  let closed = false, foregroundTurns = 0, interactiveTurns = 0, sequence = 0;
  const stopped = () => failure('AI_STOPPED', 'AI 服务正在停止，请稍后重试。');
  const abortError = (signal) => signal.reason instanceof Error
    ? signal.reason : new DOMException('请求已取消。', 'AbortError');
  function notifyIdle() {
    if (active.size || pending.length) return;
    for (const resolve of idle) resolve();
    idle.clear();
  }
  function priority(entry) {
    const value = entry.getPriority?.() ?? (typeof entry.priority === 'function' ? entry.priority() : entry.priority);
    return ['foreground','background'].includes(value) ? value : 'interactive';
  }
  function select() {
    if ([...active].some(entry => entry.exclusive)) return null;
    const available = pending.filter(entry => !entry.exclusive || !active.size).filter(entry => entry.canStart?.() !== false).filter(entry =>
      !entry.groupKey || [...active].filter(item => item.groupKey === entry.groupKey).length < maxPerGroup);
    if (!available.length) return null;
    const foreground = available.filter(entry => priority(entry) === 'foreground');
    const background = available.filter(entry => priority(entry) === 'background');
    const interactive = available.filter(entry => priority(entry) === 'interactive');
    const candidates = background.length && foregroundTurns >= 3 ? background
      : foreground.length ? foreground
      : interactive.length && (!background.length || interactiveTurns < 1) ? interactive
      : background.length ? background : foreground.length ? foreground : interactive;
    const ordered=[...candidates].sort((a,b)=>(served.get(a.groupKey || a) || 0)-(served.get(b.groupKey || b) || 0));
    for(const entry of ordered){
      try {
        const release=entry.acquire?.();
        if(release===false)continue;
        entry.releaseResource=release;return entry;
      } catch(error) {
        pending.splice(pending.indexOf(entry),1);entry.signal?.removeEventListener('abort',entry.onAbort);entry.reject(error);
      }
    }
    return null;
  }
  async function execute(entry) {
    active.add(entry);
    pending.splice(pending.indexOf(entry), 1);
    entry.signal?.removeEventListener('abort', entry.onAbort);
    const selected = priority(entry);
    foregroundTurns = selected === 'foreground' ? foregroundTurns + 1 : 0;
    interactiveTurns = selected === 'interactive' ? interactiveTurns + 1 : 0;
    served.set(entry.groupKey || entry, ++sequence);
    const controller = new AbortController();
    const abort = () => controller.abort(abortError(entry.signal));
    if (entry.signal?.aborted) abort(); else entry.signal?.addEventListener('abort', abort, { once:true });
    const {executionBudget} = entry;
    const budgetStartedAt = executionBudget ? performance.now() : null;
    const duration = executionBudget?.remainingMs ?? entry.timeoutMs ?? timeoutMs;
    const timeout = () => controller.abort(failure('AI_TIMEOUT', 'AI 执行超时，请重试当前步骤。'));
    if (executionBudget && duration <= 0) timeout();
    const timer = duration > 0 ? setTimeout(timeout, duration) : null;
    let rejectAbort;
    const aborted = new Promise((_,reject) => { rejectAbort = () => reject(abortError(controller.signal));
      if (controller.signal.aborted) rejectAbort(); else controller.signal.addEventListener('abort', rejectAbort, {once:true}); });
    try { entry.resolve(await Promise.race([Promise.resolve().then(() => {
      controller.signal.throwIfAborted(); return entry.work({ signal:controller.signal });
    }), aborted])); }
    catch (error) { entry.reject(error); }
    finally {
      // Sequential attempts share execution time, excluding time in the queue.
      if (executionBudget) executionBudget.remainingMs = Math.max(0, duration - (performance.now() - budgetStartedAt));
      clearTimeout(timer); entry.signal?.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', rejectAbort);
      active.delete(entry);
      entry.releaseResource?.();
      if (!entry.groupKey) served.delete(entry);
      if (!pending.length && !active.size) served.clear();
      queueMicrotask(drain); notifyIdle();
    }
  }
  function drain() {
    if (closed) { notifyIdle(); return; }
    while (active.size < concurrency) {
      const entry = select(); if (!entry) break;
      void execute(entry);
    }
    notifyIdle();
  }
  return {
    run(work, { priority = 'interactive', getPriority, groupKey, signal, wait = true, timeoutMs: executionTimeout, executionBudget, canStart, acquire } = {}) {
      if (closed) return Promise.reject(stopped());
      if (signal?.aborted) return Promise.reject(abortError(signal));
      if (!wait && (active.size || pending.length))
        return Promise.reject(failure('AI_BUSY', 'AI 正在处理请求，请完成后重试。'));
      return new Promise((resolve, reject) => {
        const entry = { work, resolve, reject, signal, priority, getPriority, groupKey, timeoutMs:executionTimeout, executionBudget, exclusive:!wait,canStart,acquire };
        entry.onAbort = () => {
          const index = pending.indexOf(entry); if (index < 0) return;
          pending.splice(index,1); reject(abortError(signal)); queueMicrotask(drain); notifyIdle();
        };
        signal?.addEventListener('abort', entry.onAbort, {once:true});
        pending.push(entry); queueMicrotask(drain);
      });
    },
    status: () => ({ active:active.size > 0, activeCount:active.size, waiting:pending.length, concurrency }),
    refresh: () => queueMicrotask(drain),
    whenIdle: () => active.size || pending.length ? new Promise(resolve => idle.add(resolve)) : Promise.resolve(),
    close() {
      closed = true;
      for (const entry of pending.splice(0)) {
        entry.signal?.removeEventListener('abort',entry.onAbort); entry.reject(stopped());
      }
      notifyIdle();
    },
  };
}
