// Promise.race is also needed for transports which ignore AbortSignal. Their
// eventual result is observed, but can no longer publish output or hold a slot.
export async function raceWithSignal(work, signal) {
  signal?.throwIfAborted();
  if (!signal) return work();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new DOMException('请求已取消。','AbortError'));
    signal.addEventListener('abort', onAbort, {once:true});
  });
  try { return await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return work(); }), aborted]); }
  finally { signal.removeEventListener('abort', onAbort); }
}
